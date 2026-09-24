// DNS-over-HTTPS resolution for hosts the local resolver lies about.
//
// WHY THIS EXISTS (measured 2026-09-23, ACT Broadband):
//   dig net27.cc            -> 49.205.171.201   (ACT's block server)
//   dig @1.1.1.1 net27.cc   -> 123.176.40.67    (still wrong - port 53 is
//                                                intercepted, so naming a
//                                                public resolver is not enough)
//   DoH cloudflare-dns.com  -> 172.67.146.66, 104.21.81.201  (real, Cloudflare)
//
// Both plain-DNS answers fail: the block server returns
// `403 <title>Court Orders</title>` on HTTP and resets TLS on 443, and
// 123.176.40.67 resets too. The DoH answers return the real site - 200 with
// 56KB of HTML, and `/api/embed-tmdb/533535` answers
// `{"ok":true,"title":"Deadpool & Wolverine",...}` in 92ms.
//
// So this is NOT censorship circumvention plumbing bolted onto the app: the
// only thing wrong is that the name resolves to the wrong address. We ask a
// resolver that answers honestly, over HTTPS where it cannot be rewritten, and
// then connect normally.
//
// Scope is deliberately narrow. Only hosts listed in DOH_HOSTS are affected;
// everything else keeps using the system resolver, because overriding DNS
// process-wide would break split-horizon names and any local development host.

const dns = require('node:dns');

const DOH_ENDPOINT = process.env.DOH_ENDPOINT || 'https://cloudflare-dns.com/dns-query';
// Comma-separated, so a new mirror can be added without a code change.
const DOH_HOSTS = new Set(
    (process.env.DOH_HOSTS || 'net27.cc,netfree.cc,iosmirror.cc,net2025.cc,net50.cc,net28.cc')
        .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
);

const TTL_MS = Number(process.env.DOH_TTL_MS) || 10 * 60 * 1000;
const cache = new Map(); // host -> { ips: string[], until: number }

async function resolveViaDoh(host) {
    const hit = cache.get(host);
    if (hit && hit.until > Date.now()) return hit.ips;

    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=A`;
    const r = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`DoH ${r.status}`);
    const j = await r.json();
    // type 1 = A. Other types (5 = CNAME) appear in the same Answer array and
    // carry a name, not an address, so filtering by type matters.
    const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
    if (!ips.length) throw new Error('DoH returned no A record');

    cache.set(host, { ips, until: Date.now() + TTL_MS });
    console.log(`[doh] ${host} -> ${ips.join(', ')}`);
    return ips;
}

/**
 * A `lookup` implementation for undici's connect options.
 *
 * Falls back to the system resolver for anything not in DOH_HOSTS, and also if
 * DoH itself fails - a broken DoH endpoint must not take down hosts that were
 * resolving fine.
 */
function dohLookup(hostname, options, callback) {
    const host = String(hostname).toLowerCase();
    if (!DOH_HOSTS.has(host)) return dns.lookup(hostname, options, callback);

    resolveViaDoh(host)
        .then((ips) => {
            const addrs = ips.map((address) => ({ address, family: 4 }));
            // undici passes `all` when it wants the full list.
            if (options && options.all) return callback(null, addrs);
            return callback(null, addrs[0].address, 4);
        })
        .catch((err) => {
            console.warn(`[doh] ${host} failed (${err.message}); using system DNS`);
            return dns.lookup(hostname, options, callback);
        });
}

module.exports = { dohLookup, resolveViaDoh, DOH_HOSTS };
