'use strict';

// Byte-level check of the top-ranked streams.
//
// lib/media/probe.js reads a manifest, and only with ?capabilities=1. Nothing
// confirmed that real media bytes sit behind a URL, so a rate-limit HTML page
// or an empty playlist served as 200 could rank first. This module reads the
// first few KB of the first segment (or of a progressive file) and says
// whether they look like media.
//
// It NEVER removes a stream. A failed check only lowers the stream inside its
// language group (apiServer.js sortStreamsCanonically reads `byteCheck`).
// CLAUDE.md rule 1: never lose a stream to save latency.

const hls = require('./hlsManifest');

const ATTEMPT_MS = Number(process.env.SEGMENT_VERIFY_ATTEMPT_MS) || 2500;
const BUDGET_MS = Number(process.env.SEGMENT_VERIFY_BUDGET_MS) || 6000;
const CACHE_MS = 2 * 60 * 1000;
const TOP_N = 3;
const RANGE_BYTES = 4096;
const MIN_SEGMENT_BYTES = 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

const cache = new Map(); // url -> { verdict, expiresAt }
const inflight = new Map(); // url -> Promise<verdict>

function cacheGet(url) {
    const e = cache.get(url);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { cache.delete(url); return null; }
    return e.verdict;
}

function cacheSet(url, verdict) {
    cache.set(url, { verdict, expiresAt: Date.now() + CACHE_MS });
}

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of cache) if (e.expiresAt < now) cache.delete(k);
}, 60 * 1000).unref();

class TimeoutError extends Error {
    constructor() { super('timeout'); this.name = 'TimeoutError'; }
}

// Read at most `max` bytes, then stop the transfer. An origin that ignores
// Range sends the whole segment; we must not pull megabytes for a 4KB check.
async function readCapped(resp, max) {
    if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        const chunks = [];
        let total = 0;
        try {
            while (total < max) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(Buffer.from(value));
                total += value.length;
            }
        } finally {
            reader.cancel().catch(() => {});
        }
        return Buffer.concat(chunks).subarray(0, max);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.subarray(0, max);
}

