// Per-provider routing: does a client need our VM proxy for this row, or can
// it fetch the upstream directly (faster)?
//
// Owner rule 2026-11-21: "use proxy only when required, else route directly,
// which plays faster; maintain at provider config level whether the proxy is
// required." Values come from
// .superpowers/sdd/2026-11-21-audio-pairing-step2/routing-matrix.md (curl
// walks master -> variant -> map -> seg1 -> seg2, browser-direct with Chrome
// UA/Origin/Referer, APK-direct with the row's own headers).
//
//   web: a browser cannot set Referer/Origin. 'direct' only where the CDN
//        answered 200 + ACAO * to a cross-origin request with chtrm's Referer.
//   apk: ExoPlayer sends the row's headers itself. 'direct' unless the host
//        refused a non-VM IP or was slower direct.
//
// A provider missing here is proxied for both: the safe default.
//
// Wire contract (backward compatible): a row the server proxies keeps its
// proxied `url`, which old web and APK builds play. When this config allows
// a client to go direct, the row also carries `directUrl`, `directHeaders`
// and `route: {web, apk}`; new clients play directUrl and fall back to `url`
// on the SAME row if it fails before the first frame. Language/audio fields
// are never touched here. /hybrid/pair, castle-demux, /pts-rebase and cast
// masters stay VM-only (they are __noProxy rows or their own routes).

const DIRECT = 'direct';
const PROXY = 'proxy';
const SAFE_DEFAULT = Object.freeze({ web: PROXY, apk: PROXY });

const PROVIDER_ROUTES = Object.freeze({
    // img1.hscow.com: browser 4/4, APK 4/4. Row headers are generic UA only.
    castletv: { web: DIRECT, apk: DIRECT },
    // VidBolt dash-hls-bridge (CloudFront Policy in the url): browser 16/16.
    // Its account label rotates (johndoesdmc / johndoesjkc / john1mc, seen
    // 2026-11-21). Only those measured labels go direct, not any worker.
    // Other hosts need a Referer (gzip.rousav.tech nginx 403 without one).
    multimovies: {
        web: PROXY, apk: DIRECT,
        hostPatterns: [
            { re: /^dash-hls-bridge\.(johndoes[a-z0-9]*|john1mc)\.workers\.dev$/, web: DIRECT, apk: DIRECT },
        ],
        hosts: {
            'gzip.rousav.tech': { web: PROXY, apk: DIRECT },
        },
    },
    // Akamai 403s any foreign Referer; web direct only once the loader sends
    // no-referrer, which is not measured on segments. APK 1/1.
    onetouchtv: { web: PROXY, apk: DIRECT },
    // *.surrealviews.com mp4: browser 0/13 (403), APK 13/13.
    showsst: { web: PROXY, apk: DIRECT },
    // bcdnxw mp4: 429 without Referer in a browser; APK direct 206.
    netmirror: { web: PROXY, apk: DIRECT },
    // embed.vidrift.net / .in Orion masters: 403 to a foreign Origin, 200 with
    // Vidrift's own Referer+Origin (new-providers.md, 2026-11-21). A browser
    // cannot send those, so web is proxied; the APK sends the row's headers.
    vidrift: { web: PROXY, apk: DIRECT },
    // VM 3.6x faster on segments; vercetti.org refuses non-VM masters and
    // serves PNG-disguised segments only the proxy strips.
    vidrock: {
        web: PROXY, apk: PROXY,
        hosts: { 'vercetti.org': { web: PROXY, apk: PROXY } },
    },
});

// Which client surface may use a provider at all (owner rule 2026-11-21).
// mapple and VaPlayer are APK-only: the APK resolves them on device
// (android resolve/MappleResolver.kt, VaplayerResolver.kt). The browser must
// never use them, so a web caller (?client=web) does not run them in the
// fan-out and never waits on their timeouts. 'none' = never for that surface.
// Any other value, or an unknown caller, keeps today's behaviour: the server
// still runs them for the APK exactly as before.
const NONE = 'none';
const PROVIDER_SURFACES = Object.freeze({
    mapple: Object.freeze({ web: NONE, apk: 'on-device' }),
    vaplayer: Object.freeze({ web: NONE, apk: 'on-device' }),
});

