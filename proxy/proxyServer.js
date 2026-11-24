// Lightweight proxy/m3u8/segment/subtitle rewriting layer. thanks to https://github.com/cinepro-org/ for the original code.
// Adapted from external project (user supplied) to fit CommonJS style and existing config system.
// Provides conditional route registration via enableProxy flag.

const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const { publicBase } = require('../lib/runtime/publicBase');
const headerTokens = require('../lib/routing/headerTokens');
const { playlistCompression } = require('./playlistCompression');

// node-fetch without an explicit agent uses a small default connection pool per
// host. HLS is connection-hungry (a playlist warm-up plus the segment the player
// is actually blocked on, all to the same CDN), so requests were queueing behind
// each other and appearing to the browser as a hung ts-proxy. Keep-alive with a
// generous ceiling lets the real request through and reuses sockets.
// maxSockets was 64. A single HLS playback opens several segment fetches at
// once, and two players plus a hybrid pair (which fans out to BOTH providers)
// reach that ceiling easily; past it every new segment waits for a slot and
// burns its whole timeout queued. Measured 2026-09-22: active=128 queued=87.
// `timeout` here is socket-IDLE only - it does NOT bound a request whose body
// stalls, which is why the watchdog in pipeUpstream exists.
const MAX_SOCKETS = Number(process.env.PROXY_MAX_SOCKETS) || 256;
// lookupWithFallback: VM1's stub resolver fails DNAME'd hosts (insertunit's
// *.interkh.com renditions) that dns.resolve4 answers (utils/dnsFallback.js).
const { lookupWithFallback } = require('../utils/dnsFallback');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS, timeout: 60000, lookup: lookupWithFallback });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS, timeout: 60000, lookup: lookupWithFallback });
const agentFor = (url) => (String(url).startsWith('https:') ? httpsAgent : httpAgent);

// Socket exhaustion is invisible until you print it: a request queued in
// `requests` is one the pool has accepted but has no socket for yet, which is
// exactly what a hung ts-proxy looks like from the browser.
setInterval(() => {
    const count = (a) => Object.values(a).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    const active = count(httpsAgent.sockets) + count(httpAgent.sockets);
    const queued = count(httpsAgent.requests) + count(httpAgent.requests);
    const free = count(httpsAgent.freeSockets) + count(httpAgent.freeSockets);
    // Only on change: a steady line every 5s was 18625 of 23201 log lines on
    // prod 2026-11-19 and buried everything else.
    const line = `[pool] active=${active} queued=${queued} free=${free}`;
    if ((active || queued || lastPoolLine) && line !== lastPoolLine) console.log(line);
    lastPoolLine = (active || queued) ? line : '';
}, 5000).unref();
let lastPoolLine = '';

const CACHE_MAX_SIZE = 2000;
const CACHE_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
// A count cap alone does not bound memory: 2000 HLS segments of 1-4 MB is
// 2-8 GB, while PM2 restarts this process at 500 MB (--max-memory-restart).
// Cap the bytes too, evicting oldest first.
const CACHE_MAX_BYTES = Number(process.env.PROXY_SEGMENT_CACHE_MAX_BYTES) || 64 * 1024 * 1024;
const segmentCache = new Map();
let segmentCacheBytes = 0;
function dropSegment(url) {
    const e = segmentCache.get(url);
    if (!e) return;
    segmentCacheBytes -= e.data ? e.data.byteLength : 0;
    segmentCache.delete(url);
}
function cacheSegment(url, data, headers) {
    dropSegment(url);
    if (!data || data.byteLength > CACHE_MAX_BYTES) return;
    segmentCache.set(url, { data, headers, timestamp: Date.now() });
    segmentCacheBytes += data.byteLength;
    while (segmentCacheBytes > CACHE_MAX_BYTES || segmentCache.size > CACHE_MAX_SIZE) {
        dropSegment(segmentCache.keys().next().value);
    }
}
// Small entries, but one per distinct upstream url, forever, before this cap.
const PROGRESSIVE_MAP_MAX = 5000;
// Track first open-ended (bytes=0-) range per target to clamp only once per TTL window
const openRangeClampMap = new Map();
const OPEN_RANGE_CLAMP_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Progressive open-ended growth tracking: keeps expanding bytes=0- served window.
const progressiveOpenMap = new Map(); // url -> { lastEnd }
// Tail prefetch cache: stores last N KB for quick tail range responses
const tailPrefetchMap = new Map(); // url -> { data: Buffer, start: number, end: number, size: number, ts: number }
const TAIL_PREFETCH_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isCacheDisabled() {
    return process.env.DISABLE_CACHE === 'true';
}

