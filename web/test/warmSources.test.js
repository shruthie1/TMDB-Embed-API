import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WARM_DELAY_MS, REWARM_MS, warmAllowed, warmCandidates, parsePlaylist, pickVariant,
  segmentIndexAt, warmSource, createWarmScheduler,
} from '../lib/player/warmSources';

const P = 'https://api.example/m3u8-proxy?url=';
const row = (id, langs, quality = '720p', extra = {}) => ({
  id, provider: id.split('-')[0], quality, languages: langs, masterUrl: `${P}${id}/master.m3u8`, ...extra,
});
// List order puts Hindi first, as the server sort can.
const SOURCES = [
  row('Cur-0', ['Telugu']),
  row('Hin-1', ['Hindi']),
  row('Tel-2', ['Telugu']),
  row('Unk-3', []),
  row('Tel-4', ['Telugu'], '480p'),
  row('Prog-5', ['Telugu'], '720p', { progressive: true }),
];

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
  'v480.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
  'v720.m3u8',
].join('\n');
const MEDIA = [
  '#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:10,', 'seg0.m4s', '#EXTINF:10,', 'seg1.m4s', '#EXTINF:10,', 'seg2.m4s',
  '#EXTINF:10,', 'seg3.m4s', '#EXT-X-ENDLIST',
].join('\n');

function fakeFetch(map = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const body = Object.entries(map).find(([k]) => url.endsWith(k))?.[1] ?? '';
    return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => new ArrayBuffer(4) };
  });
  fn.calls = calls;
  return fn;
}

describe('warmCandidates', () => {
  it('takes at most 3, same language first, never the current, a dead or a progressive row', () => {
    const picks = warmCandidates(SOURCES, { currentId: 'Cur-0', dead: new Set(['Tel-2']), lang: 'Telugu', height: 720, max: 3 });
    expect(picks.map((s) => s.id)).toEqual(['Tel-4', 'Unk-3', 'Hin-1']);
  });

  it('keeps Telugu first when no language is known yet', () => {
    const picks = warmCandidates(SOURCES, { currentId: 'Cur-0', max: 2 });
    expect(picks.map((s) => s.id)).toEqual(['Tel-2', 'Tel-4']);
  });

  it('never goes past 3 whatever max says', () => {
    const many = Array.from({ length: 8 }, (_, i) => row(`Tel-${i}`, ['Telugu']));
    expect(warmCandidates(many, { max: 10 })).toHaveLength(3);
  });
});

describe('warmAllowed', () => {
  it('skips saveData and 2G, allows the rest and an unknown connection', () => {
    expect(warmAllowed({ saveData: true, effectiveType: '4g' })).toBe(false);
    expect(warmAllowed({ effectiveType: '2g' })).toBe(false);
    expect(warmAllowed({ effectiveType: 'slow-2g' })).toBe(false);
    expect(warmAllowed({ effectiveType: '4g' })).toBe(true);
    expect(warmAllowed(undefined)).toBe(true);
  });
});

describe('playlist helpers', () => {
  it('parses variants and segments against the playlist url', () => {
    const m = parsePlaylist(MASTER, 'https://p.example/a/master.m3u8');
    expect(m.variants.map((v) => [v.height, v.url])).toEqual([
      [480, 'https://p.example/a/v480.m3u8'], [720, 'https://p.example/a/v720.m3u8']]);
    const s = parsePlaylist(MEDIA, 'https://p.example/a/v720.m3u8');
    expect(s.init).toBe('https://p.example/a/init.mp4');
    expect(s.segments).toHaveLength(4);
  });

  it('picks the variant nearest the playing height', () => {
    const { variants } = parsePlaylist(MASTER, 'https://p/x');
    expect(pickVariant(variants, 720).height).toBe(720);
    expect(pickVariant(variants, null).height).toBe(480);
  });

  it('finds the segment at the playback position', () => {
    const { segments } = parsePlaylist(MEDIA, 'https://p/x');
    expect(segmentIndexAt(segments, 0)).toBe(0);
    expect(segmentIndexAt(segments, 25)).toBe(2);
    expect(segmentIndexAt(segments, 999)).toBe(3);
  });
});

