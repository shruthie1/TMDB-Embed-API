'use strict';

// After a heal moves a provider to a new host, rows cached on the old host
// are dead links. VM 2026-11-22: 25 embed.vidrift.net master 404s after the
// heal had adopted embed.vidrift.in, from rows cached before it. Drop:
//   - that provider's cached rows that point at the old host,
//   - that provider's cached empties (they came from the dead host),
//   - aggregate answers holding any row on the old host (a proxied row
//     carries the old URL percent-encoded; a host name encodes to itself).
// The next request re-resolves on the new host. Returns counts.
function hostOf(u) { try { return new URL(u).host; } catch { return null; } }

function evictHostRows({ providerHitCache, providerEmptyCache, streamsMemo }, name, previousBase) {
    const oldHost = hostOf(previousBase);
    if (!oldHost) return { hits: 0, empties: 0, memo: 0 };
    const onOld = (rows) => Array.isArray(rows) && rows.some((r) => r && String(r.url || '').includes(oldHost));
    const prefix = `${name}|`;
    const hits = providerHitCache ? providerHitCache.deleteWhere((k, rows) => k.startsWith(prefix) && onOld(rows)) : 0;
    const empties = providerEmptyCache ? providerEmptyCache.deleteWhere((k) => k.startsWith(prefix)) : 0;
    const memo = streamsMemo ? streamsMemo.deleteWhere((k, p) => onOld(p && p.streams)) : 0;
    return { hits, empties, memo };
}

module.exports = { evictHostRows };
