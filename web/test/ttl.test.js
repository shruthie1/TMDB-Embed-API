import { describe, it, expect } from 'vitest';
import { createCache, TTL_SEC } from '../lib/ttl';

/**
 * The client cache bounds by BOTH time and size. Size-only lets stale entries
 * sit in memory forever on a low-traffic app; time-only lets it grow without
 * limit. Both halves need holding.
 *
 * Every method takes an explicit `now`, so these assert real boundaries rather
 * than sleeping.
 */
describe('createCache — time bound', () => {
  it('serves a hit right up to the ttl and misses exactly at it', () => {
    const c = createCache({ ttlMs: 1000, max: 10 });
    c.set('k', 'v', 0);
    expect(c.get('k', 999)).toBe('v');
    expect(c.get('k', 1000)).toBeUndefined();   // >= ttl, not >
  });

  it('drops an expired entry rather than leaving it to be re-read', () => {
    const c = createCache({ ttlMs: 1000, max: 10 });
    c.set('k', 'v', 0);
    c.get('k', 2000);
    expect(c.size).toBe(0);
  });

  it('prunes expired entries on write, so size reflects live data', () => {
    const c = createCache({ ttlMs: 1000, max: 100 });
    c.set('old', 1, 0);
    c.set('new', 2, 5000);
    expect(c.size).toBe(1);
  });
});

describe('createCache — size bound and recency', () => {
  it('evicts the least recently USED, not merely the oldest written', () => {
    // The subtle half: get() re-inserts to refresh recency. Without that a hot
    // key written early is evicted while a cold one written later survives.
    const c = createCache({ ttlMs: 60000, max: 3 });
    c.set('a', 1, 0); c.set('b', 2, 0); c.set('c', 3, 0);
    c.get('a', 1);                 // 'a' is now the most recently used
    c.set('d', 4, 1);              // one must go, and it must be 'b'
    expect(c.get('a', 2)).toBe(1);
    expect(c.get('b', 2)).toBeUndefined();
  });

  it('never exceeds max', () => {
    const c = createCache({ ttlMs: 60000, max: 5 });
    for (let i = 0; i < 50; i++) c.set(`k${i}`, i, 0);
    expect(c.size).toBe(5);
  });

  it('does not spin when max is zero', () => {
    // `while (store.size > max) delete` must terminate on an empty store.
    const c = createCache({ ttlMs: 1000, max: 0 });
    expect(() => c.set('x', 1, 0)).not.toThrow();
    expect(c.size).toBe(0);
  });

  it('misses a key that was never written', () => {
    expect(createCache({ ttlMs: 1000 }).get('nope', 0)).toBeUndefined();
  });
});

describe('createCache — a missing ttl never expires', () => {
  it('keeps entries forever when ttlMs is undefined', () => {
    // Every comparison against NaN is false, so nothing ages out and the cache
    // is bounded by SIZE alone. Pinned because it is silent: a caller that
    // forgets ttlMs gets a working cache that quietly serves stale data.
    const c = createCache({ max: 5 });
    c.set('k', 'v', 0);
    expect(c.get('k', 1e9)).toBe('v');
  });
});

describe('TTL_SEC policy', () => {
  it('ages data by how fast it actually changes', () => {
    expect(TTL_SEC.SEARCH).toBeLessThan(TTL_SEC.DISCOVERY);
    expect(TTL_SEC.DISCOVERY).toBeLessThan(TTL_SEC.TITLE);
    expect(TTL_SEC.TITLE).toBe(TTL_SEC.TITLE_FULL);
  });
});