// ---- remote config (provider self-heal Task 9) ----
// lib/selfheal/config cfg('routes', <provider>) may override one provider:
//   { web: off|direct|proxy, apk: off|direct|proxy|device,
//     hostPatterns?: [{ re: '<regex string>', web, apk }], hosts?: { suffix: {web, apk} } }
// The code words none / on-device are accepted too. off -> surface none,
// device -> on-device; direct/proxy -> the row route. A field the remote does
// not give, or gives an invalid value for, keeps the built-in value above
// (one `[routes] config <p>.<f>=<v> invalid, built-in kept` line per value).
// Inside a remote hostPatterns / hosts entry: an invalid word keeps the
// built-in value (the built-in entry for that host, else the provider's
// built-in default) with the same one line; a missing word is proxy.
// A remote hostPatterns.re over 200 chars or with a nested quantifier
// (`(a+)+`, catastrophic backtracking) is rejected: the built-in patterns are
// kept, one `[routes] config <p>.hostPatterns re=... rejected` line each.
// With no remote every answer is today's.
const SURFACE_WORDS = { off: NONE, none: NONE, device: 'on-device', 'on-device': 'on-device' };
const ROUTE_WORDS = { direct: DIRECT, proxy: PROXY };
const warned = new Set();
function warnOnce(key, line) { if (!warned.has(key)) { warned.add(key); console.warn(line); } }

function remoteEntry(provider) {
    let v;
    try { v = require('../selfheal/config').cfg('routes', provider, {}); } catch { return null; }
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? v : null;
}

// The remote word for one surface: { surface?: 'none'|'on-device', route?: 'direct'|'proxy' } or null.
function remoteWord(provider, entry, field) {
    if (!entry || entry[field] === undefined) return null;
    const w = String(entry[field]).toLowerCase();
    const okSurface = field === 'apk' ? SURFACE_WORDS[w] : (w === 'off' || w === 'none' ? NONE : undefined);
    if (okSurface) return { surface: okSurface };
    if (ROUTE_WORDS[w]) return { route: ROUTE_WORDS[w] };
    warnOnce(`${provider}.${field}=${w}`, `[routes] config ${provider}.${field}=${w} invalid, built-in kept`);
    return null;
}

// Review M5: one word inside a hostPatterns / hosts entry.
function entryWord(provider, where, value, builtIn) {
    if (value === undefined || value === null) return PROXY;
    const w = String(value).toLowerCase();
    if (ROUTE_WORDS[w]) return ROUTE_WORDS[w];
    warnOnce(`${provider}.${where}=${w}`, `[routes] config ${provider}.${where}=${w} invalid, built-in kept`);
    return builtIn || PROXY;
}

// Review M4: a group holding a quantifier, itself quantified: (a+)+, (\w*)*, (x{2,})+.
const RE_MAX = 200;
const NESTED_QUANT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;
function unsafeRe(k) {
    if (k.length > RE_MAX) return `over ${RE_MAX} chars`;
    if (NESTED_QUANT.test(k)) return 'nested quantifier';
    return null;
}

const reCache = new Map();
function compile(re, provider) {
    if (re instanceof RegExp) return re;
    const k = String(re);
    if (!reCache.has(k)) {
        let r = null;
        try { r = new RegExp(k); } catch { warnOnce(`${provider}.re=${k}`, `[routes] config ${provider}.hostPatterns re=${k} invalid, skipped`); }
        reCache.set(k, r);
    }
    return reCache.get(k);
}

function surfaceFor(provider) {
    const p = String(provider || '').toLowerCase();
    const built = PROVIDER_SURFACES[p] || {};
    const entry = remoteEntry(p);
    const out = { ...built };
    for (const f of ['web', 'apk']) {
        const w = remoteWord(p, entry, f);
        if (!w) continue;
        if (w.surface) out[f] = w.surface;
        else delete out[f]; // direct/proxy: served on that surface
    }
    return out;
}

function surfaceAllows(provider, surface) {
    if (!surface) return true;
    return surfaceFor(provider)[surface] !== NONE;
}

// True when the APK resolves this provider on the device (it does not need
// the server to run it). Used with the canary's `blocked` state (Task 8).
function surfaceOnDevice(provider) {
    return surfaceFor(provider).apk === 'on-device';
}

// 'web' when the caller says so; null (treated as today's caller) otherwise.
function surfaceOf(query) {
    return query && query.client === 'web' ? 'web' : null;
}

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function hostMatches(host, suffix) {
    return host === suffix || host.endsWith(`.${suffix}`);
}