describe('warmSource', () => {
  it('fetches master, one media playlist, init and 2 segments at the position, through the given urls', async () => {
    const f = fakeFetch({ 'master.m3u8': MASTER, 'v720.m3u8': MEDIA });
    const src = { id: 'A', masterUrl: 'https://p.example/a/master.m3u8' };
    const urls = await warmSource(src, { at: 12, height: 720, fetchImpl: f });
    expect(urls).toEqual([
      'https://p.example/a/master.m3u8', 'https://p.example/a/v720.m3u8',
      'https://p.example/a/init.mp4', 'https://p.example/a/seg1.m4s', 'https://p.example/a/seg2.m4s',
    ]);
    expect(f.calls[0].init.priority).toBe('low');
  });

  it('does not fetch segments of a byte-range playlist', async () => {
    const f = fakeFetch({ 'm.m3u8': '#EXTM3U\n#EXTINF:10,\n#EXT-X-BYTERANGE:100@0\nfile.ts\n' });
    const urls = await warmSource({ masterUrl: 'https://p/m.m3u8' }, { fetchImpl: f });
    expect(urls).toEqual(['https://p/m.m3u8']);
  });
});

describe('createWarmScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const state = (over = {}) => ({
    sources: SOURCES, currentId: 'Cur-0', dead: new Set(), lang: 'Telugu', height: 720, at: 0, stable: true, ...over,
  });
  const masters = (f) => f.calls.filter((c) => c.url.endsWith('master.m3u8')).map((c) => c.url);

  it('waits the full 10s before the first request', async () => {
    const f = fakeFetch();
    const w = createWarmScheduler({ getState: () => state(), fetchImpl: f, max: 2 });
    w.start();
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS - 1);
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(masters(f)).toEqual([`${P}Tel-2/master.m3u8`, `${P}Tel-4/master.m3u8`]);
    w.stop();
  });

  it('caps a round at 2-3 sources', async () => {
    const f = fakeFetch();
    const w = createWarmScheduler({ getState: () => state(), fetchImpl: f, max: 5 });
    w.start();
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS);
    expect(masters(f)).toHaveLength(3);
    w.stop();
  });

  it('stop() before the delay sends nothing; stop() mid-round aborts the rest', async () => {
    const f = fakeFetch();
    const w = createWarmScheduler({ getState: () => state(), fetchImpl: f });
    w.start();
    await vi.advanceTimersByTimeAsync(5000);
    w.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f).not.toHaveBeenCalled();

    // Mid-round: the first fetch hangs until aborted.
    let aborted = false;
    const slow = vi.fn((url, init) => new Promise((_, rej) => {
      init.signal.addEventListener('abort', () => { aborted = true; rej(new DOMException('a', 'AbortError')); });
    }));
    const w2 = createWarmScheduler({ getState: () => state(), fetchImpl: slow });
    w2.start();
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS);
    expect(slow).toHaveBeenCalledTimes(1);
    w2.stop();
    await vi.advanceTimersByTimeAsync(REWARM_MS * 2);
    expect(aborted).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(w2.isArmed()).toBe(false);
  });

  it('an unstable moment (paused, buffering, switching) pushes the round back', async () => {
    const f = fakeFetch();
    let stable = false;
    const w = createWarmScheduler({ getState: () => state({ stable }), fetchImpl: f });
    w.start();
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS);
    expect(f).not.toHaveBeenCalled();
    stable = true;
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS);
    expect(f).toHaveBeenCalled();
    w.stop();
  });

  it('does nothing on a saveData / 2G link', async () => {
    const f = fakeFetch();
    const w = createWarmScheduler({ getState: () => state(), fetchImpl: f, allowed: () => false });
    w.start();
    await vi.advanceTimersByTimeAsync(REWARM_MS);
    expect(f).not.toHaveBeenCalled();
  });

  it('re-warms at the new position after REWARM_MS', async () => {
    const f = fakeFetch();
    const w = createWarmScheduler({ getState: () => state(), fetchImpl: f, max: 2 });
    w.start();
    await vi.advanceTimersByTimeAsync(WARM_DELAY_MS);
    expect(masters(f)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(REWARM_MS);
    expect(masters(f)).toHaveLength(4);
    w.stop();
  });
});
