'use strict';

// A Map with a per-entry TTL and an entry cap. Oldest insertion is evicted
// first when the cap is reached. Used for the aggregate streams memo and the
// per-provider result caches in apiServer.js, which were unbounded Maps.

function createTtlCache({ ttlMs, maxEntries }) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() > e.expiresAt) { map.delete(key); return undefined; }
      return e.value;
    },
    has(key) { return this.get(key) !== undefined; },
    set(key, value, ttl = ttlMs) {
      map.delete(key); // re-insert so a refreshed key counts as newest
      map.set(key, { value, expiresAt: Date.now() + ttl });
      while (map.size > maxEntries) map.delete(map.keys().next().value);
    },
    delete(key) { return map.delete(key); },
    prune() {
      const now = Date.now();
      for (const [k, e] of map) if (e.expiresAt < now) map.delete(k);
    },
    get size() { return map.size; },
  };
}

module.exports = { createTtlCache };
