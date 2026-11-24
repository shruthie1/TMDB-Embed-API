'use strict';
// Audio languages written in an MPEG-TS segment's own PMT: the
// ISO_639_language_descriptor (tag 0x0a) on each audio elementary stream.
// This is the same field ffprobe reports as stream tag `language`, read from
// the first few KB of the first segment instead of a whole-file ffprobe run.
//
// Why: vidrock's single-variant servers (img*.fcxmb.com / img*.hscow.com) are
// a media playlist with no #EXT-X-MEDIA, so the manifest says nothing about
// audio. Each segment muxes five AAC tracks tagged hin/tam/tel/mal/kan
// (Jailer 937020, 2026-11-24). The vidrock API's `language` per server is not
// usable: the byte-identical file came back as Hindi, Kannada and Telugu.
//
// Only a tag counts. `und`/`mul`/`zxx`/missing = unknown, never guessed.

const { canonicalLanguage } = require('../../utils/streamSchema');
const { lookupWithFallback } = require('../../utils/dnsFallback');
const http = require('http');
const https = require('https');
const nodeFetch = require('node-fetch');

const TS_PACKET = 188;
// PAT and PMT sit in the first packets of an HLS segment. 200 packets is
// generous and still only 37.6 KB.
const HEAD_BYTES = TS_PACKET * 200;
const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30 * 60 * 1000;

// MPEG-TS stream_type values that are audio by themselves.
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x1c, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87]);
// stream_type 0x06 (private PES) is audio when one of these descriptors is on it:
// AC-3 0x6a, E-AC-3 0x7a, DTS 0x7b, AAC 0x7c, ATSC AC-3 0x81.
const AUDIO_DESCRIPTORS = new Set([0x6a, 0x7a, 0x7b, 0x7c, 0x81]);
const UNKNOWN = /^(und|mul|zxx|mis|qaa)$/i;

// Payload of one packet that starts a section (payload_unit_start), past the
// pointer field. null when the packet is not that.
function sectionPayload(buf, off) {
    if (buf[off] !== 0x47) return null;
    const pusi = (buf[off + 1] & 0x40) !== 0;
    if (!pusi) return null;
    const afc = (buf[off + 3] >> 4) & 0x3;
    if (!(afc & 0x1)) return null;
    let p = off + 4;
    if (afc === 0x3) p += 1 + buf[off + 4];
    if (p >= off + TS_PACKET) return null;
    p += 1 + buf[p]; // pointer_field
    return p < off + TS_PACKET ? buf.subarray(p, off + TS_PACKET) : null;
}

function pidOf(buf, off) {
    return ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
}

function parsePat(sec) {
    if (sec.length < 8 || sec[0] !== 0x00) return [];
    const len = ((sec[1] & 0x0f) << 8) | sec[2];
    const end = Math.min(sec.length, 3 + len - 4);
    const pmts = [];
    for (let i = 8; i + 4 <= end; i += 4) {
        const program = (sec[i] << 8) | sec[i + 1];
        if (program !== 0) pmts.push(((sec[i + 2] & 0x1f) << 8) | sec[i + 3]);
    }
    return pmts;
}

function parsePmt(sec) {
    if (sec.length < 12 || sec[0] !== 0x02) return null;
    const len = ((sec[1] & 0x0f) << 8) | sec[2];
    const end = Math.min(sec.length, 3 + len - 4);
    const progInfo = ((sec[10] & 0x0f) << 8) | sec[11];
    const out = [];
    for (let i = 12 + progInfo; i + 5 <= end;) {
        const type = sec[i];
        const pid = ((sec[i + 1] & 0x1f) << 8) | sec[i + 2];
        const esLen = ((sec[i + 3] & 0x0f) << 8) | sec[i + 4];
        let lang = null; let audioDesc = false;
        for (let d = i + 5; d + 2 <= Math.min(end, i + 5 + esLen);) {
            const tag = sec[d]; const dl = sec[d + 1];
            if (tag === 0x0a && dl >= 3 && d + 5 <= sec.length) {
                lang = String.fromCharCode(sec[d + 2], sec[d + 3], sec[d + 4]).replace(/[^a-z]/gi, '') || null;
            }
            if (AUDIO_DESCRIPTORS.has(tag)) audioDesc = true;
            d += 2 + dl;
        }
        if (AUDIO_TYPES.has(type) || (type === 0x06 && audioDesc)) out.push({ pid, streamType: type, code: lang });
        i += 5 + esLen;
    }
    return out;
}

/**
 * Pure. Buffer holding the start of a TS segment -> audio tracks in PMT order:
 * [{ pid, streamType, code, language }], `language` the canonical name or null
 * (untagged / und). null when no PMT was found in the bytes given.
 */