// One GET with its own deadline. `deadline` is an absolute ms timestamp.
async function get(fetchImpl, url, headers, { range, max, deadline }) {
    const left = deadline - Date.now();
    if (left <= 0) throw new TimeoutError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
        const h = { ...(headers || {}) };
        if (range) h.Range = `bytes=0-${range - 1}`;
        const resp = await fetchImpl(url, { headers: h, signal: controller.signal, redirect: 'follow' });
        const ct = (resp.headers && typeof resp.headers.get === 'function' && resp.headers.get('content-type')) || '';
        const bytes = resp.ok ? await readCapped(resp, max) : Buffer.alloc(0);
        return { status: resp.status, ok: resp.ok, bytes, contentType: String(ct).toLowerCase() };
    } catch (err) {
        if (controller.signal.aborted || (err && err.name === 'AbortError')) throw new TimeoutError();
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function looksLikeHtml(buf) {
    const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
    return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<html')
        || head.startsWith('<?xml') || head.startsWith('<head') || head.startsWith('<body');
}

// Mostly printable ASCII: a JSON error body or a text page, not media.
function looksLikeText(buf) {
    const n = Math.min(buf.length, 512);
    if (!n) return false;
    let printable = 0;
    for (let i = 0; i < n; i++) {
        const c = buf[i];
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
    }
    return printable / n > 0.97;
}

function hasBox(buf, type) {
    return buf.subarray(0, RANGE_BYTES).includes(Buffer.from(type, 'latin1'));
}

// MPEG-TS: sync byte 0x47 every 188 bytes. Some CDNs prefix segments with a
// fake image header, so search for the pattern instead of reading offset 0.
function hasTsSync(buf) {
    for (let i = 0; i + 188 * 2 < buf.length && i < 2048; i++) {
        if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return true;
    }
    return false;
}

function containerOf(buf) {
    if (hasTsSync(buf)) return 'ts';
    if (['ftyp', 'styp', 'moof', 'moov', 'sidx'].some((t) => hasBox(buf, t))) return 'mp4';
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
    if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'id3';
    if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'adts';
    return null;
}

// Media bytes checks shared by segments and progressive files.
function judgeBytes(res, { wantFtyp }) {
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    if (looksLikeHtml(res.bytes)) return { ok: false, reason: 'html' };
    if (res.bytes.length < MIN_SEGMENT_BYTES) return { ok: false, reason: `short ${res.bytes.length}b` };
    const container = containerOf(res.bytes);
    // A wrong Content-Type alone is not proof: trust recognised media bytes.
    if (!container && res.contentType.includes('text/html')) return { ok: false, reason: 'html' };
    if (!container && looksLikeText(res.bytes)) return { ok: false, reason: 'text' };
    if (wantFtyp && !hasBox(res.bytes, 'ftyp')) return { ok: false, reason: 'no ftyp' };
    // An unknown binary container is not proof of death: some CDNs wrap
    // segments in odd envelopes. Pass it, and say so.
    return { ok: true, reason: container ? null : 'container-unknown', container };
}

function firstSegmentUri(text, baseUrl) {
    const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    return line ? hls.resolveUri(line, baseUrl) : null;
}

async function attempt(fetchImpl, stream, deadline) {
    const url = stream.url;
    const headers = stream.headers || {};
    const isMp4 = /\.mp4(\?|$)/i.test(url) || stream.container === 'mp4';
    const looksHls = /\.m3u8(\?|$)/i.test(url) || stream.container === 'hls' || stream.type === 'hls';

    const first = await get(fetchImpl, url, headers, looksHls
        ? { max: MAX_MANIFEST_BYTES, deadline }
        : { range: RANGE_BYTES, max: RANGE_BYTES, deadline });
    if (!first.ok) return { ok: false, reason: `http ${first.status}` };
    let text = first.bytes.toString('utf8');

    if (!text.trimStart().startsWith('#EXTM3U')) {
        if (looksHls) {
            const j = judgeBytes(first, { wantFtyp: false });
            return j.ok ? { ok: false, reason: 'not-m3u8' } : j;
        }
        return judgeBytes(first, { wantFtyp: isMp4 && containerOf(first.bytes) !== 'mkv' });
    }

    // A ranged read may have cut the manifest short; fetch it whole.
    if (!looksHls) {
        const full = await get(fetchImpl, url, headers, { max: MAX_MANIFEST_BYTES, deadline });
        if (!full.ok) return { ok: false, reason: `http ${full.status}` };
        text = full.bytes.toString('utf8');
    }

    let mediaText = text;
    let mediaUrl = url;
    if (hls.isMaster(text)) {
        const levels = hls.parseLevels(text, url);
        if (!levels.length || !levels[levels.length - 1].url) return { ok: false, reason: 'empty-master' };
        // Lowest rung: smallest segment, fastest answer, same origin.
        mediaUrl = levels[levels.length - 1].url;
        const v = await get(fetchImpl, mediaUrl, headers, { max: MAX_MANIFEST_BYTES, deadline });
        if (!v.ok) return { ok: false, reason: `variant http ${v.status}` };
        mediaText = v.bytes.toString('utf8');
        if (!mediaText.trimStart().startsWith('#EXTM3U')) {
            return looksLikeHtml(v.bytes) ? { ok: false, reason: 'variant html' } : { ok: false, reason: 'variant not-m3u8' };
        }
    }

    const seg = firstSegmentUri(mediaText, mediaUrl);
    if (!seg) return { ok: false, reason: 'empty-playlist' };
    // fMP4: the init segment carries ftyp; a moof fragment does not.
    const init = hls.mapUri(mediaText, mediaUrl);
    const target = init || seg;
    const s = await get(fetchImpl, target, headers, { range: RANGE_BYTES, max: RANGE_BYTES, deadline });
    const j = judgeBytes(s, { wantFtyp: Boolean(init) && containerOf(s.bytes) === 'mp4' });
    return j.ok ? j : { ...j, reason: `segment ${j.reason}` };
}

// One verdict for one stream: attempt, plus one retry on a network error.
// A timeout is a verdict (slow-to-dead), not a reason to retry.
async function verifyOne(stream, { fetchImpl = globalThis.fetch, attemptMs = ATTEMPT_MS, budgetEnd } = {}) {
    const end = Math.min(Date.now() + attemptMs, budgetEnd || Infinity);
    for (let tries = 0; tries < 2; tries++) {
        try {
            return await attempt(fetchImpl, stream, end);
        } catch (err) {
            if (err instanceof TimeoutError) return { ok: false, reason: 'timeout' };
            if (tries === 1 || Date.now() >= end) {
                return { ok: false, reason: `network ${String((err && err.message) || err).slice(0, 80)}` };
            }
        }
    }
    return { ok: false, reason: 'unreachable' };
}

function cachedVerify(stream, opts) {
    const url = stream.url;
    const hit = cacheGet(url);
    if (hit) return Promise.resolve(hit);
    if (inflight.has(url)) return inflight.get(url);
    const p = verifyOne(stream, opts).then((v) => {
        cacheSet(url, v);
        inflight.delete(url);
        return v;
    }, (err) => {
        inflight.delete(url);
        return { ok: false, reason: `error ${err && err.message}` };
    });
    inflight.set(url, p);
    return p;
}

function verifiable(stream, skipPrefix) {
    if (!stream || typeof stream.url !== 'string' || !/^https?:\/\//i.test(stream.url)) return false;
    // Our own routes (castle demux, hybrid) are built from verified sources
    // and fetching them here would start demux work.
    if (skipPrefix && stream.url.startsWith(skipPrefix)) return false;
    return true;
}

function annotate(streams, verdicts) {
    return streams.map((s) => {
        const v = s && verdicts.get(s.url);
        if (!v) return s;
        return { ...s, byteCheck: { ok: v.ok, ...(v.reason ? { reason: v.reason } : {}) } };
    });
}

// Verify the top candidates of an already-sorted list, in parallel.
//
// Returns the SAME streams (same count, same objects where unverified) with a
// `byteCheck` field on each stream that has a verdict. Order is not changed
// here; the caller re-sorts.
//
// Latency: if the top candidate passes, return at once. The others keep
// running and land in the cache for the next request. If the top fails, wait
// for the rest (inside the total budget) so the caller knows which to lift.
async function verifyTopStreams(streams, opts = {}) {
    if (!Array.isArray(streams) || !streams.length) return streams || [];
    const topN = opts.topN || TOP_N;
    const budgetEnd = Date.now() + (opts.budgetMs || BUDGET_MS);
    const vopts = { fetchImpl: opts.fetchImpl || globalThis.fetch, attemptMs: opts.attemptMs || ATTEMPT_MS, budgetEnd };

    const verdicts = new Map();
    // Known verdicts apply to every stream, not just the top ones. Free.
    for (const s of streams) {
        if (!s || !s.url) continue;
        const hit = cacheGet(s.url);
        if (hit) verdicts.set(s.url, hit);
    }

    const candidates = streams.filter((s) => verifiable(s, opts.skipPrefix)).slice(0, topN);
    if (!candidates.length || typeof vopts.fetchImpl !== 'function') return annotate(streams, verdicts);

    const jobs = candidates.map((s) => cachedVerify(s, vopts).then((v) => { verdicts.set(s.url, v); return v; }));

    const budget = new Promise((r) => {
        const t = setTimeout(r, Math.max(0, budgetEnd - Date.now()));
        if (t.unref) t.unref();
    });
    const top = await Promise.race([jobs[0], budget]);
    if (!(top && top.ok)) await Promise.race([Promise.allSettled(jobs), budget]);
    return annotate(streams, verdicts);
}

function clearVerifyCache() { cache.clear(); inflight.clear(); }

module.exports = {
    verifyTopStreams, verifyOne, clearVerifyCache, judgeBytes, containerOf,
    ATTEMPT_MS, BUDGET_MS, CACHE_MS, MIN_SEGMENT_BYTES,
};
