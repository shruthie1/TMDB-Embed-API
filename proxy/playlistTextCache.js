'use strict';
// Upstream playlist text for /m3u8-proxy, kept a few minutes.
//
// Why: measured 2026-11-24 in headless Chrome on chtrm2, RRR (insertunit)
// spent 1.5 s of its 6.3 s click->playing on two 289 KB playlists
// (index-v2, index-a7) that interkh serves in 0.55-1.45 s from the VM, every
// open. A VOD playlist never changes, so the second open (and, with
// warmPlaylists, the first one) reads it from memory.
//
// Only a master (#EXT-X-STREAM-INF) or a finished media playlist
// (#EXT-X-ENDLIST) is kept: a live playlist must be re-read. An entry never
// outlives the expiry signed into its url (lib/urlExpiry).
//
// The key is url + the exact headers object the client sends, so a row with a
// Referer and one without never share an entry.

const urlExpiry = require('../lib/urlExpiry');

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_BYTES = 24 * 1024 * 1024;
const EXPIRY_SKEW_MS = 60 * 1000;

const entries = new Map(); // key -> { text, until, bytes }
let bytes = 0;

function keyOf(url, headers) { return `${url}|${JSON.stringify(headers || {})}`; }

function cacheable(text) {
    const t = String(text || '');
    return t.trimStart().startsWith('#EXTM3U') && (/#EXT-X-STREAM-INF/.test(t) || /#EXT-X-ENDLIST/.test(t));
}

function drop(key) {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.bytes;
    entries.delete(key);
}

function get(url, headers, now = Date.now()) {
    const key = keyOf(url, headers);
    const e = entries.get(key);
    if (!e) return null;
    if (now >= e.until) { drop(key); return null; }
    return e.text;
}

function put(url, headers, text, now = Date.now()) {
    if (!cacheable(text)) return false;
    let until = now + TTL_MS;
    const exp = urlExpiry.urlExpiresAt(url, now);
    if (exp) until = Math.min(until, exp - EXPIRY_SKEW_MS);
    if (until <= now) return false;
    const size = Buffer.byteLength(text);
    if (size > MAX_BYTES / 4) return false;
    const key = keyOf(url, headers);
    drop(key);
    entries.set(key, { text, until, bytes: size });
    bytes += size;
    while (bytes > MAX_BYTES || entries.size > MAX_ENTRIES) drop(entries.keys().next().value);
    return true;
}

function stats() { return { entries: entries.size, bytes }; }
function _reset() { entries.clear(); bytes = 0; }

module.exports = { get, put, cacheable, keyOf, stats, _reset, TTL_MS, MAX_ENTRIES, MAX_BYTES };
