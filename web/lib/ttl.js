// Cache TTL policy for the web app. Mirrors apps/resolver/src/ttl.js so both
// sides age data the same way.

export const TTL_SEC = {
  TITLE: 7 * 24 * 3600,       // metadata changes rarely
  TITLE_FULL: 7 * 24 * 3600,
  DISCOVERY: 6 * 3600,        // new releases appear through the day
  SEARCH: 3600,
};

/**
 * A Map-backed cache with BOTH a time bound and a size bound.
 * Size-only eviction (what we had) lets stale entries sit in memory
 * indefinitely on a low-traffic app; time-only eviction lets it grow forever.
 */
export function createCache({ ttlMs, max = 200 }) {
  const store = new Map();

  const prune = (now = Date.now()) => {
    for (const [k, v] of store) {
      if (now - v.at >= ttlMs) store.delete(k);
    }
  };

  return {
    get(key, now = Date.now()) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (now - hit.at >= ttlMs) { store.delete(key); return undefined; }
      store.delete(key); store.set(key, hit);   // refresh LRU recency
      return hit.value;
    },
    set(key, value, now = Date.now()) {
      prune(now);
      store.set(key, { value, at: now });
      while (store.size > max) store.delete(store.keys().next().value);
    },
    get size() { return store.size; },
    prune,
  };
}
