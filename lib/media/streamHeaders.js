// url -> request headers, remembered at resolve time.
//
// WHY THIS EXISTS
//
// A provider's URL is often only fetchable with that provider's own headers.
// mapple returns 404 for its 2160p master without Referer/Origin/User-Agent
// set to mapple.fun - measured 2026-09-23 on movie/1290190:
//
//   no-hdr    404  21b   {"error":"Not found"}
//   with-hdr  200  853b  #EXT-X-STREAM-INF:...,RESOLUTION=3840x2160
//
// /api/streams returns those headers in each stream object, but the player's
// pairSources() posts back only {url, provider, quality}. describeStream then
// fetched the mapple master bare, got the 404, returned null, and the pairing
// gate reported "the two sources disagree on runtime" - a wrong cause for what
// was actually a missing Referer. So mapple video could never be paired with
// CastleTV Telugu audio at all.
//
// The fix is deliberately NOT "let the client send headers". The server
// already resolved these streams and knows their headers first-hand; taking
// them back from the browser would both be redundant and let a caller aim
// arbitrary headers at an arbitrary host through our fetcher. Instead every
// resolved stream is recorded here on the way out, and /hybrid/pair fills in
// what the client could not send.
//
// Bounded and TTL'd: these are signed, short-lived CDN urls, so an entry that
// outlives its url is dead weight. The TTL is generous relative to the streams
// memo (10 min) because a viewer can sit on a title page before picking a
// language, and the pairing happens at that click, not at resolve.

const TTL_MS = Number(process.env.STREAM_HEADERS_TTL_MS) || 60 * 60 * 1000;
const MAX_ENTRIES = Number(process.env.STREAM_HEADERS_MAX) || 2000;

const store = new Map(); // url -> { headers, at }

function hasKeys(o) {
    return Boolean(o && typeof o === 'object' && Object.keys(o).length);
}

// Drop the oldest fifth when full, rather than clearing everything: a full
// flush would strand the pairing the viewer is in the middle of.
function evictIfNeeded() {
    if (store.size <= MAX_ENTRIES) return;
    const drop = Math.ceil(MAX_ENTRIES / 5);
    let n = 0;
    for (const k of store.keys()) {
        store.delete(k);
        if (++n >= drop) break;
    }
}

function remember(url, headers) {
    if (!url || !hasKeys(headers)) return;
    store.set(String(url), { headers: { ...headers }, at: Date.now() });
    evictIfNeeded();
}

// Record every stream in a resolve payload that carries headers.
function rememberStreams(streams) {
    if (!Array.isArray(streams)) return 0;
    let n = 0;
    for (const s of streams) {
        if (s && s.url && hasKeys(s.headers)) { remember(s.url, s.headers); n++; }
    }
    return n;
}

function headersFor(url) {
    const hit = store.get(String(url));
    if (!hit) return null;
    if (Date.now() - hit.at > TTL_MS) { store.delete(String(url)); return null; }
    return hit.headers;
}

// Return a copy of `stream` with headers filled in from the registry when the
// caller did not supply any. An explicit non-empty headers object always wins:
// a caller that went to the trouble of sending them knows something we may not.
function withKnownHeaders(stream) {
    if (!stream || !stream.url || hasKeys(stream.headers)) return stream;
    const known = headersFor(stream.url);
    if (!known) return stream;
    return { ...stream, headers: known };
}

module.exports = { remember, rememberStreams, headersFor, withKnownHeaders, _store: store };
