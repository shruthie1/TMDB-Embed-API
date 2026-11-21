'use strict';
// Shared pieces of one heal run (review 2026-11-21, I2/I3/M6):
//
//   createBudget()   one GET counter per run: redirects, trails, validation,
//                    and each candidate's own resolve all spend from it (12).
//   titleProof()     a candidate is adopted only if it served the RIGHT film:
//                    the duration of one own-resolve row (HLS playlist, or an
//                    MP4 mvhd box in the first 256 KiB) must match the
//                    validation title's TMDB runtime. The answer's shape is
//                    not enough (a copied /api/resolve shape passes that).
//
// Validation titles (measured live 2026-11-21 from the laptop, see the ledger):
// Inception 27205 for castletv, multimovies, showsst; RRR 579974 for vidrift,
// vidrock, onetouchtv (both answered 0 rows on 27205).

const MAX_GETS = 12;
// Runtime in minutes per validation title, TMDB (fallback when TMDB is down).
const RUNTIME_MIN = { 27205: 148, 579974: 187 };
const TIMEOUT_MS = 10000;

function createBudget(max = MAX_GETS) {
    const b = {
        gets: 0, max,
        charge(n = 1) {
            if (b.gets + n > b.max) {
                console.warn(`[heal] budget exhausted ${b.gets}/${b.max}`);
                return false;
            }
            b.gets += n;
            return true;
        },
        // fetch wrapper that spends one GET per call
        wrap(fetchFn) {
            return async (url, opts = {}) => {
                if (!b.charge(1)) throw new Error(`heal GET cap ${b.max}`);
                return fetchFn(url, opts);
            };
        },
    };
    return b;
}

// Sum of #EXTINF in a media playlist, seconds.
function playlistSeconds(text) {
    let s = 0;
    for (const m of String(text || '').matchAll(/#EXTINF:\s*([\d.]+)/g)) s += Number(m[1]) || 0;
    return s;
}

let seam = {}; // test seam: { getDetails, fetch }
// The fetch the title proof uses: the provider's own (global fetch).
function proofFetch() { return seam.fetch || globalThis.fetch; }
function _setDeps(d) { seam = d || {}; }

// Duration from an MP4 'mvhd' box in the first bytes (a fast-start file
// keeps moov at the front). null when the box is not there.
function mp4Seconds(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    const i = b.indexOf('mvhd');
    if (i < 0) return null;
    const v = b[i + 4];
    let ts; let dur;
    try {
        if (v === 1) { ts = b.readUInt32BE(i + 4 + 4 + 16); dur = Number(b.readBigUInt64BE(i + 4 + 4 + 20)); } else { ts = b.readUInt32BE(i + 4 + 4 + 8); dur = b.readUInt32BE(i + 4 + 4 + 12); }
    } catch { return null; }
    return ts > 0 && dur > 0 ? dur / ts : null;
}

async function runtimeMinutes(tmdbId, deps = {}) {
    try {
        const getDetails = deps.getDetails || seam.getDetails || require('../../utils/tmdb').getDetails;
        const d = await getDetails('movie', String(tmdbId));
        if (d && Number(d.runtime) > 0) return Number(d.runtime);
    } catch { /* fall back */ }
    return RUNTIME_MIN[String(tmdbId)] || null;
}

/** Within 6 minutes or 6 % of the expected runtime, and never a short clip. */
function runtimeMatches(seconds, minutes) {
    if (!(seconds > 0) || !(minutes > 0)) return false;
    const got = seconds / 60;
    return got >= 20 && Math.abs(got - minutes) <= Math.max(6, minutes * 0.06);
}

/**
 * Duration of the first HLS row, from its master's first variant (2 GETs at
 * most, spent from `fetchFn`, which the caller has wrapped in the budget).
 * null when no row is HLS or nothing could be read.
 */
const isMp4Row = (r) => r && typeof r.url === 'string' && (r.container === 'mp4' || /\.mp4(\?|#|$)/i.test(r.url));

async function mp4RowSeconds(rows, fetchFn) {
    const row = (rows || []).find(isMp4Row);
    if (!row) return null;
    const url = row.url.replace(/#.*$/, '');
    const res = await fetchFn(url, { headers: { ...(row.headers || {}), Range: 'bytes=0-262143' }, timeout: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return mp4Seconds(buf.subarray(0, 262144));
}

async function hlsRowSeconds(rows, fetchFn) {
    const list = (rows || []).filter((r) => r && typeof r.url === 'string' && /^https:\/\//.test(r.url));
    // An HLS row first (by URL or container), else an MP4 row, else the first
    // row read as a playlist.
    const row = list.find((r) => /\.m3u8(\?|#|$)/i.test(r.url) || r.container === 'hls')
        || (list.some(isMp4Row) ? null : list[0]);
    if (!row) return mp4RowSeconds(list, fetchFn);
    const headers = { ...(row.headers || {}) };
    const get = async (u) => {
        const once = () => fetchFn(u, { headers, timeout: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS) });
        let res = await once();
        // vidrock's CDN answers a first master GET 403 at times; the provider
        // itself retries once (providers/vidrock.js). Same here, one retry.
        if (res && res.status === 403) { await new Promise((r) => setTimeout(r, 500)); res = await once(); }
        if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
        return res.text();
    };
    let text = await get(row.url);
    if (!String(text).trimStart().startsWith('#EXTM3U')) return null;
    if (/#EXT-X-STREAM-INF/.test(text)) {
        const line = text.split(/\r?\n/).map((l) => l.trim()).find((l, i, a) => l && !l.startsWith('#') && /#EXT-X-STREAM-INF/.test(a[i - 1] || ''));
        if (!line) return null;
        text = await get(new URL(line, row.url).href);
    }
    const s = playlistSeconds(text);
    return s > 0 ? s : null;
}

/**
 * True when one of `rows` is the validation title, by HLS duration against the
 * TMDB runtime. Logs `[heal] <name> title-proof ...` either way.
 */
async function titleProof(name, cand, rows, tmdbId, fetchFn, deps = {}) {
    let secs = null;
    try { secs = await hlsRowSeconds(rows, fetchFn); } catch (e) {
        console.warn(`[heal] ${name} reject ${cand} title-proof-fetch ${e.message}`);
        return false;
    }
    if (secs === null) {
        console.warn(`[heal] ${name} reject ${cand} no-title-proof`);
        return false;
    }
    const want = await runtimeMinutes(tmdbId, deps);
    const ok = runtimeMatches(secs, want);
    console.warn(`[heal] ${name} title-proof ${cand} ${ok ? 'ok' : 'mismatch'} ${Math.round(secs / 60)}min want ${want}min`);
    return ok;
}

module.exports = {
    createBudget, playlistSeconds, mp4Seconds, runtimeMatches, runtimeMinutes, hlsRowSeconds, titleProof,
    MAX_GETS, RUNTIME_MIN, _setDeps, proofFetch,
};
