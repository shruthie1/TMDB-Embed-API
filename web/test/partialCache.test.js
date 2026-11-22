import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLive, STREAMS_RETRY_DELAYS_MS } from '../lib/backend';
import { getSlot, titleKey, _resetStreamCache, PARTIAL_CACHE_TTL_MS } from '../lib/streamCache';

// Parity with the APK fix (2026-11-22): a partial answer (`partial`, a
// provider error, an incomplete row) is KEPT for 5 min, so a second Play
// starts at once. A complete answer replaces it; a partial never replaces a
// complete one.

const body = (streams, extra = {}) => ({ success: true, count: streams.length, providerTimings: {}, streams, ...extra });
const CASTLE = { url: 'https://cdn/castle.m3u8', provider: 'CastleTV', quality: '1080p', container: 'hls', languages: ['Telugu'] };
const NM = { url: 'https://cdn/nm.m3u8', provider: 'NetMirror', quality: '1080p', container: 'hls', languages: ['Telugu'] };
const res = (json) => ({ ok: true, status: 200, json: async () => json });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const streamCalls = (f) => f.mock.calls.filter(([u]) => String(u).includes('/api/streams')).length;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
function run(id, extra = {}) {
  return new Promise((resolve) => {
    resolveLive('movie', id, { ...extra, onDone: (s) => resolve({ ok: s }), onFail: (e) => resolve({ err: e }) });
  });
}

let logs;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  _resetStreamCache();
  STREAMS_RETRY_DELAYS_MS.splice(0, STREAMS_RETRY_DELAYS_MS.length, 1, 1);
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('partial answers are kept 5 min (APK parity)', () => {
  it('a partial answer is kept: the second Play makes 0 stream requests', async () => {
    const f = vi.fn(async () => res(body([CASTLE], { partial: true })));
    vi.stubGlobal('fetch', f);
    await run(901);
    const again = await run(901);
    expect(again.ok?.masterUrl).toBe(CASTLE.url);
    expect(streamCalls(f)).toBe(1);
    expect(logs).toContain('[cache] hit movie:901:0:0#vm');
    expect(logs.some((l) => l.startsWith('[cache] put movie:901:0:0#vm partial ttl=300s'))).toBe(true);
  });

  it('an answer with a provider error or an incomplete row is kept too', async () => {
    const f = vi.fn(async (u) => (String(u).includes('/902')
      ? res(body([CASTLE], { providerErrors: ['netmirror'] }))
      : res(body([CASTLE, { ...NM, incomplete: true }]))));
    vi.stubGlobal('fetch', f);
    await run(902);
    await run(903);
    expect(getSlot(titleKey('movie', 902), 'vm')?.streams?.length).toBe(1);
    expect(getSlot(titleKey('movie', 903), 'vm')?.streams?.length).toBe(2);
  });

  it('a kept partial answer ends at 5 min', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(5_000_000);
    const f = vi.fn(async () => res(body([CASTLE], { partial: true })));
    vi.stubGlobal('fetch', f);
    await run(904);
    now.mockReturnValue(5_000_000 + PARTIAL_CACHE_TTL_MS - 1000);
    await run(904);
    expect(streamCalls(f)).toBe(1);
    now.mockReturnValue(5_000_000 + PARTIAL_CACHE_TTL_MS + 1000);
    await run(904);
    expect(streamCalls(f)).toBe(2);
  });

  it('the complete follow-up replaces the kept partial (30 min)', async () => {
    const f = vi.fn(async (u) => (String(u).includes('full=1')
      ? res(body([CASTLE, NM]))
      : res(body([CASTLE], { partial: true }))));
    vi.stubGlobal('fetch', f);
    await new Promise((r) => run(905, { onMore: r }));
    const kept = getSlot(titleKey('movie', 905), 'vm');
    expect(kept.partial).toBeFalsy();
    expect(kept.streams.length).toBe(2);
  });

  it('a kept partial replay still asks full=1 in the background, never blocking the start', async () => {
    let n = 0;
    const f = vi.fn(async (u) => {
      n += 1;
      if (String(u).includes('full=1')) { await tick(50); return res(body([CASTLE, NM])); }
      return res(body([CASTLE], { partial: true }));
    });
    vi.stubGlobal('fetch', f);
    await run(906);
    await tick(80);
    _resetStreamCache({ clearStorage: false });
    // Fresh memory, kept partial in storage. Start must not wait for full=1.
    const onMore = vi.fn();
    const t0 = Date.now();
    const out = await run(906, { onMore });
    expect(Date.now() - t0).toBeLessThan(40);
    expect(out.ok?.masterUrl).toBe(CASTLE.url);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('a partial answer never replaces a kept complete one', async () => {
    const f = vi.fn(async () => res(body([CASTLE, NM])));
    vi.stubGlobal('fetch', f);
    await run(907);
    // A late partial (a superseded follow-up) lands after the complete one.
    const { keepStreamsAnswer } = await import('../lib/backend');
    keepStreamsAnswer('movie', 907, body([CASTLE], { providerErrors: ['netmirror'] }));
    expect(getSlot(titleKey('movie', 907), 'vm')?.streams?.length).toBe(2);
  });

  it('an empty answer is still not kept', async () => {
    const f = vi.fn(async () => res(body([], { partial: true })));
    vi.stubGlobal('fetch', f);
    await run(908);
    expect(getSlot(titleKey('movie', 908), 'vm')).toBeNull();
  });
});
