import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchTitle, fetchTitleFull, fetchRow, fetchSimilar, JSON_TIMEOUT_MS, TITLE_HEDGE_MS } from '../lib/api';

// APK parity (2026-11-22): the phone hung 30 s on /api/title/.../full over a
// dead pooled connection. Every JSON call now has a ~10 s timeout and one
// retry; the title page hedges a second request after ~2.5 s, first wins.

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
/** A request that never answers until its signal aborts (a dead connection). */
const hang = (_u, opts) => new Promise((_r, reject) => {
  opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error(String(opts.signal.reason?.message || 'aborted')), { name: 'AbortError' })), { once: true });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('JSON timeouts and one retry', () => {
  it('the default timeout is about 10 s and the hedge about 2.5 s', () => {
    expect(JSON_TIMEOUT_MS).toBe(10000);
    expect(TITLE_HEDGE_MS).toBe(2500);
  });

  it('a hung row request times out and is retried once; the retry answers', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn((u, o) => (++n === 1 ? hang(u, o) : Promise.resolve(ok({ titles: [1] })))));
    const p = fetchRow('trending');
    await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS + 10);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('two hung attempts end as a timeout the page can show (not a silent abort)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(hang));
    const p = fetchTitle('movie', 1);
    await vi.advanceTimersByTimeAsync(2 * JSON_TIMEOUT_MS + 50);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.aborted).toBeFalsy();
    expect(r.timedOut).toBe(true);
  });

  it('a 404 is not retried; a 503 is retried once', async () => {
    const f404 = vi.fn(async () => ({ ok: false, status: 404, json: async () => null }));
    vi.stubGlobal('fetch', f404);
    expect((await fetchRow('x')).status).toBe(404);
    expect(f404).toHaveBeenCalledTimes(1);
    const f503 = vi.fn(async () => ({ ok: false, status: 503, json: async () => null }));
    vi.stubGlobal('fetch', f503);
    await fetchRow('x');
    expect(f503).toHaveBeenCalledTimes(2);
  });

  it('a caller cancel is not retried and reports aborted', async () => {
    const f = vi.fn(hang);
    vi.stubGlobal('fetch', f);
    const ac = new AbortController();
    const p = fetchRow('x', { signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('similar titles go through the same client (timeout + retry)', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn((u, o) => (++n === 1 ? hang(u, o) : Promise.resolve(ok({ titles: [7] })))));
    const p = fetchSimilar('movie', 5);
    await vi.advanceTimersByTimeAsync(JSON_TIMEOUT_MS + 10);
    expect((await p).body.titles).toEqual([7]);
  });
});

describe('title page hedge', () => {
  it('no answer in 2.5 s: a second request goes out and its answer wins, the first is aborted', async () => {
    vi.useFakeTimers();
    const signals = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn((u, o) => {
      signals.push(o.signal);
      return ++n === 1 ? hang(u, o) : Promise.resolve(ok({ title: 'Devara' }));
    }));
    const p = fetchTitleFull('movie', 1291608, { hedgeMs: TITLE_HEDGE_MS });
    await vi.advanceTimersByTimeAsync(TITLE_HEDGE_MS - 100);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.body.title).toBe('Devara');
    expect(n).toBe(2);
    expect(signals[0].aborted).toBe(true);
  });

  it('both legs dead: it still ends, as a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(hang));
    const p = fetchTitleFull('movie', 3, { hedgeMs: TITLE_HEDGE_MS });
    await vi.advanceTimersByTimeAsync(TITLE_HEDGE_MS + 2 * JSON_TIMEOUT_MS + 100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it('a fast answer sends no hedge', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ok({ title: 'x' }));
    vi.stubGlobal('fetch', f);
    const r = await fetchTitleFull('movie', 2, { hedgeMs: TITLE_HEDGE_MS });
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
