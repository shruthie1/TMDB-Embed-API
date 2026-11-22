import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Speculative pre-resolve on hover or D-pad dwell.
 *
 * WHAT CHANGED 2026-09-22: the resolve itself is gone. It called the VM's
 * `/api/resolve?background=1`, which went away with the resolver - every call
 * 404'd, so hovering a rail spent one failed request per card and warmed
 * nothing. Measured: all 8 `/api/vm/*` paths 404 on :8790.
 *
 * The dwell HALF still works and is still tested, because it is what a real
 * speculative endpoint would be wired back into. The tests that policed the
 * request (an inflight cap of 2, an asked-set, a background vantage) are gone
 * with the code they described: keeping them green against a mocked fetch is
 * exactly how the dead endpoint survived unnoticed in the first place.
 */
const src = readFileSync(fileURLToPath(new URL('../lib/prefetch.js', import.meta.url)), 'utf8');

let calls;
async function load() {
  vi.resetModules();
  calls = [];
  globalThis.fetch = vi.fn(() => {
    calls.push('fetch');
    return Promise.resolve({ ok: true });
  });
  return import('../lib/prefetch');
}

/**
 * Observe the dwell WITHOUT a transport.
 *
 * preresolve is a no-op, and an ESM internal call binds straight to the local
 * function, so spying on the export never sees it - measured, the spy stayed
 * at 0 calls. What is actually under test here is the timer contract, so build
 * the handlers over a recording stand-in and assert on that.
 */
function dwell(DWELL_MS = 600) {
  const fired = [];
  const props = (type, id, opts) => {
    let timer = null;
    const start = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fired.push({ type, id, opts }), DWELL_MS);
    };
    const stop = () => clearTimeout(timer);
    return { fired, onMouseEnter: start, onMouseLeave: stop, onFocus: start, onBlur: stop };
  };
  return { fired, props };
}

beforeEach(() => { vi.useRealTimers(); });

describe('preresolve — no speculative endpoint', () => {
  it('issues no request at all', async () => {
    const { preresolve } = await load();
    preresolve('movie', 1);
    preresolve('movie', 2);
    preresolve('movie', 3);
    expect(calls).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('is not quietly repointed at the real playback resolve', () => {
    // `/api/streams/:type/:id` has no background flag, so hovering a rail
    // would start full extractions for titles nobody clicked - the exact
    // thing the background vantage existed to prevent.
    // Strip comments first: the warning above `preresolve` names the endpoint
    // deliberately, and that note is the thing stopping someone re-adding it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/api\//);
    expect(code).not.toMatch(/fetch\(/);
  });

  it('keeps the signature so callers need no change when it returns', async () => {
    const { preresolve, warmContinueWatching } = await load();
    expect(typeof preresolve).toBe('function');
    expect(() => preresolve('movie', 1, { season: 2, episode: 3 })).not.toThrow();
    expect(() => warmContinueWatching([{ mediaType: 'movie', tmdbId: 1 }])).not.toThrow();
  });
});

describe('intentProps — dwell, not a passing mouse', () => {
  it('fires only after sustained intent', () => {
    vi.useFakeTimers();
    const { fired, props } = dwell();
    const p = props('movie', 1);
    p.onMouseEnter();
    vi.advanceTimersByTime(599);
    expect(fired).toHaveLength(0);        // a mouse crossing a card costs nothing
    vi.advanceTimersByTime(1);
    expect(fired).toHaveLength(1);
  });

  it('cancels when the pointer leaves before the dwell elapses', () => {
    vi.useFakeTimers();
    const { fired, props } = dwell();
    const p = props('movie', 1);
    p.onMouseEnter();
    vi.advanceTimersByTime(400);
    p.onMouseLeave();
    vi.advanceTimersByTime(5000);
    expect(fired).toHaveLength(0);
  });

  it('treats D-pad focus as intent too', () => {
    vi.useFakeTimers();
    const { fired, props } = dwell();
    const p = props('movie', 1);
    p.onFocus();
    vi.advanceTimersByTime(600);
    expect(fired).toHaveLength(1);
    p.onBlur();
  });

  it('still wires every intent event, on the real module', async () => {
    // The stand-in above proves the timer rule; this proves the shipped
    // intentProps exposes the same surface and the same dwell constant.
    const { intentProps } = await load();
    const p = intentProps('movie', 1);
    for (const k of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur', 'onTouchStart']) {
      expect(typeof p[k]).toBe('function');
    }
    expect(src).toMatch(/const DWELL_MS = 600;/);
    expect(src).toMatch(/preresolve\(type, tmdbId, opts\);\s*\/\/[^\n]*\n\s*warmTitle\(type, tmdbId\);\s*\}, DWELL_MS\)/);
  });

  it('after the dwell warms the title page record (metadata only, never streams)', async () => {
    vi.useFakeTimers();
    const { intentProps } = await load();
    vi.stubGlobal('window', {});
    const p = intentProps('movie', 5);
    p.onMouseEnter();
    vi.advanceTimersByTime(599);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(globalThis.fetch.mock.calls.map(c => c[0])).toEqual(['/api/title/movie/5/full']);
    expect(globalThis.fetch.mock.calls.some(c => String(c[0]).includes('/api/streams'))).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('warmContinueWatching', () => {
  it('warms only the top two, whatever the rail holds', async () => {
    const { warmContinueWatching } = await load();
    // No transport to count, so assert the cap where it is expressed.
    expect(src).toMatch(/items\.slice\(0, limit\)/);
    expect(src).toMatch(/limit = 2/);
    expect(() => warmContinueWatching([
      { mediaType: 'movie', tmdbId: 11 },
      { mediaType: 'movie', tmdbId: 12 },
      { mediaType: 'movie', tmdbId: 13 },
    ])).not.toThrow();
  });

  it('survives an empty or missing list', async () => {
    const { warmContinueWatching } = await load();
    expect(() => warmContinueWatching()).not.toThrow();
    expect(() => warmContinueWatching([])).not.toThrow();
  });
});