function cleanupCache() {
    const now = Date.now();
    for (const [url, entry] of segmentCache.entries()) {
        if (now - entry.timestamp > CACHE_EXPIRY_MS) dropSegment(url);
    }
    if (segmentCache.size > CACHE_MAX_SIZE) {
        const entries = Array.from(segmentCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toRemove = entries.slice(0, segmentCache.size - CACHE_MAX_SIZE);
        toRemove.forEach(([u]) => dropSegment(u));
    }
    return segmentCache.size;
}
setInterval(cleanupCache, 30 * 60 * 1000).unref();

function cleanupClampMap() {
    const now = Date.now();
    for (const [url, ts] of openRangeClampMap.entries()) {
        if (now - ts > OPEN_RANGE_CLAMP_TTL_MS) openRangeClampMap.delete(url);
    }
}
setInterval(cleanupClampMap, 10 * 60 * 1000).unref();

function cleanupTailPrefetch() {
    const now = Date.now();
    for (const [url, entry] of tailPrefetchMap.entries()) {
        if (now - entry.ts > TAIL_PREFETCH_TTL_MS) tailPrefetchMap.delete(url);
    }
}
setInterval(cleanupTailPrefetch, 15 * 60 * 1000).unref();

// Upstream fetches had no timeout. A CDN that accepts the connection and then
// stalls (or silently swallows HEAD) left the request hanging forever, which
// surfaced in the browser as a ts-proxy request stuck on (pending) until hls.js
// gave up and canceled it. Every upstream call now aborts on its own deadline:
// probes get a short one because they are optional, body reads a longer one.
const PROBE_TIMEOUT_MS = Number(process.env.PROXY_PROBE_TIMEOUT_MS) || 6000;
const BODY_TIMEOUT_MS = Number(process.env.PROXY_BODY_TIMEOUT_MS) || 30000;
// How long a body may go SILENT before its socket is reclaimed. Not a total
// duration cap: a big segment is allowed to take as long as it needs, provided
// it keeps delivering bytes.
const BODY_STALL_MS = Number(process.env.PROXY_BODY_STALL_MS) || 25000;

// Read a whole body under a deadline. `fetchWithTimeout` clears its abort timer
// once HEADERS arrive, which is correct for streaming but leaves a buffered
// read with no limit at all - a response that stops mid-body simply never
// resolves, and its socket is never returned to the agent. Everything that
// awaits arrayBuffer()/text() goes through here instead.
async function readBodyWithTimeout(resp, timeoutMs = BODY_STALL_MS, kind = 'arrayBuffer') {
    let timer = null;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
            discardBody(resp);
            reject(new Error(`body read exceeded ${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([resp[kind](), deadline]);
    } finally {
        clearTimeout(timer);
    }
}

// Give a socket back when the response is being ABANDONED.
//
// node-fetch keep-alive only returns a socket to the agent's free list once the
// body is fully read or destroyed. Every `if (!resp.ok) return ...` path threw
// the response away WITHOUT touching its body, so the socket stayed checked out
// for good. A provider that is merely erroring - VaPlayer answers Cloudflare
// 522 on every request - therefore leaked one socket per attempt, and the pool
// wedged with a small `active` count that never fell: measured 2026-09-22,
// `[pool] active=9 queued=0 free=0` steady while the API returned `socket hang
// up` to every new request until restart.
//
// An error body is small and uninteresting, so destroy rather than read it.
//
// Destroying resp.body alone does NOT release the socket: node-fetch v2 hands
// out a PassThrough piped from the real response, so destroying it just
// unpipes, the real response pauses, and the socket stays checked out until
// the origin gives up. Measured 2026-11-20 with node-fetch 2.7.0 and a 64 MB
// body: after body.destroy() the origin connection was still open and the
// agent still counted it active; after aborting the request both were gone.
// Prod showed the same shape: `[pool] active=16 queued=0 free=0` for 8+ hours
// with no viewers (2026-11-19 00:00-08:37), cleared only by a restart.
// So abort the request (fetchWithTimeout attaches the hook), then destroy.
function discardBody(resp) {
    const body = resp?.body;
    // node-fetch emits the abort as an 'error' on the body; nobody is reading.
    try { body?.on?.('error', () => {}); } catch { /* not an emitter */ }
    try { resp?.[ABORT]?.(); } catch { /* already settled */ }
    try { body?.destroy?.(); } catch { /* already gone */ }
}

// Short cooldown for a host that has told us to back off.
//
// A rate-limited upstream gets WORSE the more we retry it. Measured 2026-09-22:
// showsst's api.whysosigmabro.fun 302s to d.whysosigmabro.fun, which answered
// `upstream 427` / `upstream blocked`, and the log showed 9 fetches of the same
// url inside one playback attempt as hls.js and the player both retried. Serve
// the refusal from memory for a short window instead of forwarding every retry.
//
// Deliberately SHORT and per-host: these limits lift on their own, and a stale
// breaker would keep a recovered provider dead. Status-based only - a 404 or a
// 522 is not a rate limit and must not trip it.
const THROTTLE_STATUSES = new Set([429, 427, 503]);
const THROTTLE_COOLDOWN_MS = Number(process.env.PROXY_THROTTLE_COOLDOWN_MS) || 20000;
const throttledHosts = new Map(); // host -> epoch ms when it may be tried again

function hostOf(url) {
    try { return new URL(String(url)).hostname; } catch { return null; }
}

function throttledUntil(url) {
    const h = hostOf(url);
    if (!h) return 0;
    const until = throttledHosts.get(h) || 0;
    if (until && until <= Date.now()) { throttledHosts.delete(h); return 0; }
    return until;
}

// A signed url that has EXPIRED can never succeed on retry - only a fresh
// resolve can help. Measured 2026-09-22 on movie/1213243: showsst's second
// front, proxy2.jordanblackwell.bid, answered
// `{"success":false,"error":"Invalid or expired media grant"}` and the log
// showed ELEVEN fetches of that one playlist url while hls.js and the player
// both retried. TLS was clean (Google Trust Services), so this was not the
// firewall - the grant had simply run out.
//
// Keyed by the EXACT url, not the host: the host is fine, this one signed link
// is not, and blocking the host would kill the next resolve's fresh link too.
// Expired/forbidden is dead on the FIRST response - no retry can fix it.
const DEAD_STATUSES = new Set([401, 403, 404, 410]);
// Anything else that fails REPEATEDLY on the same url is dead in practice.
// Measured 2026-09-22 on movie/1213243: the sub-playlist
// .../playlist/ygo6NnOV3Q5kLUAQUsC-aQ/content_icUxz answered 500 on six
// separate fetches across two playback attempts and never recovered, while
// the master playlist beside it answered 200 every time. Two strikes is
// enough to tell a dead rendition from a blip.
const DEAD_STRIKES = 2;
const DEAD_URL_TTL_MS = Number(process.env.PROXY_DEAD_URL_TTL_MS) || 60000;
const deadUrls = new Map(); // url -> epoch ms when the note expires

function deadStatusFor(url) {
    const rec = deadUrls.get(url);
    if (!rec) return 0;
    if (rec.until <= Date.now()) { deadUrls.delete(url); return 0; }
    return rec.status;
}

const urlStrikes = new Map(); // url -> consecutive failure count

function noteDeadUrl(url, status) {
    const key = String(url);
    const code = Number(status);
    if (!DEAD_STATUSES.has(code)) {
        const n = (urlStrikes.get(key) || 0) + 1;
        urlStrikes.set(key, n);
        if (n < DEAD_STRIKES) return;
    }
    urlStrikes.delete(key);
    deadUrls.set(key, { status: code, until: Date.now() + DEAD_URL_TTL_MS });
    if (deadUrls.size > 500) {
        // Bounded: drop the oldest half rather than grow without limit.
        const keys = [...deadUrls.keys()].slice(0, 250);
        for (const k of keys) deadUrls.delete(k);
    }
    if (urlStrikes.size > 500) {
        for (const k of [...urlStrikes.keys()].slice(0, 250)) urlStrikes.delete(k);
    }
}

function noteThrottle(url, status) {
    if (!THROTTLE_STATUSES.has(Number(status))) return;
    const h = hostOf(url);
    if (!h) return;
    throttledHosts.set(h, Date.now() + THROTTLE_COOLDOWN_MS);
    console.warn(`[throttle] ${h} returned ${status}; pausing it for ${THROTTLE_COOLDOWN_MS}ms`);
}

// The request's abort, hung on its response so a body that will not be read
// to the end can give its socket back (see discardBody).
const ABORT = Symbol('abortUpstream');

async function fetchWithTimeout(url, options = {}, timeoutMs = BODY_TIMEOUT_MS) {
    const controller = new AbortController();
    // The deadline covers the handshake and headers only. Clearing it in a
    // finally would be wrong in the other direction too: leaving it armed
    // aborts a perfectly healthy body mid-download, since a large segment
    // legitimately takes longer to stream than to start.
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // A CALLER's signal (the client hanging up) must also abort this fetch.
    //
    // `signal` used to be written after the options spread, so a signal passed
    // in was silently discarded, and the request ran to its full timeout even
    // though nobody was waiting for it any more. hls.js cancels segments on
    // every seek and every quality switch, so those abandoned requests each
    // held a pool slot for 30s. Measured 2026-09-22 with maxSockets=64:
    // `[pool] active=128 queued=87 free=0` and 27 of 41 aborts logged
    // `bytes=0` - they never got a single byte because they never got a
    // socket. A healthy ts-proxy segment then 500s at 42s while the SAME url
    // fetched directly returns 200 in 0.43s.
    const outer = options.signal;
    const onAbort = () => controller.abort();
    if (outer) {
        if (outer.aborted) controller.abort();
        else outer.addEventListener('abort', onAbort, { once: true });
    }
    try {
        const resp = await fetch(url, { agent: agentFor(url), ...options, signal: controller.signal });
        clearTimeout(timer);
        Object.defineProperty(resp, ABORT, { value: () => controller.abort() });
        return resp;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    } finally {
        // Without this the aborted client's listener stays attached to a
        // long-lived signal and leaks one closure per request.
        if (outer) outer.removeEventListener('abort', onAbort);
    }
}

function getCachedSegment(url) {
    if (isCacheDisabled()) return null;
    const e = segmentCache.get(url);
    if (!e) return null;
    if (Date.now() - e.timestamp > CACHE_EXPIRY_MS) { dropSegment(url); return null; }
    return e;
}

async function prefetchSegment(url, headers) {
    if (isCacheDisabled() || segmentCache.size >= CACHE_MAX_SIZE) return;
    const existing = segmentCache.get(url);
    if (existing && Date.now() - existing.timestamp <= CACHE_EXPIRY_MS) return;
    try {
        const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': DEFAULT_UA, ...headers } });
        if (!resp.ok) { discardBody(resp); return; }
        const data = new Uint8Array(await readBodyWithTimeout(resp));
        const responseHeaders = {};
        resp.headers.forEach((v, k) => responseHeaders[k] = v);
        cacheSegment(url, data, responseHeaders);
    } catch (_e) { /* ignore */ }
}

const PREFETCH_MAX = Number(process.env.PROXY_PREFETCH_MAX) || 3;
const PREFETCH_CONCURRENCY = Number(process.env.PROXY_PREFETCH_CONCURRENCY) || 2;

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function inferContentType(upstreamCT, targetUrl) {
    // Several providers disguise media segments as images or scripts (Castle
    // serves .jpg, NetMirror .js) and the CDN labels them to match. Forwarding
    // image/jpeg to the browser makes MSE reject the buffer, so the player just
    // spins on "Loading stream...". A disguised type is therefore as unusable
    // as a missing one: fall through to extension/URL sniffing in both cases.
    const disguised = upstreamCT && /^(image|text|font)\//i.test(upstreamCT);
    const bad = !upstreamCT || disguised || /application\/octet-stream/i.test(upstreamCT) || /application\/(x-)?zip/i.test(upstreamCT) || /application\/javascript/i.test(upstreamCT);
    if (!bad) return upstreamCT;
    if (/\.mkv(\?|$)/i.test(targetUrl)) return 'video/x-matroska';
    if (/\.(mp4|m4s)(\?|$)/i.test(targetUrl)) return 'video/mp4';
    if (/\.m3u8(\?|$)/i.test(targetUrl)) return 'application/vnd.apple.mpegurl';
    // Anything else reaching ts-proxy is a media segment whatever it is named,
    // and mp2t is what every one of these providers actually ships.
    return 'video/mp2t';
}

// An fMP4 segment or init file starts with a box whose type sits at bytes 4-8.
// Disguised fMP4 (mapple) otherwise falls through to video/mp2t. Only used
// where the body is already in memory; the streaming path keeps the URL guess.
const FMP4_BOXES = new Set(['styp', 'ftyp', 'moof']);
function sniffSegmentType(ct, buf) {
    if (ct !== 'video/mp2t' || !buf || !(buf.byteLength >= 8)) return ct;
    const b = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, 8);
    return FMP4_BOXES.has(String.fromCharCode(b[4], b[5], b[6], b[7])) ? 'video/mp4' : ct;
}

// Unwraps ONLY this server's own proxy shapes: /m3u8-proxy?url=, /ts-proxy?url=
// and /proxy/<encoded http url>. Matched by path on any host, like
// hybridStream.unwrapProxied: the public base the url was built on need not
// equal this request's. Any other url, even one with a `url=` param, is
// returned unchanged: VidBolt's dash-hls-bridge carries the CloudFront
// Policy/Signature/Key-Pair-Id beside its inner url, and keeping only the
// inner url made CloudFront answer 403 MissingKey (RRR 579974, 2026-11-21).
// Returns {url, headers}; headers are the wrapper's own, {} otherwise.
function extractOriginalUrl(proxyUrl) {
    const plain = { url: proxyUrl, headers: {} };
    let url;
    try { url = new URL(proxyUrl); } catch { return plain; }
    const pathMatch = url.pathname.match(/\/proxy\/(.+)$/);
    if (pathMatch) {
        let decoded = pathMatch[1];
        try { decoded = decodeURIComponent(decoded); } catch { return plain; }
        while (decoded.includes('%2F')) {
            try { decoded = decodeURIComponent(decoded); } catch { break; }
        }
        // A bare path (like Vidlink /proxy/wiwii/...) is someone else's route.
        return /^https?:\/\//i.test(decoded) ? { url: decoded, headers: {} } : plain;
    }
    if (!/\/(m3u8-proxy|ts-proxy)$/.test(url.pathname)) return plain;
    const inner = url.searchParams.get('url');
    if (!inner || !/^https?:\/\//i.test(inner)) return plain;
    let headers = {};
    try {
        const parsed = JSON.parse(url.searchParams.get('headers') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed;
    } catch { /* wrapper without readable headers */ }
    return { url: inner, headers };
}

// `ptsOffset` routes SEGMENTS through /pts-rebase instead of /ts-proxy, so a
// hybrid's borrowed audio can be shifted onto the video provider's timeline.
// Zero (the normal case) leaves every url exactly as before.
// `seg=1` marks every key, init and segment url emitted from a playlist.
// /ts-proxy never clamps those to the open window: a segment can have any
// extension (or none) and exceed 4MB, and hls.js does not resume a partial one.
// A query value needs only `&`, `#`, `%`, `+` and non-URL bytes escaped.
// encodeURIComponent also escapes `/ : ? = @ , ;`, which grew every long
// signed segment url by ~50% (multimovies 708 -> 1,066 bytes per line).
// Both WHATWG URLSearchParams and express's qs decode the result to the
// exact same string (test/playlistSize.test.js).
function encodeQueryValue(v) {
    return encodeURIComponent(v).replace(/%(2F|3A|3F|3D|40|2C|3B)/g, (m) => decodeURIComponent(m));
}

// Segment, key and init lines: lightly encoded url + a short header token
// (lib/routing/headerTokens.js) in place of the row's headers as JSON on
// every line. /ts-proxy still accepts the old `headers=` form, so a player
// holding a playlist rewritten before this change keeps working.
function tsProxyLine(baseProxyUrl, absUrl, headers) {
    const id = headerTokens.put(headers);
    return `${baseProxyUrl}/ts-proxy?url=${encodeQueryValue(absUrl)}${id ? `&h=${id}` : ''}&seg=1`;
}

// CODECS for a proxied master's #EXT-X-STREAM-INF lines.
//
// Without CODECS, ExoPlayer cannot prepare chunkless and hls.js probes: both
// download a chunk of the first variant and of every audio rendition before
// the first frame (multimovies RCA, 2026-11-21: ~9 s). An upstream CODECS is
// always kept verbatim. A missing one is filled ONLY from a value the server
// already holds for this row (stream.codecs, carried as `&codecs=`), and only
// when that value is a valid RFC 6381 list naming BOTH a video and an audio
// codec: a video-only CODECS on a muxed variant makes a player drop the audio
// track, which would lose audio to save latency. Never a guessed default.
const VIDEO_CODEC_RE = /^(avc1|avc3|hvc1|hev1|dvh1|dvhe|av01|vp09|vp08|mp4v)\b/i;
const AUDIO_CODEC_RE = /^(mp4a|ac-3|ec-3|ac-4|opus|flac|mp3|dtsc|dtse|dtsx)\b/i;
function completeCodecs(value) {
    const s = String(value || '').trim();
    if (!s || s.length > 200 || !/^[A-Za-z0-9.\-]+(\s*,\s*[A-Za-z0-9.\-]+)*$/.test(s)) return null;
    const list = s.split(',').map((c) => c.trim());
    if (!list.some((c) => VIDEO_CODEC_RE.test(c)) || !list.some((c) => AUDIO_CODEC_RE.test(c))) return null;
    return list.join(',');
}

function rewriteM3u8(content, targetUrl, baseProxyUrl, headers, ptsOffset = 0, opts = {}) {
    const segRoute = ptsOffset ? 'pts-rebase' : 'ts-proxy';
    const segExtra = ptsOffset ? `&pts=${ptsOffset}` : '';
    const lines = content.split('\n');
    const out = []; const segmentUrls = [];
    // A URL line that FOLLOWS #EXT-X-STREAM-INF is a variant playlist, whatever
    // it is named. showsst serves its variants as `.../api?d=<blob>` with no
    // .m3u8 anywhere in the URL, so extension-matching alone sent a PLAYLIST
    // through ts-proxy: hls.js then got playlist text where it expected
    // MPEG-TS, reported duration 0:00 and spun forever, while the segment URLs
    // inside it were never rewritten and went to the origin raw (403).
    // Measured 2026-09-22 on movie/1408162.
    let afterStreamInf = false;
    const knownCodecs = completeCodecs(opts.knownCodecs);
    let codecsKept = 0; let codecsAdded = 0; let codecsMissing = 0;
    for (const line of lines) {
        if (line.startsWith('#')) {
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                afterStreamInf = true;
                if (/(^|[:,])CODECS=/.test(line)) codecsKept++;
                else if (knownCodecs) {
                    out.push(`${line.replace(/\r$/, '')},CODECS="${knownCodecs}"`);
                    codecsAdded++;
                    continue;
                } else codecsMissing++;
            }
            if (line.startsWith('#EXT-X-KEY:')) {
                const regex = /https?:\/\/[^""\s]+/g; const keyUrl = regex.exec(line)?.[0];
                if (keyUrl) {
                    const proxyUrl = tsProxyLine(baseProxyUrl, keyUrl, headers);
                    out.push(line.replace(keyUrl, proxyUrl));
                    if (!isCacheDisabled()) prefetchSegment(keyUrl, headers);
                } else out.push(line);
            } else if (line.startsWith('#EXT-X-MAP:')) {
                // fMP4 init segment. Left raw, the browser fetched it without
                // the CDN's required Referer (403) and the stream never
                // started: mapple on 1376856, prod 2026-11-15.
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch) {
                    try {
                        const initUrl = new URL(uriMatch[1], targetUrl).href;
                        const proxyUrl = tsProxyLine(baseProxyUrl, initUrl, headers);
                        out.push(line.replace(uriMatch[1], proxyUrl));
                    } catch { out.push(line); }
                } else out.push(line);
            } else if (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (uriMatch) {
                    try {
                        const mediaUrl = new URL(uriMatch[1], targetUrl).href;
                        const proxyUrl = `${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(mediaUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
                        out.push(line.replace(uriMatch[1], proxyUrl));
                    } catch { out.push(line); }
                } else out.push(line);
            } else out.push(line);
        } else if (line.trim()) {
            // The flag applies to THIS url line only; a master lists several
            // variants, and leaving it set would treat every later segment in
            // a media playlist as a playlist too.
            const isVariant = afterStreamInf;
            afterStreamInf = false;
            try {
                const abs = new URL(line, targetUrl).href;
                if (isVariant || /\.m3u8(\?|$)/i.test(abs)) {
                    out.push(`${baseProxyUrl}/m3u8-proxy?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(JSON.stringify(headers))}`);
                } else {
                    // Any non-playlist line in an m3u8 body is a media segment,
                    // whatever its extension. Several providers disguise
                    // segments as .jpg/.png (Castle, OneTouchTV) or use bare
                    // relative names (NetMirror's 2560_000.jpg). Matching only
                    // .ts left those emitted raw, so the browser fetched them
                    // cross-origin (CORS error) or resolved them against
                    // /m3u8-proxy (404) - which is why a proxied stream still
                    // would not play.
                    segmentUrls.push(abs);
                    out.push(ptsOffset
                        ? `${baseProxyUrl}/${segRoute}?url=${encodeURIComponent(abs)}&headers=${encodeURIComponent(JSON.stringify(headers))}${segExtra}&seg=1`
                        : tsProxyLine(baseProxyUrl, abs, headers));
                }
            } catch { out.push(line); }
        } else out.push(line);
    }
    if (codecsKept + codecsAdded + codecsMissing) {
        console.log(`[m3u8-proxy] codecs: kept=${codecsKept} added=${codecsAdded} missing=${codecsMissing}`
            + (codecsAdded ? ` value=${knownCodecs}` : (opts.knownCodecs && !knownCodecs ? ' known=rejected' : '')));
    }
    if (segmentUrls.length && !isCacheDisabled()) {
        // Prefetch only the first few segments, and never more than a couple at
        // a time. This used to fan out over every line in the playlist, which
        // for a feature-length stream means hundreds of concurrent fetches: the
        // socket pool fills with speculative work and the segment the player is
        // actually waiting on never gets a connection, so playback just hangs.
        // Warming the opening segments is the only part that helps startup.
        const warm = segmentUrls.slice(0, PREFETCH_MAX);
        console.log(`[prefetch] playlist had ${segmentUrls.length} segments, warming ${warm.length}`);
        (async () => {
            for (let i = 0; i < warm.length; i += PREFETCH_CONCURRENCY) {
                await Promise.all(warm.slice(i, i + PREFETCH_CONCURRENCY).map(u => prefetchSegment(u, headers)));
            }
        })().catch(() => undefined);
    }
    return out.join('\n');
}

// resp.body.pipe(res) alone is a hang waiting to happen: if the upstream body
// stalls or errors after the headers arrived, nothing ends the client response
// and the browser sits on (pending) until hls.js cancels the segment. Pipe
// through this instead so an upstream failure, or a client that walks away,
// always tears both sides down.
// ts-proxy cache policy. The Vercel edge in front of /ts-proxy keys its cache
// on the URL alone and ignores Range, so a cacheable 206 for bytes 0-65535
// was later replayed for a seek to a 500MB offset (x-vercel-cache: HIT,
// Content-Range bytes 0-65535). The mp4 could not seek and a NetMirror switch
// hung ~12s then aborted. Measured 2026-11-20. A partial response, or any
// answer to a Range request, is therefore never stored by a shared cache.
// A full non-range 200 is the same bytes for every caller and stays cacheable.
function mediaCacheControl(req, status) {
    return (req.headers.range || status === 206) ? 'private, no-store' : 'public, max-age=3600';
}

function pipeUpstream(resp, res, label) {
    const body = resp.body;
    if (!body) { res.end(); return; }
    // The client can hang up while the upstream headers are in flight. Its
    // 'close' event has then already fired, so the res.on('close') below would
    // never run and only the 25 s stall watchdog freed the socket. VM logs
    // 2026-11-20..24: 104 of 115 "stalled" lines followed a CLIENT ABORTED.
    if (res.destroyed || res.closed || res.writableEnded) {
        console.log(`[proxy] client gone, upstream cancelled (${label}, before pipe)`);
        discardBody(resp);
        return;
    }
    let settled = false;
    // Only a body that did NOT drain normally may be destroyed. Destroying one
    // that read to completion tears down the keep-alive socket instead of
    // returning it to the agent's free list, so the pool fills with sockets
    // that are alive but unreusable: active climbed 1 -> 31 across ~97 requests
    // and never came back down. A clean end must simply be left alone.
    const cleanup = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
            console.warn(`[${label}] upstream body failed: ${err.message}`);
            if (!res.headersSent) res.status(502).json({ error: `upstream body failed: ${err.message}` });
            else res.destroy(err);
        }
        // Reached only when the body never ended: an error, or a client that
        // hung up mid-stream. Both leave bytes in flight that nobody will read.
        // discardBody aborts the request too: destroying the body alone kept
        // the socket checked out (hls.js cancels segments on every seek).
        discardBody(resp);
    };
    // A body that simply STOPS sending - no error, no end, no client hangup -
    // was the remaining leak: cleanup() only ran on error or close, so the
    // socket stayed checked out of the agent forever. With maxSockets=64 the
    // pool wedged at active=65 queued=14 free=0 and never drained, after which
    // every provider timed out at exactly PROXY_BODY_TIMEOUT_MS and Castle
    // silently returned 0 streams until a restart. Measured 2026-09-22.
    //
    // The watchdog is reset by PROGRESS, not armed once: a large segment may
    // legitimately take minutes to stream, but it must never go quiet for
    // longer than the stall window.
    let stallTimer = null;
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    const armStall = () => {
        clearStall();
        stallTimer = setTimeout(() => {
            if (settled) return;
            // A stall only counts while someone is still waiting for the bytes.
            if (res.destroyed || res.closed) {
                console.log(`[proxy] client gone, upstream cancelled (${label}, idle)`);
                cleanup();
                return;
            }
            console.warn(`[${label}] upstream body stalled ${BODY_STALL_MS}ms, dropping`);
            cleanup(new Error('upstream body stalled'));
        }, BODY_STALL_MS);
    };

    // Register end/error before pipe() so a body that drains immediately cannot
    // settle before we are listening.
    body.on('data', armStall);
    body.on('end', () => { settled = true; clearStall(); });
    body.on('error', (e) => { clearStall(); cleanup(e); });
    res.on('close', () => {
        clearStall();
        if (!settled) console.log(`[proxy] client gone, upstream cancelled (${label}, mid-body)`);
        cleanup();
    });
    armStall();
    body.pipe(res);
}

let tsProxySeq = 0;
let m3u8Seq = 0;

// Listeners told the upstream status of each /m3u8-proxy fetch. apiServer
// feeds it to the provider registry so a master 404 on a provider's own host
// counts toward its heal (A3, vidrift host move 2026-11-21).
const upstreamStatusListeners = new Set();
function onUpstreamStatus(fn) { upstreamStatusListeners.add(fn); return () => upstreamStatusListeners.delete(fn); }
function noteUpstreamStatus(url, status) {
    for (const fn of upstreamStatusListeners) {
        try { fn(url, status); } catch (e) { console.warn(`[proxy] status listener failed: ${e.message}`); }
    }
}

// Rate telemetry. A runaway client loop is only visible as a RATE and as a
// repeat-count per URL - a per-request line just buries it. Summarise every
// 10s and stay silent when nothing moved.
const rateStats = { ts: 0, m3u8: 0, urls: new Map() };
function noteProxyHit(kind, url) {
    rateStats[kind] += 1;
    const k = String(url || '').slice(0, 100);
    rateStats.urls.set(k, (rateStats.urls.get(k) || 0) + 1);
}
setInterval(() => {
    if (!rateStats.ts && !rateStats.m3u8) return;
    const top = [...rateStats.urls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const dup = top.filter(([, n]) => n > 1);
    console.log(`[proxy-rate] 10s: ts=${rateStats.ts} m3u8=${rateStats.m3u8} distinct=${rateStats.urls.size}`
        + (dup.length ? ` REPEATS: ${dup.map(([u, n]) => `${n}x ${u.slice(-60)}`).join(' | ')}` : ' (no repeats)'));
    rateStats.ts = 0; rateStats.m3u8 = 0; rateStats.urls.clear();
}, 10000).unref();

function createProxyRoutes(app) {
    // m3u8 playlist proxy
    app.get('/m3u8-proxy', cors(), playlistCompression(), async (req, res) => {
        const mId = (m3u8Seq = (m3u8Seq + 1) % 100000);
        const m_t0 = Date.now();
        const mstage = (n) => console.log(`[m3u8-proxy#${mId}] ${n} +${Date.now() - m_t0}ms`);
        noteProxyHit('m3u8', req.query.url);
        mstage('enter');
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) { mstage('CLIENT ABORTED'); gone.abort(); } });
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });
        let headers = {};
        try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        try {
            const coolingUntil = throttledUntil(targetUrl);
            if (coolingUntil) {
                const waitMs = coolingUntil - Date.now();
                mstage(`skipped, host cooling down ${waitMs}ms`);
                return res.status(503).json({
                    error: 'upstream rate limited',
                    host: hostOf(targetUrl),
                    retryAfterMs: waitMs,
                });
            }
            const deadStatus = deadStatusFor(targetUrl);
            if (deadStatus) {
                mstage(`skipped, url already failed ${deadStatus}`);
                return res.status(deadStatus).json({
                    error: `M3U8 fetch failed: ${deadStatus}`,
                    reason: 'this link has expired; resolve the title again',
                });
            }
            mstage(`upstream fetch start ${targetUrl.slice(0, 80)}`);
            const response = await fetchWithTimeout(targetUrl, { signal: gone.signal, headers: { 'User-Agent': DEFAULT_UA, ...headers } });
            mstage(`upstream headers status=${response.status}`);
            noteUpstreamStatus(targetUrl, response.status);
            if (!response.ok) {
                discardBody(response);
                noteThrottle(targetUrl, response.status);
                noteDeadUrl(targetUrl, response.status);
                return res.status(response.status).json({ error: `M3U8 fetch failed: ${response.status}` });
            }
            urlStrikes.delete(String(targetUrl));
            const text = await readBodyWithTimeout(response, BODY_STALL_MS, 'text');
            mstage(`body read ${text.length}b`);
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            const baseProxyUrl = publicBase(req, protocol);
            // A hybrid's audio playlist carries `rebase=1&pts=<n>`; everything
            // else rewrites exactly as before.
            const ptsOffset = req.query.rebase === '1' ? (Number(req.query.pts) || 0) : 0;
            const rewritten = rewriteM3u8(text, targetUrl, baseProxyUrl, headers, ptsOffset,
                { knownCodecs: req.query.codecs });
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(rewritten);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ts / key segment proxy
    app.get('/ts-proxy', cors(), async (req, res) => {
        const reqId = (tsProxySeq = (tsProxySeq + 1) % 100000);
        noteProxyHit('ts', req.query.url);
        const t_enter = Date.now();
        const stage = (name) => console.log(`[ts-proxy#${reqId}] ${name} +${Date.now() - t_enter}ms`);
        stage('enter');
        // Byte totals are what distinguish ordinary playback from a client
        // re-fetching the same segments: request counts alone look identical.
        let bytesOut = 0;
        const origWrite = res.write.bind(res);
        res.write = (chunk, ...rest) => { if (chunk) bytesOut += chunk.length; return origWrite(chunk, ...rest); };
        // Abort every upstream fetch this request started once the browser is
        // gone. Logging the abort was not enough: the fetch kept its pool slot
        // for the full BODY_TIMEOUT_MS, which is what wedged the agent.
        const gone = new AbortController();
        res.on('close', () => {
            stage(`${res.writableEnded ? 'client done' : 'CLIENT ABORTED'} bytes=${bytesOut} url=${String(req.query.url || '').slice(0, 120)}`);
            if (!res.writableEnded) gone.abort();
        });
        res.on('finish', () => stage(`finish bytes=${bytesOut}`));
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });
        const debug = req.query.debug === '1';
        const noSynth = req.query.noSynth === '1';
        const force200 = req.query.force200 === '1';
        const clampOpen = req.query.clampOpen !== '0';
        const progressiveOpen = req.query.progressiveOpen !== '0';
        const tailPrefetchEnabled = req.query.tailPrefetch !== '0';
        let tailPrefetchKB = parseInt(req.query.tailPrefetchKB || '256', 10);
        if (isNaN(tailPrefetchKB) || tailPrefetchKB < 64) tailPrefetchKB = 256;
        if (tailPrefetchKB > 2048) tailPrefetchKB = 2048; // max 2MB tail window
        let openChunkKB = parseInt(req.query.openChunkKB || '4096', 10);
        if (isNaN(openChunkKB) || openChunkKB < 64) openChunkKB = 4096;
        if (openChunkKB > 16384) openChunkKB = 16384; // cap at 16MB
        let initChunkKB = parseInt(req.query.initChunkKB || '512', 10);
        if (isNaN(initChunkKB) || initChunkKB < 64) initChunkKB = 512;
        if (initChunkKB > 2048) initChunkKB = 2048; // hard cap 2MB
        let headers = {}; try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        // A playlist line written by tsProxyLine carries `h=<token>`. An
        // unknown token cannot be guessed: fetching bare would only earn an
        // upstream 403 later, so say what happened.
        if (req.query.h) {
            const known = headerTokens.get(req.query.h);
            if (!known) {
                stage(`unknown header token h=${String(req.query.h).slice(0, 32)}`);
                return res.status(410).json({ error: 'unknown header token', reason: 'reload the playlist' });
            }
            headers = { ...known, ...headers };
        }
        // Pass through Range header for progressive playback / seeking
        const range = req.headers['range'];
        let appliedClamp = false;
        let effectiveRange = range;
        if (range) headers.Range = range;
        // An HLS segment, playlist or key is small and fetched whole. Anything
        // else is a progressive media body (NetMirror serves a whole .mp4).
        // .woff2: VIDOUT names its MPEG-TS segments as fonts (2026-11-24).
        const looksLikeHlsSegment = /\.(ts|jpg|jpeg|png|js|m4s|aac|woff2?)(\?|$)/i.test(String(targetUrl));
        const looksLikeSmallHlsFile = looksLikeHlsSegment || /\.(m3u8|key|vtt|srt)(\?|$)/i.test(String(targetUrl));
        // A no-Range request for a progressive body gets the same bounded first
        // window as bytes=0-. Unclamped, it pulled the whole NetMirror mp4
        // (hundreds of MB) through Node: the client aborted after ~12s with
        // 100-550MB sent, and pm2 restarted the API at 876687360 bytes against
        // its 524288000 limit, five times on 2026-11-20. The 206 + Content-Range
        // makes the player continue with range requests.
        // A url emitted from a playlist (seg=1) is always fetched whole.
        const fromPlaylist = req.query.seg === '1';
        const noRangeProgressive = !range && !fromPlaylist && !looksLikeSmallHlsFile && !noSynth;
        // Clamp first open-ended bytes=0- request to a bounded span (once per TTL) to avoid gigantic initial 206
        if ((noRangeProgressive || (range && /^bytes=0-\s*$/i.test(range))) && !force200) {
            const now = Date.now();
            // Progressive growth supersedes single-shot clamp if enabled
            if (progressiveOpen) {
                const prog = progressiveOpenMap.get(targetUrl) || { lastEnd: -1, grow: true };
                const prevEnd = prog.lastEnd;
                let nextEnd;
                if (prog.lastEnd < 0) {
                    nextEnd = openChunkKB * 1024 - 1;
                } else if (prog.grow) {
                    const increment = openChunkKB * 1024;
                    nextEnd = prog.lastEnd + increment;
                    const maxCap = 256 * 1024 * 1024 - 1; // 256MB
                    if (nextEnd > maxCap) nextEnd = maxCap;
                } else {
                    // The previous window was ABANDONED by the client, so
                    // widening it fetches more of what nobody read. Measured
                    // 2026-09-23 on a NetMirror mp4: bytes=0- probes from
                    // hls.js aborted 8 times to 2 completions, and because the
                    // window grew on every one of them regardless, a single
                    // request pulled 41218136 bytes upstream and threw all of
                    // it away. That discarded traffic - not Node - is what
                    // pushed `main fetch headers` from 597ms to 4337ms.
                    //
                    // Progressive growth assumes a file being read linearly.
                    // A player that probes and closes is the opposite, so hold
                    // the window until a client actually drains one.
                    nextEnd = prog.lastEnd;
                }
                const newRange = `bytes=0-${nextEnd}`;
                headers.Range = newRange;
                effectiveRange = newRange;
                prog.lastEnd = nextEnd;
                prog.grow = false; // set true again only once this response is fully read
                progressiveOpenMap.delete(targetUrl);
                progressiveOpenMap.set(targetUrl, prog);
                while (progressiveOpenMap.size > PROGRESSIVE_MAP_MAX) {
                    progressiveOpenMap.delete(progressiveOpenMap.keys().next().value);
                }
                // Re-arm growth only on a response the client read to the end.
                res.on('close', () => {
                    const cur = progressiveOpenMap.get(targetUrl);
                    if (cur === prog) prog.grow = Boolean(res.writableEnded);
                });
                appliedClamp = true; // reuse flag for logging
                if (debug) console.log('[ts-proxy] progressiveOpen', { prevEnd, nextEnd, grew: nextEnd !== prevEnd });
            } else if (clampOpen) {
                const lastTs = openRangeClampMap.get(targetUrl);
                if (!lastTs || (now - lastTs) > OPEN_RANGE_CLAMP_TTL_MS) {
                    const clampBytes = openChunkKB * 1024;
                    const newRange = `bytes=0-${clampBytes - 1}`;
                    headers.Range = newRange;
                    effectiveRange = newRange;
                    openRangeClampMap.set(targetUrl, now);
                    appliedClamp = true;
                }
            }
        }
        if (debug) console.log('[ts-proxy] incoming', { url: targetUrl, range, effectiveRange, appliedClamp, clampOpen, progressiveOpen, openChunkKB, noSynth, initChunkKB, force200, tailPrefetchEnabled, tailPrefetchKB });
        if (!isCacheDisabled()) {
            const cached = getCachedSegment(targetUrl);
            if (cached) {
                const ct = sniffSegmentType(inferContentType(cached.headers['content-type'], targetUrl), cached.data);
                res.setHeader('Content-Type', ct);
                res.setHeader('Cache-Control', mediaCacheControl(req, res.statusCode));
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Accept-Ranges', 'bytes');
                if (debug) console.log('[ts-proxy] cache hit');
                return res.send(Buffer.from(cached.data));
            }
        }
        try {
            // If we have a tail prefetch entry and the client requests a tail range fully inside it, serve from memory early.
            if (effectiveRange && /^bytes=\d+-$/i.test(effectiveRange)) {
                const tailEntry = tailPrefetchMap.get(targetUrl);
                if (tailEntry) {
                    const m = effectiveRange.match(/bytes=(\d+)-/i);
                    if (m) {
                        const startReq = parseInt(m[1], 10);
                        if (!isNaN(startReq) && startReq >= tailEntry.start && startReq <= tailEntry.end) {
                            const offset = startReq - tailEntry.start;
                            const slice = tailEntry.data.subarray(offset);
                            const endByte = tailEntry.end;
                            res.status(206);
                            const ct = inferContentType(null, targetUrl);
                            res.setHeader('Content-Type', ct);
                            res.setHeader('Accept-Ranges', 'bytes');
                            res.setHeader('Content-Length', slice.length.toString());
                            res.setHeader('Content-Range', `bytes ${startReq}-${endByte}/${tailEntry.size}`);
                            res.setHeader('Cache-Control', mediaCacheControl(req, res.statusCode));
                            res.setHeader('Access-Control-Allow-Origin', '*');
                            if (debug) console.log('[ts-proxy] tail serve hit', { startReq, cachedStart: tailEntry.start, cachedEnd: tailEntry.end, size: tailEntry.size });
                            return res.end(slice);
                        }
                    }
                }
            }

            // HEAD preflight (only when no explicit Range requested) to get size for synthesized partial response.
            //
            // This whole preamble (HEAD + range probe + tail prefetch) exists to
            // synthesize seek support for a single large file. An HLS segment is
            // a few hundred KB fetched start-to-finish and never seeked within,
            // so for those the probes are pure amplification: measured 268
            // upstream calls for 105 segment requests, 2.6x per segment, which
            // is what floods the network tab and the socket pool. Skip them for
            // anything served out of a playlist and just stream the bytes.
            let contentLength = null;
            let upstreamAcceptRanges = null;
            if (!effectiveRange && !looksLikeHlsSegment) {
                try {
                    stage('HEAD start');
                    const headResp = await fetchWithTimeout(targetUrl, { signal: gone.signal, method: 'HEAD', headers: { 'User-Agent': DEFAULT_UA, ...headers } }, PROBE_TIMEOUT_MS);
                    if (headResp.ok) {
                        contentLength = headResp.headers.get('content-length');
                        upstreamAcceptRanges = headResp.headers.get('accept-ranges');
                        if (debug) console.log('[ts-proxy] HEAD ok', { contentLength, upstreamAcceptRanges });
                    } else if (debug) {
                        console.log('[ts-proxy] HEAD status', headResp.status);
                    }
                    // Only the HEADERS are wanted here either way. node-fetch
                    // still hands back a body object and holds the socket until
                    // it settles, so release it explicitly rather than relying
                    // on a HEAD having nothing to send.
                    discardBody(headResp);
                } catch (_e) { if (debug) console.log('[ts-proxy] HEAD failed'); }
            }

            // Fallback probe: if still no size, attempt a 0-0 range request to derive total size from Content-Range.
            // Skipped for playlist segments for the same reason as the HEAD
            // above: with HEAD gone contentLength is always null here, so
            // without this guard the probe fires on every single segment.
            if (!effectiveRange && !contentLength && !looksLikeHlsSegment) {
                try {
                    const probeRange = 'bytes=0-0';
                    if (debug) console.log('[ts-proxy] probe range');
                    stage('probe start');
                    const probeResp = await fetchWithTimeout(targetUrl, { signal: gone.signal, headers: { 'User-Agent': DEFAULT_UA, ...headers, 'Range': probeRange } }, PROBE_TIMEOUT_MS);
                    if (probeResp.status === 206) {
                        const cr = probeResp.headers.get('content-range');
                        if (cr) {
                            const m = cr.match(/\/(\d+)$/); if (m) contentLength = m[1];
                        }
                        try { await readBodyWithTimeout(probeResp); } catch (readErr) {
                            if (debug) console.log('[ts-proxy] probe body read failed', readErr.message);
                        }
                        if (debug) console.log('[ts-proxy] probe success', { contentLength });
                    } else {
                        // A 200 here is the WHOLE file (the origin ignored
                        // Range). Unread, it holds a pooled socket until the
                        // origin gives up, which can be hours.
                        discardBody(probeResp);
                        if (debug) console.log('[ts-proxy] probe status', probeResp.status);
                    }
                } catch (_e) { if (debug) console.log('[ts-proxy] probe failed'); }
            }
            if (debug && contentLength) console.log('[ts-proxy] size determined', contentLength);

            // Initiate tail prefetch asynchronously (once) when size known and feature enabled
            if (tailPrefetchEnabled && contentLength && !tailPrefetchMap.has(targetUrl)) {
                const total = parseInt(contentLength, 10);
                if (!isNaN(total) && total > 0) {
                    const tailBytes = Math.min(tailPrefetchKB * 1024, total);
                    const start = Math.max(0, total - tailBytes);
                    const tailRange = `bytes=${start}-`;
                    (async () => {
                        try {
                            if (debug) console.log('[ts-proxy] tail prefetch start', { tailRange });
                            stage('tail start');
                            const tr = await fetchWithTimeout(targetUrl, { signal: gone.signal, headers: { 'User-Agent': DEFAULT_UA, ...headers, Range: tailRange } }, PROBE_TIMEOUT_MS);
                            if (tr.status === 206) {
                                const buf = Buffer.from(await readBodyWithTimeout(tr));
                                const cr = tr.headers.get('content-range');
                                if (cr) {
                                    const mm = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
                                    if (mm) {
                                        const s = parseInt(mm[1], 10); const e = parseInt(mm[2], 10); const sz = parseInt(mm[3], 10);
                                        if (!isNaN(s) && !isNaN(e) && !isNaN(sz)) {
                                            tailPrefetchMap.set(targetUrl, { data: buf, start: s, end: e, size: sz, ts: Date.now() });
                                            if (debug) console.log('[ts-proxy] tail prefetch success', { start: s, end: e, bytes: buf.length });
                                        }
                                    }
                                }
                            } else {
                                discardBody(tr);
                                if (debug) console.log('[ts-proxy] tail prefetch status', tr.status);
                            }
                        } catch (e) { if (debug) console.log('[ts-proxy] tail prefetch error', e.message); }
                    })();
                }
            }

            // If no range requested but we now know size (HEAD or probe), synthesize an initial small range fetch to accelerate playback.
            if (!force200 && !effectiveRange && contentLength && !noSynth && req.query.progressiveOpen === '0') {
                const total = parseInt(contentLength, 10);
                const desired = initChunkKB * 1024;
                const chunkSize = Math.min(desired, Math.max(0, total - 1));
                const syntheticRange = `bytes=0-${chunkSize}`;
                const resp = await fetchWithTimeout(targetUrl, { signal: gone.signal, headers: { 'User-Agent': DEFAULT_UA, ...headers, 'Range': syntheticRange } });
                if (resp.status === 206) {
                    if (debug) console.log('[ts-proxy] synthetic 206', syntheticRange);
                    const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
                    res.status(206);
                    res.setHeader('Content-Type', upstreamCT);
                    res.setHeader('Accept-Ranges', upstreamAcceptRanges || 'bytes');
                    const contentRange = resp.headers.get('content-range');
                    if (contentRange) res.setHeader('Content-Range', contentRange);
                    const cl = resp.headers.get('content-length'); if (cl) res.setHeader('Content-Length', cl);
                    res.setHeader('Cache-Control', mediaCacheControl(req, res.statusCode));
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    // Pipe first chunk then leave connection open? Simpler: end after chunk; player will request next range.
                    return pipeUpstream(resp, res, `ts-proxy#${reqId}`);
                }
                // If server ignored range (e.g., returned 200), fall through to normal logic below.
                // That response is not used, so release its socket now.
                discardBody(resp);
            }

            const cfCookie = cfCookieFor(targetUrl);
            const cfUa = process.env.CF_CLEARANCE_UA;
            const upstreamOptions = {
                // The client hanging up must cancel this fetch too. Every other
                // fetch in this route passed gone.signal; this one did not.
                signal: gone.signal,
                headers: {
                    'User-Agent': DEFAULT_UA,
                    ...headers,
                    // A cf_clearance cookie is only accepted alongside the exact
                    // User-Agent that solved the challenge, so it overrides both.
                    ...(cfCookie ? { Cookie: [headers.Cookie, cfCookie].filter(Boolean).join('; ') } : {}),
                    ...(cfCookie && cfUa ? { 'User-Agent': cfUa } : {})
                }
            };
            // If client supplied a suffix range like bytes=0- we pass it; force200 strips Range
            if (force200 && headers.Range) delete headers.Range;
            stage('main fetch start');
            const resp = await fetchWithTimeout(targetUrl, upstreamOptions);
            stage(`main fetch headers status=${resp.status}`);
            if (!resp.ok && resp.status !== 206) {
                // One greppable line per upstream 403 (vercetti, CloudFront...):
                // host and path only, no query string, so no signing tokens.
                if (resp.status === 403) {
                    let head = '';
                    try { head = (await readBodyWithTimeout(resp, 2000, 'text')).slice(0, 200); } catch { /* body unreadable */ }
                    let where = 'upstream';
                    try { const u = new URL(targetUrl); where = `host=${u.host} path=${u.pathname}`; } catch { /* bad url */ }
                    console.log(`[ts-proxy-403] ${where} status=403 ct=${resp.headers.get('content-type') || '-'} server=${resp.headers.get('server') || '-'} body=${JSON.stringify(head)}`);
                }
                // Highest-traffic leak of the three: this is the SEGMENT route,
                // so one abandoned body per failed segment drains the pool fast.
                discardBody(resp);
                if (isCloudflareChallenge(resp)) {
                    const host = (() => { try { return new URL(targetUrl).hostname; } catch { return 'upstream'; } })();
                    console.log(`[ts-proxy#${reqId}] cloudflare challenge from ${host}${cfCookie ? ' (cf_clearance was sent and rejected)' : ' (no cf_clearance configured)'}`);
                    return res.status(403).json({
                        error: 'cloudflare_challenge',
                        host,
                        detail: cfCookie
                            ? 'The configured cf_clearance cookie was rejected - it has expired, or was minted by a different IP/User-Agent.'
                            : `${host} requires a browser-solved Cloudflare challenge. Set cfClearance in utils/user-config.json to play this source.`
                    });
                }
                if (debug) console.log('[ts-proxy] upstream error', resp.status);
                return res.status(resp.status).json({ error: `TS fetch failed: ${resp.status}` });
            }
            // Forward partial content status when range used
            if (effectiveRange && resp.status === 206 && !force200) { res.status(206); if (debug) console.log('[ts-proxy] forwarding 206', { appliedClamp }); }
            if (force200 && resp.status === 206) {
                // Some origins still return 206 even without Range; normalize to 200 for players expecting full stream
                if (debug) console.log('[ts-proxy] normalizing 206 -> 200 due to force200');
            }
            // Copy key streaming headers
            const upstreamCT = inferContentType(resp.headers.get('content-type'), targetUrl);
            res.setHeader('Content-Type', upstreamCT);
            let cl = resp.headers.get('content-length');
            const crHeader = resp.headers.get('content-range');
            if (!cl && crHeader) {
                // Try to derive length from range span
                const m = crHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
                if (m) {
                    const start = parseInt(m[1], 10); const end = parseInt(m[2], 10);
                    if (!isNaN(start) && !isNaN(end)) cl = (end - start + 1).toString();
                }
            }
            if (cl) res.setHeader('Content-Length', cl);
            const acceptRanges = resp.headers.get('accept-ranges');
            if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges); else res.setHeader('Accept-Ranges', 'bytes');
            const contentRange = resp.headers.get('content-range'); if (contentRange && !force200) res.setHeader('Content-Range', contentRange);
            res.setHeader('Cache-Control', mediaCacheControl(req, res.statusCode));
            res.setHeader('Access-Control-Allow-Origin', '*');
            if (debug) console.log('[ts-proxy] streaming body', { status: resp.status, ct: upstreamCT, cl, contentRange: force200 ? undefined : contentRange });
            stage('piping body');
            pipeUpstream(resp, res, `ts-proxy#${reqId}`);
        } catch (e) {
            if (gone.signal.aborted) { console.log(`[proxy] client gone, upstream cancelled (ts-proxy#${reqId}, before headers)`); return; }
            if (debug) console.log('[ts-proxy] exception', e.message);
            if (!res.headersSent) res.status(500).json({ error: e.message });
        }
    });

    // subtitle proxy
    app.get('/sub-proxy', cors(), async (req, res) => {
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) gone.abort(); });
        const targetUrl = req.query.url; if (!targetUrl) return res.status(400).json({ error: 'url parameter required' });
        let headers = {}; try { headers = JSON.parse(req.query.headers || '{}'); } catch {
            // Ignore URL parsing errors
        }
        try {
            const resp = await fetchWithTimeout(targetUrl, { signal: gone.signal, headers: { 'User-Agent': DEFAULT_UA, ...headers } });
            if (!resp.ok) {
                discardBody(resp);
                return res.status(resp.status).json({ error: `subtitle fetch failed: ${resp.status}` });
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.setHeader('Content-Type', resp.headers.get('content-type') || 'text/vtt');
            pipeUpstream(resp, res, 'sub-proxy');
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

// Some upstreams (DahmerMovies' p.111477.xyz) sit behind a Cloudflare JS
// challenge. Node cannot solve it: the origin a.111477.xyz 307s into the
// protected worker, and the worker answers every server-side request with
// 403 + `cf-mitigated: challenge`, whatever headers we send. A browser solves
// it and is handed a `cf_clearance` cookie, so the only way through from here
// is to be given that cookie. CF_CLEARANCE maps hostname -> cookie string.
//
// The cookie is bound to the IP and User-Agent that solved the challenge, so
// it only works when this server shares the browser's public IP, and the UA
// must match the browser that minted it (set cfClearanceUserAgent).
function cfCookieFor(targetUrl) {
    let map = {};
    try { map = JSON.parse(process.env.CF_CLEARANCE || '{}'); } catch { return null; }
    let host = '';
    try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { return null; }
    for (const [key, cookie] of Object.entries(map)) {
        const k = String(key).toLowerCase();
        if (host === k || host.endsWith(`.${k}`)) return cookie;
    }
    return null;
}

// Cloudflare's challenge is an HTML page served with 403. Forwarding that body
// to a <video> element yields an opaque decode failure, so detect it and say
// what actually happened.
function isCloudflareChallenge(resp) {
    if (resp.headers.get('cf-mitigated') === 'challenge') return true;
    const server = (resp.headers.get('server') || '').toLowerCase();
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    return server.includes('cloudflare') && resp.status === 403 && ct.includes('text/html');
}

function processStreamsForProxy(streams, serverUrl) {
    if (!Array.isArray(streams)) return streams;
    return streams.map(s => {
        if (!s || !s.url || typeof s.url !== 'string') return s;
        // A synthetic master already points at this server and embeds proxied
        // child URLs of its own; wrapping it again would proxy the proxy.
        if (s.__noProxy) { const { __noProxy, ...rest } = s; return rest; }
        const { url: original, headers: wrapperHeaders } = extractOriginalUrl(s.url);
        const headers = (s.headers && Object.keys(s.headers).length) ? s.headers : wrapperHeaders;
        const hParam = Object.keys(headers).length ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : '';
        let host = '';
        try {
            host = new URL(original).hostname.toLowerCase();
        } catch {
            // Ignore errors
        }
        // Force specific hosts through ts-proxy (direct file style) even without extension
        if (host.includes('pixeldrain.') || host === 'video-downloads.googleusercontent.com') {
            return { ...s, url: `${serverUrl}/ts-proxy?url=${encodeURIComponent(original)}${hParam}` };
        }
        if (/\.(mp4|mkv)(\?|$)/i.test(original)) {
            return { ...s, url: `${serverUrl}/ts-proxy?url=${encodeURIComponent(original)}${hParam}` };
        }
        // The row's measured CODECS rides along so /m3u8-proxy can fill a
        // master that lacks it (see completeCodecs). Incomplete values are not sent.
        const known = completeCodecs(s.codecs);
        const cParam = known ? `&codecs=${encodeURIComponent(known)}` : '';
        return { ...s, url: `${serverUrl}/m3u8-proxy?url=${encodeURIComponent(original)}${hParam}${cParam}` };
    });
}

module.exports = {
    createProxyRoutes, processStreamsForProxy, rewriteM3u8, extractOriginalUrl,
    inferContentType, sniffSegmentType, completeCodecs,
    // Exposed for tests.
    _pipeUpstream: pipeUpstream,
    _agents: { http: httpAgent, https: httpsAgent },
    onUpstreamStatus,
    _segmentCache: { cacheSegment, getCachedSegment, stats: () => ({ entries: segmentCache.size, bytes: segmentCacheBytes, maxBytes: CACHE_MAX_BYTES }) },
};
