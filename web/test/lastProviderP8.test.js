import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLastProvider, rememberProvider, forgetProvider, playedTimer, LAST_PROVIDER_MAX } from '../lib/lastProvider';
import { applyLastProvider, resolveLive, STREAMS_RETRY_DELAYS_MS } from '../lib/backend';
import { _resetStreamCache } from '../lib/streamCache';

// P8 (2026-11-22): remember the provider that played >= 10 s, per title, and
// start the next Play on it, never at the cost of the chosen language.

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
const row = (provider, languages, extra = {}) => ({ provider, languages, masterUrl: `https://cdn/${provider}-${languages.join('')}.m3u8`, ...extra });

let logs;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
  _resetStreamCache();
  STREAMS_RETRY_DELAYS_MS.splice(0, STREAMS_RETRY_DELAYS_MS.length, 1, 1);
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('remembered provider store', () => {
  it('keeps at least 200 titles', () => {
    for (let i = 0; i < 250; i++) rememberProvider('movie', 5000 + i, `p${i}`, 0, 0, i);
    for (let i = 0; i < 250; i++) expect(getLastProvider('movie', 5000 + i)).toBe(`p${i}`);
  });

  it(`caps at ${LAST_PROVIDER_MAX}; the oldest write goes first`, () => {
    for (let i = 0; i <= LAST_PROVIDER_MAX; i++) rememberProvider('movie', 9000 + i, 'CastleTV', 0, 0, i);
    expect(getLastProvider('movie', 9000)).toBeNull();
    expect(getLastProvider('movie', 9001)).toBe('CastleTV');
  });

  it('still reads the v1 key layout', () => {
    localStorage.setItem('chitram:last-provider:v1:movie:77:0:0', 'NetMirror');
    expect(getLastProvider('movie', 77)).toBe('NetMirror');
  });

  it('logs saved and failed', () => {
    rememberProvider('movie', 78, 'CastleTV');
    forgetProvider('movie', 78, 'CastleTV');
    expect(logs).toContain('[last] movie:78:0:0 provider=CastleTV saved');
    expect(logs).toContain('[last] movie:78:0:0 provider=CastleTV failed');
  });
});

describe('played >= 10 s', () => {
  it('fires once after 10 s of real play', () => {
    const t = playedTimer();
    let fired = 0;
    for (let s = 0; s <= 12; s += 0.25) if (t(s)) fired++;
    expect(fired).toBe(1);
  });

  it('a seek does not count as play time', () => {
    const t = playedTimer();
    expect(t(0)).toBe(false);
    expect(t(1)).toBe(false);
    expect(t(600)).toBe(false);   // seek to 10:00
    for (let s = 600.25; s < 608; s += 0.25) expect(t(s)).toBe(false);
  });
});

describe('start on the remembered provider (language wins)', () => {
  it('moves the remembered provider first inside the chosen language', () => {
    const list = [row('CastleTV', ['Telugu']), row('OneTouchTV', ['Telugu'])];
    const out = applyLastProvider(list, 'onetouchtv', 'movie:1:0:0');
    expect(out.map((s) => s.provider)).toEqual(['OneTouchTV', 'CastleTV']);
    expect(logs).toContain('[last] movie:1:0:0 provider=onetouchtv hit');
  });

  it('never lifts a row in another language over the chosen one', () => {
    const list = [row('CastleTV', ['Telugu']), row('NetMirror', ['Hindi'])];
    const out = applyLastProvider(list, 'NetMirror', 'movie:2:0:0');
    expect(out.map((s) => s.provider)).toEqual(['CastleTV', 'NetMirror']);
    expect(logs).toContain('[last] movie:2:0:0 provider=NetMirror miss reason=not-in-chosen-language');
  });

  it('never lifts a row without the audio menu over one that has it', () => {
    const list = [row('CastleTV', ['Telugu'], { selectableAudio: true }), row('NetMirror', ['Telugu'])];
    expect(applyLastProvider(list, 'NetMirror').map((s) => s.provider)).toEqual(['CastleTV', 'NetMirror']);
  });

  it('a provider not in the answer leaves the normal order', () => {
    const list = [row('CastleTV', ['Telugu']), row('OneTouchTV', ['Telugu'])];
    expect(applyLastProvider(list, 'vidrift', 'k')).toBe(list);
    expect(logs).toContain('[last] k provider=vidrift miss reason=not-in-list');
  });

  it('resolveLive starts on the remembered provider', async () => {
    const answer = { success: true, providerTimings: {}, streams: [
      { url: 'https://cdn/c.m3u8', provider: 'CastleTV', container: 'hls', languages: ['Telugu'] },
      { url: 'https://cdn/o.m3u8', provider: 'OneTouchTV', container: 'hls', languages: ['Telugu'] },
    ] };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => answer })));
    const done = await new Promise((r) => resolveLive('movie', 90, { provider: 'OneTouchTV', onDone: r, onFail: r }));
    expect(done.provider).toBe('OneTouchTV');
  });

  // APK parity 2026-11-22: the remembered provider never delays the start.
  it('a remembered provider missing from a partial answer: start at once on the ready Telugu row', async () => {
    const answer = { success: true, partial: true, providerTimings: {}, streams: [
      { url: 'https://cdn/c.m3u8', provider: 'CastleTV', container: 'hls', languages: ['Telugu'] },
    ] };
    let full = null;
    const f = vi.fn((u) => (String(u).includes('full=1')
      ? new Promise((r) => { full = r; }) // NetMirror still running: never answers in this test
      : Promise.resolve({ ok: true, status: 200, json: async () => answer })));
    vi.stubGlobal('fetch', f);
    const done = await new Promise((r) => resolveLive('movie', 91, { provider: 'NetMirror', onDone: r, onFail: r, onMore: () => {} }));
    expect(done.provider).toBe('CastleTV');
    expect(full).not.toBeNull(); // the follow-up runs in the background, after the start
    expect(logs).toContain('[last] movie:91:0:0 provider=NetMirror miss reason=not-in-list');
  });
});