function pmtAudioTracks(buf) {
    if (!buf || buf.length < TS_PACKET) return null;
    // Sync on the first 0x47 that repeats one packet later.
    let start = 0;
    while (start < TS_PACKET && !(buf[start] === 0x47 && (start + TS_PACKET >= buf.length || buf[start + TS_PACKET] === 0x47))) start++;
    if (start >= TS_PACKET) return null;
    let pmtPids = null;
    for (let off = start; off + TS_PACKET <= buf.length; off += TS_PACKET) {
        const pid = pidOf(buf, off);
        if (pid === 0 && !pmtPids) {
            const sec = sectionPayload(buf, off);
            if (sec) pmtPids = new Set(parsePat(sec));
            continue;
        }
        if (pmtPids && pmtPids.has(pid)) {
            const sec = sectionPayload(buf, off);
            const tracks = sec && parsePmt(sec);
            if (tracks) {
                return tracks.map((t) => ({
                    ...t,
                    language: t.code && !UNKNOWN.test(t.code) ? (canonicalLanguage(t.code) || null) : null,
                }));
            }
        }
    }
    return null;
}

/** Pure. Distinct known languages, PMT order. */
function languagesOf(tracks) {
    return [...new Set((tracks || []).map((t) => t.language).filter(Boolean))];
}

/** Pure. First segment URI of a media playlist, resolved, or null. */
function firstSegmentUrl(playlistText, playlistUrl) {
    for (const raw of String(playlistText || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        try { return new URL(line, playlistUrl).toString(); } catch { return null; }
    }
    return null;
}

const agents = {
    http: new http.Agent({ keepAlive: true, lookup: lookupWithFallback }),
    https: new https.Agent({ keepAlive: true, lookup: lookupWithFallback }),
};

async function fetchHead(url, headers, timeoutMs) {
    const r = await nodeFetch(url, {
        headers: { ...headers, Range: `bytes=0-${HEAD_BYTES - 1}` },
        agent: (u) => (u.protocol === 'http:' ? agents.http : agents.https),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
    });
    if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`);
    // A server that ignores Range sends the whole segment: read only the head.
    const chunks = []; let got = 0;
    for await (const c of r.body) {
        chunks.push(c); got += c.length;
        if (got >= HEAD_BYTES) break;
    }
    if (r.body.destroy) r.body.destroy();
    return Buffer.concat(chunks).subarray(0, HEAD_BYTES);
}

// Keyed on the segment path, no host, no query: mirrors (fcxmb / hscow) serve
// the same bytes under the same path, and the query is a signature.
const cache = new Map();
function cacheKey(url) {
    try { return new URL(url).pathname; } catch { return url; }
}

/**
 * First segment of `playlistText` -> { tracks, languages } or null when the
 * segment could not be read or had no PMT. Never throws.
 */
async function probeSegmentLanguages(playlistText, playlistUrl, headers = {}, { timeoutMs = PROBE_TIMEOUT_MS, fetchHeadFn = fetchHead } = {}) {
    const seg = firstSegmentUrl(playlistText, playlistUrl);
    if (!seg) return null;
    const key = cacheKey(seg);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const p = (async () => {
        try {
            const tracks = pmtAudioTracks(await fetchHeadFn(seg, headers, timeoutMs));
            return tracks ? { tracks, languages: languagesOf(tracks) } : null;
        } catch (e) {
            console.log(`[ts-lang] first segment unreadable: ${e.message}`);
            return null;
        }
    })();
    const entry = { value: p, expiresAt: Date.now() + CACHE_TTL_MS };
    cache.set(key, entry);
    const value = await p;
    // A failed read may be one bad fetch: do not keep it.
    if (!value) cache.delete(key);
    else entry.settled = value;
    return value;
}

/**
 * The cached answer for `playlistText`'s first segment WITHOUT reading it:
 * { tracks, languages } when a probe already finished, undefined otherwise
 * (never probed, or still in flight). Lets a provider answer at once and probe
 * in the background (lib/media/languagesLater.js).
 */
function cachedSegmentLanguages(playlistText, playlistUrl) {
    const seg = firstSegmentUrl(playlistText, playlistUrl);
    if (!seg) return undefined;
    const hit = cache.get(cacheKey(seg));
    return hit && hit.expiresAt > Date.now() && hit.settled ? hit.settled : undefined;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of cache) if (e.expiresAt < now) cache.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { pmtAudioTracks, languagesOf, firstSegmentUrl, probeSegmentLanguages, cachedSegmentLanguages, HEAD_BYTES, _cache: cache };
