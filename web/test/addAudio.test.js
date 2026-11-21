import { describe, it, expect, vi, afterEach } from 'vitest';
import { addAudioOffers, pairDonors, tryDonors, createAddAudioRun } from '../lib/player/addAudio';
import { ADD_AUDIO_MAX_TRIES, ADD_AUDIO_TOTAL_MS } from '../lib/player/loadingModel';

const row = (id, languages, extra = {}) => ({
  id, provider: extra.provider ?? id, languages, selectableAudio: true,
  masterUrl: `https://fixture/${id}.m3u8`, ...extra,
});
const ids = list => list.map(s => s.id);

describe('addAudioOffers', () => {
  it('skips a language the playing stream already carries (te and Telugu are one key)', () => {
    const playing = row('P', ['Telugu', 'Hindi']);
    const donor = row('D', ['Telugu', 'Hindi', 'Tamil']);
    const offers = addAudioOffers([playing, donor], playing, [{ lang: 'te' }, { lang: 'hi' }]);
    expect(offers.map(o => o.language)).toEqual(['Tamil']);
  });

  it('falls back to the playing row when no track has a known language', () => {
    const playing = row('P', ['Telugu']);
    const donor = row('D', ['Telugu', 'Hindi']);
    expect(addAudioOffers([playing, donor], playing, [{ name: 'Track 1' }]).map(o => o.language)).toEqual(['Hindi']);
  });

  it('uses the playing row languages when there are no audio tracks', () => {
    const playing = row('P', ['Telugu']);
    const donor = row('D', ['Telugu', 'Hindi']);
    expect(addAudioOffers([playing, donor], playing, []).map(o => o.language)).toEqual(['Hindi']);
  });

  it('offers nothing when only the playing provider lists the language', () => {
    const playing = row('P1', ['Hindi'], { provider: 'Prov' });
    const sibling = row('P2', ['Hindi', 'Telugu'], { provider: 'Prov' });
    expect(addAudioOffers([playing, sibling], playing, [{ lang: 'hi' }])).toEqual([]);
  });

  it('lists every missing language, Telugu first, the rest in index order', () => {
    const playing = row('P', ['English']);
    const a = row('A', ['Hindi', 'Tamil']);
    const b = row('B', ['Kannada', 'Telugu', 'Malayalam']);
    const offers = addAudioOffers([playing, a, b], playing, [{ lang: 'en' }]);
    expect(offers.map(o => o.language)).toEqual(['Telugu', 'Hindi', 'Tamil', 'Kannada', 'Malayalam']);
    expect(ids(offers[0].donors)).toEqual(['B']);
  });

  it('a fixed-audio row makes no offer', () => {
    const playing = row('P', ['English']);
    const fixed = row('F', ['Telugu'], { selectableAudio: false });
    expect(addAudioOffers([playing, fixed], playing, [{ lang: 'en' }])).toEqual([]);
  });
});

describe('pairDonors', () => {
  it('puts a row with a Telugu uri rendition before a languages-only row', () => {
    const playing = row('P', ['Hindi']);
    const plain = row('Plain', ['Telugu']);
    const withUri = row('Uri', ['Telugu'], { audio: [{ language: 'te', name: 'Telugu', uri: 'https://x/te.m3u8' }] });
    expect(ids(pairDonors([playing, plain, withUri], 'Telugu', playing))).toEqual(['Uri', 'Plain']);
  });

  it('caps at 3 from 5 rows', () => {
    const playing = row('P', ['Hindi']);
    const rows = ['A', 'B', 'C', 'D', 'E'].map(id => row(id, ['Telugu']));
    const donors = pairDonors([playing, ...rows], 'te', playing);
    expect(donors).toHaveLength(ADD_AUDIO_MAX_TRIES);
    expect(ids(donors)).toEqual(['A', 'B', 'C']);
  });

  it('excludes playing, same provider, unsupported, hybrid, fixed-audio and failed rows', () => {
    const playing = row('P', ['Hindi', 'Telugu'], { provider: 'Prov' });
    const rows = [
      playing,
      row('Same', ['Telugu'], { provider: 'Prov' }),
      row('Unsup', ['Telugu'], { unsupported: true }),
      row('Hyb', ['Telugu'], { hybrid: true }),
      row('Fixed', ['Telugu'], { selectableAudio: false }),
      row('Failed', ['Telugu']),
      row('Ok', ['Telugu']),
    ];
    expect(ids(pairDonors(rows, 'Telugu', playing, new Set(['Failed'])))).toEqual(['Ok']);
  });
});

