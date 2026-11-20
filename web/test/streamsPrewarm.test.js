import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLive, prewarmStreams, STREAMS_RETRY_DELAYS_MS } from '../lib/backend';

// The title page warms /api/streams while the viewer reads; Play joins that
// request. A partial answer (backend PRIMARY_PROVIDERS) is followed by one
// ?full=1 ask whose rows are merged without touching what is playing.

const body = (streams, extra = {}) => ({ success: true, count: streams.length, providerTimings: {}, streams, ...extra });
const CASTLE = { url: 'https://cdn/castle.m3u8', provider: 'CastleTV', quality: '1080p', container: 'hls', languages: ['Telugu'] };
const MAPPLE = { url: 'https://cdn/mapple.m3u8', provider: 'Mapple', quality: '2160p', container: 'hls', languages: ['English'] };
const res = (json) => ({ ok: true, status: 200, json: async () => json });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

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

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
  STREAMS_RETRY_DELAYS_MS.splice(0, STREAMS_RETRY_DELAYS_MS.length, 1, 1);
});
afterEach(() => vi.unstubAllGlobals());

describe('title-page prewarm', () => {
  it('Play joins a prewarm that is still running: one request, not two', async () => {
    let release;
    const fetchMock = vi.fn(() => new Promise((r) => { release = () => r(res(body([CASTLE]))); }));
    vi.stubGlobal('fetch', fetchMock);
    prewarmStreams('movie', 501);
    const play = run(501);
    await tick();
    release();
    const out = await play;
    expect(out.ok?.masterUrl).toBe(CASTLE.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Play after a finished prewarm is served from the session cache', async () => {
    const fetchMock = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', fetchMock);
    prewarmStreams('movie', 502);
    await tick(5);
    const out = await run(502);
    expect(out.ok?.masterUrl).toBe(CASTLE.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a second prewarm for a cached title does not ask again', async () => {
    const fetchMock = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', fetchMock);
    prewarmStreams('movie', 503);
    await tick(5);
    prewarmStreams('movie', 503);
    await tick(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a refresh never joins a running prewarm', async () => {
    const fetchMock = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', fetchMock);
    prewarmStreams('movie', 504);
    await run(504, { refresh: true });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('refresh=1'))).toBe(true);
  });

  it('a failed prewarm does not stop Play from trying again', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
      .mockResolvedValue(res(body([CASTLE])));
    vi.stubGlobal('fetch', fetchMock);
    prewarmStreams('movie', 505);
    await tick(5);
    const out = await run(505);
    expect(out.ok?.masterUrl).toBe(CASTLE.url);
  });
});

describe('partial answer follow-up', () => {
  it('asks once with full=1 and hands the complete list to onMore', async () => {
    const fetchMock = vi.fn(async (u) => (String(u).includes('full=1')
      ? res(body([CASTLE, MAPPLE]))
      : res(body([CASTLE], { partial: true }))));
    vi.stubGlobal('fetch', fetchMock);
    const more = new Promise((r) => run(601, { onMore: r }));
    const list = await more;
    expect(list.map((s) => s.provider).sort()).toEqual(['CastleTV', 'Mapple']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('full=1');
    // The complete answer is now cached; a replay costs no request.
    await run(601);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a complete answer is not followed up', async () => {
    const fetchMock = vi.fn(async () => res(body([CASTLE])));
    vi.stubGlobal('fetch', fetchMock);
    const onMore = vi.fn();
    await run(602, { onMore });
    await tick(5);
    expect(onMore).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
