'use strict';

// Network-facing manifest probe.
//
// Answers "what can this URL actually play?" by fetching the manifest rather
// than trusting what a provider claimed. Everything provider-specific stays
// out; the only input is a URL plus the headers it needs.
//
// This is the piece that lets a UI render a quality and audio menu BEFORE
// playback starts. Until now the browser had to load the stream in hls.js and
// wait for MANIFEST_PARSED, which is why public/watch.js:176 deliberately
// discards the API's audio data and uses only what hls.js discovers.

const hls = require('./hlsManifest');

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 8000;
const PROBE_CACHE_MS = Number(process.env.PROBE_CACHE_MS) || 5 * 60 * 1000;
// A manifest is small (a few KB); a segment is not. Cap the read so a URL that
// turns out to be a media file cannot pull megabytes into memory.
const MAX_MANIFEST_BYTES = 512 * 1024;

const cache = new Map();

function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { cache.delete(key); return null; }
    return e.value;
}

function cacheSet(key, value) {
    cache.set(key, { value, expiresAt: Date.now() + PROBE_CACHE_MS });
}

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of cache) if (e.expiresAt < now) cache.delete(k);
}, 60 * 1000).unref();

async function fetchText(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { signal: controller.signal, headers: headers || {} });
        if (!resp.ok) return { ok: false, status: resp.status, text: '' };
        const buf = await resp.arrayBuffer();
        const slice = buf.byteLength > MAX_MANIFEST_BYTES ? buf.slice(0, MAX_MANIFEST_BYTES) : buf;
        return { ok: true, status: resp.status, text: Buffer.from(slice).toString('utf8') };
    } catch (err) {
        return { ok: false, status: 0, text: '', error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

// Shape returned for every probe, success or failure, so callers never have to
// branch on presence of fields - only on `ok`.
function emptyResult(extra) {
    return {
        ok: false, kind: null, levels: [], audio: [], subtitles: [],
        durationSeconds: null, segmentCount: null, maxHeight: null,
        quality: null, qualitySource: null, selectableAudio: false, error: null, ...extra,
    };
}

// Probe one playable URL.
//
// A MASTER playlist declares its ladder and renditions inline - one fetch is
// enough. A MEDIA playlist declares neither, so its true resolution is only
// visible inside the segments; we report what is knowable (duration, segment
// count) and leave levels empty rather than invent a number. That distinction
// is the whole reason `quality` was wrong before: a provider filled the gap
// with a guess from the filename.
// `hint` carries what the caller already knows but the manifest cannot state:
// a media playlist declares no RESOLUTION, so for those the provider's own
// quality string is the only signal available. It is used ONLY as a fallback -
// whenever the manifest states a resolution, the manifest wins. That ordering
// is the point of this module.
async function probeStream(url, headers, hint) {
    if (!url) return emptyResult({ error: 'no url' });
    const key = `${url}`;
    const hit = cacheGet(key);
    if (hit) return { ...hit, cached: true };

    const res = await fetchText(url, headers);
    if (!res.ok) {
        // Never cache a failure: a transient 403 would otherwise pin an empty
        // capability set for the full TTL.
        return emptyResult({ error: res.error || `http ${res.status}`, httpStatus: res.status });
    }

    const text = res.text;
    if (!text.includes('#EXTM3U')) {
        // Not HLS - a progressive mp4/mkv. Nothing to parse, and that is a
        // legitimate answer, not an error.
        const out = emptyResult({ ok: true, kind: 'progressive' });
        cacheSet(key, out);
        return out;
    }

    if (hls.isMaster(text)) {
        const levels = hls.parseLevels(text, url);
        const audio = hls.parseMedia(text, url, 'AUDIO');
        const subtitles = hls.parseMedia(text, url, 'SUBTITLES');
        const maxHeight = levels.length ? levels[0].height : null;
        const out = emptyResult({
            ok: true, kind: 'master', levels, audio, subtitles,
            maxHeight, quality: hls.heightToTier(maxHeight) || (hint && hint.quality) || null,
            qualitySource: hls.heightToTier(maxHeight) ? 'manifest' : (hint && hint.quality ? 'provider' : null),
            selectableAudio: audio.length > 1,
        });
        cacheSet(key, out);
        return out;
    }

    const out = emptyResult({
        ok: true, kind: 'media',
        durationSeconds: Math.round(hls.parseDuration(text)) || null,
        segmentCount: hls.parseSegmentCount(text) || null,
        // Flat playlist: one implicit rendition. Report the hint so a UI still
        // has something to label the stream with, flagged as unverified so the
        // difference from a measured ladder stays visible.
        quality: (hint && hint.quality) || null,
        qualitySource: hint && hint.quality ? 'provider' : null,
    });
    cacheSet(key, out);
    return out;
}

function clearProbeCache() { cache.clear(); }

module.exports = { probeStream, clearProbeCache, PROBE_CACHE_MS };