describe('createAddAudioRun', () => {
  it('a run that spent 2 donors and 20 s has 1 donor and 10 s left', () => {
    const donors = ['A', 'B', 'C', 'D'].map(id => row(id, ['Telugu']));
    const run = createAddAudioRun({ language: 'Telugu', donors, startedAt: 1000 });
    run.record(donors[0]);
    run.record(donors[1]);
    const next = run.next(21000);
    expect(ids(next.donors)).toEqual(['C']);
    expect(next.totalMs).toBe(10000);
    expect(next.first).toBe(3);
    expect(next.total).toBe(3);
    expect(ids(run.tried)).toEqual(['A', 'B']);
  });

  it('returns null when the budget or the donors are spent', () => {
    const donors = ['A', 'B', 'C'].map(id => row(id, ['Telugu']));
    const run = createAddAudioRun({ language: 'Telugu', donors, startedAt: 0 });
    expect(run.next(ADD_AUDIO_TOTAL_MS)).toBeNull();
    donors.forEach(d => run.record(d));
    expect(run.next(1)).toBeNull();
  });
});

describe('tryDonors', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the first non-null result and reports (donor, n, total)', async () => {
    const donors = ['A', 'B', 'C'].map(id => row(id, ['Telugu']));
    const results = [null, null, { url: 'ok' }];
    const onTry = vi.fn();
    const out = await tryDonors({ donors, tryOne: async (d, signal) => { expect(signal).toBeInstanceOf(AbortSignal); return results[donors.indexOf(d)]; }, onTry });
    expect(out).toEqual({ donor: donors[2], result: { url: 'ok' }, tried: donors });
    expect(onTry.mock.calls.map(c => [c[0].id, c[1], c[2]])).toEqual([['A', 1, 3], ['B', 2, 3], ['C', 3, 3]]);
  });

  it('a thrown try counts as a failed donor', async () => {
    const donors = ['A', 'B'].map(id => row(id, ['Telugu']));
    const out = await tryDonors({ donors, tryOne: async d => { if (d.id === 'A') throw new Error('409'); return 'ok'; } });
    expect(out).toMatchObject({ donor: donors[1], result: 'ok' });
  });

  it('aborts a never-resolving try and returns {failed} after 30 000 ms total', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const donors = ['A', 'B', 'C'].map(id => row(id, ['Telugu']));
    const aborts = [];
    const tryOne = (d, signal) => new Promise(() => { signal.addEventListener('abort', () => aborts.push([d.id, Date.now()])); });
    let settled = null;
    tryDonors({ donors, tryOne, now: () => Date.now() }).then(v => { settled = v; });
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(aborts).toEqual([['A', 15000], ['B', 30000]]);
    expect(ids(settled.failed)).toEqual(['A', 'B']);
  });

  it('continues the n of total count from a run', async () => {
    const donors = ['C'].map(id => row(id, ['Telugu']));
    const onTry = vi.fn();
    await tryDonors({ donors, tryOne: async () => null, onTry, first: 3, total: 3 });
    expect(onTry.mock.calls[0].slice(1)).toEqual([3, 3]);
  });

  it('a cancel stops the run at once and a late success is never returned', async () => {
    const donors = ['A', 'B'].map(id => row(id, ['Telugu']));
    const outer = new AbortController();
    let inner, release;
    const tryOne = (d, signal) => { inner = signal; return new Promise(r => { release = r; }); };
    const pending = tryDonors({ donors, tryOne, signal: outer.signal });
    await Promise.resolve(); await Promise.resolve();
    outer.abort();
    release('late ok');
    const out = await pending;
    expect(out.cancelled).toBe(true);
    expect(out.result).toBeUndefined();
    expect(inner.aborted).toBe(true);
    expect(ids(out.tried)).toEqual(['A']);
  });

  it('a late success after a per-try abort is ignored', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const donors = ['A'].map(id => row(id, ['Telugu']));
    const tryOne = () => new Promise(r => setTimeout(() => r('late'), 20000));
    let settled = null;
    tryDonors({ donors, tryOne, now: () => Date.now() }).then(v => { settled = v; });
    await vi.advanceTimersByTimeAsync(15000);
    expect(ids(settled.failed)).toEqual(['A']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled.donor).toBeUndefined();
  });
});

