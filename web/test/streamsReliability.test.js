import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _resetStreamCache } from '../lib/streamCache';
import { resolveLive, STREAMS_RETRY_DELAYS_MS } from '../lib/backend';
import { fatalAction } from '../lib/player/fatalPolicy';

// /api/streams is one request behind a Vercel rewrite to the VM. A single
// 502 during a VM restart, or a dropped mobile connection, used to end in
// "No playable source" with no second try. And every replay of a title
// re-ran the whole provider fan-out because the request is no-store.

const body = (streams, extra = {}) => ({ success: true, count: streams.length, providerTimings: {}, streams, ...extra });
const STREAM = { url: 'https://cdn/x.m3u8', provider: 'CastleTV', quality: '720p', container: 'hls', languages: ['Telugu'] };
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
function run(opts = {}) {
  return new Promise((resolve) => {
    resolveLive('movie', opts.id ?? 1, { refresh: opts.refresh, onDone: (s) => resolve({ ok: s }), onFail: (e) => resolve({ err: e }) });
  });
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  _resetStreamCache();
  // No real waiting between retries in tests.
  STREAMS_RETRY_DELAYS_MS.splice(0, STREAMS_RETRY_DELAYS_MS.length, 1, 1);
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/streams retries', () => {
  it('retries a 502 and succeeds on the next attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(502, {}))
      .mockResolvedValueOnce(res(200, body([STREAM])));
    vi.stubGlobal('fetch', fetchMock);
    const out = await run({ id: 11 });
    expect(out.ok?.masterUrl).toBe(STREAM.url);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network error, then gives up after the last attempt', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const out = await run({ id: 12 });
    expect(out.err).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1 + STREAMS_RETRY_DELAYS_MS.length);
  });

  it('does not retry a 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(400, {}));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 13 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('per-title session cache', () => {
  it('a replay of the same title is served from the client stream cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, body([STREAM])));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 21 });
    const again = await run({ id: 21 });
    expect(again.ok?.masterUrl).toBe(STREAM.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refresh bypasses the cache (a stale signed url must be re-resolved)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, body([STREAM])));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 22 });
    await run({ id: 22, refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a partial early answer is not cached, so the next ask gets the full list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, body([STREAM], { partial: true })));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 23 });
    await run({ id: 23 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an answer with a provider error is not cached, so the next ask retries that provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, body([STREAM], { providerErrors: ['onetouchtv'] })));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 25 });
    await run({ id: 25 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an empty providerErrors list is still cached', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, body([STREAM], { providerErrors: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 26 });
    await run({ id: 26 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an expired entry is ignored', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const fetchMock = vi.fn().mockResolvedValue(res(200, body([STREAM])));
    vi.stubGlobal('fetch', fetchMock);
    await run({ id: 24 });
    now.mockReturnValue(1_000_000 + 31 * 60 * 1000);
    await run({ id: 24 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});

describe('fatal hls.js errors fail over to the next source', () => {
  it('a stale signed url switches', () => {
    expect(fatalAction({ response: { code: 403 } })).toEqual({ kind: 'stale', failover: true });
  });
  it('an unreachable manifest switches before showing an error', () => {
    expect(fatalAction({ details: 'manifestLoadError' })).toMatchObject({ kind: 'unreachable', failover: true });
    expect(fatalAction({ details: 'manifestLoadTimeOut' })).toMatchObject({ failover: true });
  });
  it('a codec this browser cannot decode tries another provider', () => {
    expect(fatalAction({ details: 'manifestIncompatibleCodecsError' })).toMatchObject({ kind: 'codecs', failover: true });
  });
  it('any other fatal error with a message switches too', () => {
    expect(fatalAction({ message: 'bufferAppendError' })).toMatchObject({ kind: 'error', failover: true });
  });
  it('an error with nothing to go on is nudged in place', () => {
    expect(fatalAction({})).toEqual({ kind: 'nudge', failover: false });
  });
});

// Owner 2026-11-20: a wanted source must always get a url. A provider that
// THREW on the first answer is retried by ?full=1 too (the backend does not
// memoize an answer with providerErrors, so the follow-up re-runs it), not
// only a provider that was still running (`partial`).
describe('?full=1 follow-up', () => {
  function runMore(id, first, full) {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(200, first))
      .mockResolvedValueOnce(res(200, full));
    vi.stubGlobal('fetch', fetchMock);
    const more = [];
    return new Promise((resolve) => {
      resolveLive('movie', id, {
        onDone: () => {},
        onMore: (rows) => more.push(rows),
        onFail: (e) => resolve({ err: e }),
      });
      setTimeout(() => resolve({ fetchMock, more }), 20);
    });
  }
  const LATE = { url: 'https://cdn/late.m3u8', provider: 'OneTouchTV', quality: '720p', container: 'hls', languages: ['Telugu'] };

  it('fires on providerErrors and merges the late rows', async () => {
    const { fetchMock, more } = await runMore(31,
      body([STREAM], { providerErrors: ['onetouchtv'] }), body([STREAM, LATE]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/full=1/);
    expect(more[0].map((s) => s.provider)).toContain('OneTouchTV');
  });

  it('still fires on a partial answer', async () => {
    const { fetchMock } = await runMore(32, body([STREAM], { partial: true }), body([STREAM, LATE]));
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/full=1/);
  });

  it('does not fire on a complete, error-free answer', async () => {
    const { fetchMock } = await runMore(33, body([STREAM], { providerErrors: [] }), body([STREAM, LATE]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