// {web, apk} for one row. An exact host pattern wins, then the longest
// matching host suffix, then the provider default.
function routeConfig(provider) {
    const p = String(provider || '').toLowerCase();
    const built = PROVIDER_ROUTES[p];
    const entry = remoteEntry(p);
    if (!entry) return built || null;
    const cfg = { ...(built || SAFE_DEFAULT) };
    for (const f of ['web', 'apk']) {
        const w = remoteWord(p, entry, f);
        if (w && w.route) cfg[f] = w.route;
    }
    const def = built || SAFE_DEFAULT;
    if (Array.isArray(entry.hostPatterns)) {
        const list = entry.hostPatterns.filter((x) => x && typeof x === 'object');
        const unsafe = list.filter((x) => !(x.re instanceof RegExp)).map((x) => [String(x.re), unsafeRe(String(x.re))]).filter(([, why]) => why);
        for (const [k, why] of unsafe) {
            warnOnce(`${p}.re-unsafe=${k}`, `[routes] config ${p}.hostPatterns re=${k.length > 60 ? `${k.slice(0, 60)}...` : k} rejected (${why}), built-in kept`);
        }
        if (!unsafe.length) {
            cfg.hostPatterns = list
                .map((x, i) => ({
                    re: compile(x.re, p),
                    web: entryWord(p, `hostPatterns[${i}].web`, x.web, def.web),
                    apk: entryWord(p, `hostPatterns[${i}].apk`, x.apk, def.apk),
                }))
                .filter((x) => x.re);
        }
    }
    if (entry.hosts && typeof entry.hosts === 'object' && !Array.isArray(entry.hosts)) {
        const builtHosts = (built && built.hosts) || {};
        cfg.hosts = Object.fromEntries(Object.entries(entry.hosts)
            .filter(([, r]) => r && typeof r === 'object')
            .map(([h, r]) => {
                const host = String(h).toLowerCase();
                const b = builtHosts[host] || def;
                return [host, {
                    web: entryWord(p, `hosts.${host}.web`, r.web, b.web),
                    apk: entryWord(p, `hosts.${host}.apk`, r.apk, b.apk),
                }];
            }));
    }
    return cfg;
}

function routeFor(provider, url) {
    const cfg = routeConfig(provider);
    if (!cfg) return { ...SAFE_DEFAULT };
    const host = hostOf(url);
    const pat = host && (cfg.hostPatterns || []).find((p) => p.re.test(host));
    if (pat) return { web: pat.web, apk: pat.apk };
    let best = null;
    for (const [suffix, r] of Object.entries(cfg.hosts || {})) {
        if (host && hostMatches(host, suffix) && (!best || suffix.length > best[0].length)) best = [suffix, r];
    }
    const r = best ? best[1] : cfg;
    return { web: r.web, apk: r.apk };
}

function hasHeaders(s) {
    return Boolean(s && s.headers && typeof s.headers === 'object' && Object.keys(s.headers).length);
}

// Make a provider's rows playable: record url -> headers (for /hybrid/pair),
// proxy the rows that need it, and add direct fields where the config allows.
// deps: { enableProxy, processStreamsForProxy, rememberStreams, extractOriginalUrl? }
function routeStreams(streams, serverUrl, deps) {
    if (!Array.isArray(streams)) return streams;
    const { enableProxy, processStreamsForProxy, rememberStreams } = deps;
    const unwrap = deps.extractOriginalUrl
        || require('../../proxy/proxyServer').extractOriginalUrl;
    // BEFORE any rewriting: the proxied url has no headers attached.
    rememberStreams(streams);
    // enableProxy on: every row through the proxy. Off: only rows whose
    // upstream needs request headers (a browser cannot send them). Old
    // clients play `url`, so that rule is kept for `url`; the config decides
    // only whether a new client may skip it.
    const toProxy = (s) => s && typeof s === 'object' && typeof s.url === 'string' && !s.__noProxy
        && (enableProxy || hasHeaders(s));
    const counts = {};
    const out = streams.map((s) => {
        if (!s || typeof s !== 'object') return s;
        if (s.__noProxy) { const { __noProxy, ...rest } = s; return rest; }
        if (!toProxy(s)) return s;
        const [proxied] = processStreamsForProxy([s], serverUrl);
        const inner = unwrap(s.url);
        const upstreamUrl = inner.url;
        const upstreamHeaders = hasHeaders(s) ? s.headers : inner.headers;
        const route = routeFor(s.provider, upstreamUrl);
        const { headers, ...rest } = proxied;
        const row = { ...rest, route };
        if (route.web === DIRECT || route.apk === DIRECT) {
            row.directUrl = upstreamUrl;
            row.directHeaders = { ...(upstreamHeaders || {}) };
        }
        const k = `${s.provider || '?'}:${route.web}/${route.apk}`;
        counts[k] = (counts[k] || 0) + 1;
        return row;
    });
    const keys = Object.keys(counts);
    if (keys.length) {
        console.log(`[route] ${keys.map((k) => `${k}=${counts[k]}`).join(' ')} `
            + `(web/apk; url stays proxied, directUrl when direct) of ${streams.length} row(s)`);
    }
    return out;
}

module.exports = { PROVIDER_ROUTES, PROVIDER_SURFACES, routeFor, routeStreams, surfaceAllows, surfaceOf, surfaceOnDevice, DIRECT, PROXY };