describe('run.attempt', () => {
  it('A and B fail, C wins then fails on the device: next attempt is spent, no repeats, 3 tries max', async () => {
    const donors = ['A', 'B', 'C', 'D'].map(id => row(id, ['Telugu']));
    const run = createAddAudioRun({ language: 'Telugu', donors, startedAt: Date.now() });
    const calls = [];
    const tryOne = async d => { calls.push(d.id); return d.id === 'C' ? 'ok' : null; };
    const first = await run.attempt({ tryOne });
    expect(first.donor.id).toBe('C');
    const second = await run.attempt({ tryOne });
    expect(ids(second.failed)).toEqual(['A', 'B', 'C']);
    expect(run.next()).toBeNull();
    expect(calls).toEqual(['A', 'B', 'C']);
  });

  it('a device failure after the first donor continues with the rest, n of total keeps counting', async () => {
    const donors = ['A', 'B', 'C'].map(id => row(id, ['Telugu']));
    const run = createAddAudioRun({ language: 'Telugu', donors, startedAt: Date.now() });
    const onTry = vi.fn();
    expect((await run.attempt({ tryOne: async () => 'ok', onTry })).donor.id).toBe('A');
    expect((await run.attempt({ tryOne: async d => (d.id === 'C' ? 'ok' : null), onTry })).donor.id).toBe('C');
    expect(onTry.mock.calls.map(c => [c[0].id, c[1], c[2]])).toEqual([['A', 1, 3], ['B', 2, 3], ['C', 3, 3]]);
    expect(ids(run.tried)).toEqual(['A', 'B', 'C']);
  });

  it('a cancelled attempt returns {cancelled:true} and records the donor it started', async () => {
    const donors = ['A', 'B'].map(id => row(id, ['Telugu']));
    const run = createAddAudioRun({ language: 'Telugu', donors, startedAt: Date.now() });
    const outer = new AbortController();
    const pending = run.attempt({ tryOne: () => new Promise(() => {}), signal: outer.signal });
    await Promise.resolve(); await Promise.resolve();
    outer.abort();
    expect(await pending).toEqual({ cancelled: true });
    expect(ids(run.tried)).toEqual(['A']);
  });

  it('two concurrent attempts make at most 3 tries, no donor twice (I2)', async () => {
    const donors = ['A', 'B', 'C', 'D'].map(id => row(id, ['Telugu']));
    const run = createAddAudioRun({ language: 'Telugu', donors, startedAt: Date.now() });
    const calls = [];
    const tryOne = async d => { calls.push(d.id); await Promise.resolve(); return null; };
    const [one, two] = await Promise.all([run.attempt({ tryOne }), run.attempt({ tryOne })]);
    expect(calls).toEqual(['A', 'B', 'C']);
    expect(ids(one.failed)).toEqual(['A', 'B', 'C']);
    expect(two).toBe(one);
    const third = await run.attempt({ tryOne });
    expect(ids(third.failed)).toEqual(['A', 'B', 'C']);
    expect(calls).toHaveLength(3);
  });

  it('a settled try leaves no abort listener on the caller signal', async () => {
    const outer = new AbortController();
    const add = vi.spyOn(outer.signal, 'addEventListener');
    const remove = vi.spyOn(outer.signal, 'removeEventListener');
    const donors = ['A', 'B'].map(id => row(id, ['Telugu']));
    await tryDonors({ donors, tryOne: async () => null, signal: outer.signal });
    const added = add.mock.calls.filter(c => c[0] === 'abort').map(c => c[1]);
    const removed = remove.mock.calls.filter(c => c[0] === 'abort').map(c => c[1]);
    expect(added).toHaveLength(4);
    expect(removed).toEqual(expect.arrayContaining(added));
  });
});
