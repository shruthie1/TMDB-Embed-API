// multimovies - MultiMovies' VidBolt server (vidbolt.xyz), keyed on TMDB id.
//
// Ported from the community Nuvio scraper mayurgj/nama multimovies.js v1.3.1
// (2026-11-20). That scraper searches multimovies.wtf -> m1.multimovies.courses
// for the title page, reads its server list (Nexus, Vidrift, VIDOUT, Filmu,
// VidBolt) and runs one extractor per server. Measured on this Mac 2026-11-20:
// only VidBolt answered, on both test titles (Krack 784572, Inception 27205);
// the other four returned nothing. Every server takes TMDB ids, and the
// scraper itself falls back to https://vidbolt.xyz/movie/<id> when the site
// lookup fails, so this port calls VidBolt directly and skips the site search
// (5+ requests, two TMDB calls) and the four dead extractors.
//
// WHAT VIDBOLT SERVES. GET /api/resolve?type=movie&id=<tmdb> returns
// stream.sources[] of { url, kind: "hls", quality }. The url is ONE real HLS
// master that carries every dubbed language as an #EXT-X-MEDIA AUDIO rendition
// (Krack: kan/mal/tam/tel; Inception: eng/hin). The Nuvio scraper rebuilt that
// into one data: playlist per resolution; here the real master URL is returned
// as is, so /m3u8-proxy rewrites it like any other master.
//
// AUDIO IS READ FROM THE MASTER, never from a title. The master is fetched once
// and audio[] lists every AUDIO rendition it declares; selectableAudio is true
// only when it declares at least one. A master that cannot be read is dropped:
// a row we cannot label is invisible to the Telugu-first ranking anyway.
//
// DISGUISED SEGMENTS. Some HLS hosts prefix each TS segment with an image
// header. The scraper dropped such streams (players fail on them); this port
// keeps that check on the first segment of the top variant. Krack's segments
// are named .png but are real MPEG-TS (206 video/mp2t, measured 2026-11-20).
// The check timed out at 5s on Krack and held every resolve for it, so it now
// runs in the background, once per segment host, and its answer is cached:
// the first resolve on an unknown host fails open (as a timeout already did),
// later ones drop the row when the host is known to disguise.
//
// DEAD AUDIO RENDITIONS. Krack's kan/mal/tam playlists never answered (30s
// timeouts, 2026-11-20; Telugu answered in 593ms), and picking one gave a
// proxy 500 after 30.2s. Each rendition playlist gets one parallel GET while
// listing; one with no 2xx answer inside AUDIO_TIMEOUT_MS leaves audio[].

const hls = require('../lib/media/hlsManifest');
const { knownLanguage } = require('../utils/streamSchema');

const ORIGIN = 'https://vidbolt.xyz';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0 Mobile Safari/537.36';
const API_TIMEOUT_MS = 10000;
const MASTER_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 5000;
// Mutable for tests only.
const _config = { audioTimeoutMs: 8000 };
const DISGUISE_CACHE_MS = 6 * 60 * 60 * 1000;

// Headers the stream host gets through /m3u8-proxy. The scraper sent VidBolt's
// own Referer/Origin on every playlist and segment fetch.
const STREAM_HEADERS = { 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN };

function embedPath(tmdbId, mediaType, season, episode) {
    return mediaType === 'tv'
        ? `tv/${tmdbId}/${season || 1}/${episode || 1}`
        : `movie/${tmdbId}`;
}

function resolveUrl(tmdbId, mediaType, season, episode) {
    return mediaType === 'tv'
        ? `${ORIGIN}/api/resolve?type=tv&id=${tmdbId}&season=${season || 1}&episode=${episode || 1}`
        : `${ORIGIN}/api/resolve?type=movie&id=${tmdbId}`;
}

// "[4] Telugu", "1. English", "Hindi (Original)" -> "Telugu", "English", "Hindi".
function cleanName(name) {
    return String(name || '')
        .replace(/^\s*(\[\d+\]|\d+[.)])\s*/, '')
        .replace(/\s*\(.*\)\s*$/, '')
        .trim();
}

// A rendition NAME that says nothing about language ("Audio", "Track 1").
// The RRR bridge masters (MovieBox via dash-hls-bridge) all use NAME="Audio"
// with no LANGUAGE (2026-11-21), so their rows read languages ['Audio'].
const GENERIC_AUDIO_NAME = /^(audio|audio\s*\d+|track\s*\d*|default|main|aac|stereo|sound)$/i;

// VidBolt's /api/resolve `language` for one source, when it names a KNOWN
// audio language (knownLanguage: no title-cased junk like "Hindi dubbed").
// MovieBox "<lang> sub" sources carry the original audio with subtitles, so
// they are never an audio language. "Original" takes the title's TMDB
// original_language when known, else nothing.
function sourceLanguage(src, originalLang = null) {
    const raw = String((src && src.language) || '').trim();
    if (!raw || /\bsub(s|bed|titles?)?$/i.test(raw)) return null;
    if (/^original$/i.test(raw)) return knownLanguage(originalLang);
    return knownLanguage(raw);
}

// One audio[] entry per AUDIO rendition the master declares. LANGUAGE wins.
// The source's language is stamped only when the master has exactly ONE
// AUDIO rendition, untagged with a generic NAME: several renditions are left
// as the master states (one source language cannot name them all). Anything
// else falls back to its NAME so no tag is lost.
function audioFromMaster(text, baseUrl, deadUrls = null, srcLanguage = null) {
    const all = hls.parseMedia(text, baseUrl, 'AUDIO');
    const single = all.length === 1;
    return all.filter((m) => !(deadUrls && m.url && deadUrls.has(m.url))).map((m) => {
        const code = String(m.languageCode || '').trim();
        const name = cleanName(m.name);
        const language = code && !/^(und|unk|mul|zxx)$/i.test(code) ? code
            : (single && srcLanguage && (!name || GENERIC_AUDIO_NAME.test(name))) ? srcLanguage
            : name || null;
        return { language, name: cleanName(m.name) || null, channels: m.channels || null, codec: null };
    });
}

// Display tier from width first: 1920x800 is a letterboxed 1080p encode, and
// height alone snaps it to 720p.
function tierOf(level) {
    const w = Number(level && level.width) || 0;
    const h = Number(level && level.height) || 0;
    if (w >= 3200 || h >= 2000) return '2160p';
    if (w >= 2400 || h >= 1400) return '1440p';
    if (w >= 1800 || h >= 1000) return '1080p';
    if (w >= 1200 || h >= 700) return '720p';
    if (w >= 800 || h >= 460) return '480p';
    if (w > 0 || h > 0) return '360p';
    return null;
}

// Telugu first, then the rest in master order. Only the order changes.
function teluguFirst(langs) {
    const isTe = (l) => /^(te|tel|telugu)$/i.test(String(l));
    return [...langs.filter(isTe), ...langs.filter((l) => !isTe(l))];
}

// VidBolt masters carry no CODECS, but the sacdn path names the encode
// (..._1080_h265_956/master.m3u8) and its init segments sniff as hev1. Tag it
// so a browser that cannot decode HEVC skips the row (web codecSupport.js).
// The bridge wraps the sacdn url in ?url=, so the decoded url is checked too.
function videoCodecOf(masterText, masterUrl) {
    const stated = hls.videoCodecFamily(hls.masterCodecs(masterText));
    if (stated) return stated;
    let u = String(masterUrl || '');
    try { u += ' ' + decodeURIComponent(u); } catch { /* keep raw */ }
    return /_h265_/i.test(u) ? 'hevc' : null;
}

// Pure: the stream row for one fetched master. Exported for tests.
function streamFromMaster(src, masterText, masterUrl, deadAudioUrls = null, originalLang = null) {
    const levels = hls.parseLevels(masterText, masterUrl);
    if (!levels.length) return null;
    const audio = audioFromMaster(masterText, masterUrl, deadAudioUrls, sourceLanguage(src, originalLang));
    const languages = teluguFirst([...new Set(audio.map((a) => a.language).filter(Boolean))]);
    const quality = tierOf(levels[0]) || (/\b(2160|1440|1080|720|480|360)p\b/i.exec(src.quality || '') || [])[0] || 'Auto';
    const subtitles = hls.parseMedia(masterText, masterUrl, 'SUBTITLES')
        .filter((s) => s.url)
        .map((s, i) => ({ url: s.url, lang: s.languageCode || s.name || `Subtitle ${i + 1}`, id: `mm-sub-${i}` }));
    const label = audio.length > 1 ? 'Multi Audio' : (languages[0] || 'Unknown');
    return {
        name: `MultiMovies | ${quality} | ${label}`,
        title: `MultiMovies · VidBolt · ${label}${languages.length ? ` (${languages.join(', ')})` : ''}`,
        url: masterUrl,
        provider: 'multimovies',
        quality,
        container: 'hls',
        languages,
        audio,
        selectableAudio: audio.length > 0,
        levels: levels.map((l) => ({ height: l.height, quality: tierOf(l), bandwidth: l.bandwidth, codecs: l.codecs })),
        codecs: hls.masterCodecs(masterText),
        videoCodec: videoCodecOf(masterText, masterUrl),
        subtitles,
        headers: { ...STREAM_HEADERS },
    };
}

// True when the first 16 bytes start with an image header (PNG, JPEG, GIF89).
function looksLikeImage(bytes) {
    const b = Buffer.from(bytes || []);
    const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const jpg = b[0] === 0xff && b[1] === 0xd8;
    const gif = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
    return png || jpg || gif;
}

// The scraper's mmDisguised: first segment of the top variant. true / false,
// or null when the probe could not run (fails open: the row is kept).
async function segmentsDisguised(levelUrl) {
    try {
        const res = await fetch(levelUrl, { headers: STREAM_HEADERS, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return null;
        const text = await res.text();
        const seg = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        if (!seg) return null;
        const r = await fetch(hls.resolveUri(seg, levelUrl), {
            headers: { ...STREAM_HEADERS, Range: 'bytes=0-15' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const head = Buffer.from(await r.arrayBuffer()).subarray(0, 16);
        return looksLikeImage(head);
    } catch (e) {
        console.log(`[multimovies] segment probe failed open: ${e.message}`);
        return null;
    }
}

// Per segment host: { disguised, at } once a check finished, and the in-flight
// check so concurrent resolves share it. A check that could not run is not
// cached, so the next resolve tries again.
const disguiseCache = new Map();
const disguiseInflight = new Map();

function hostOf(url) {
    try { return new URL(url).host; } catch { return null; }
}

// true / false from a finished check on this host, null when unknown. Starts
// a background check when unknown; never waits for it.
function disguisedHost(levelUrl) {
    const host = hostOf(levelUrl);
    if (!host) return null;
    const hit = disguiseCache.get(host);
    if (hit && Date.now() - hit.at < DISGUISE_CACHE_MS) return hit.disguised;
    if (!disguiseInflight.has(host)) {
        const p = segmentsDisguised(levelUrl)
            .then((d) => {
                if (d !== null) disguiseCache.set(host, { disguised: d, at: Date.now() });
                console.log(`[multimovies] segment check host=${host} disguised=${d === null ? 'unknown' : d}`);
            })
            .finally(() => disguiseInflight.delete(host));
        disguiseInflight.set(host, p);
    }
    return null;
}

// Set of AUDIO rendition URLs whose playlist gave no 2xx within the timeout.
async function deadAudioUrls(masterText, masterUrl, tmdbId) {
    const media = hls.parseMedia(masterText, masterUrl, 'AUDIO').filter((m) => m.url);
    const dead = new Set();
    await Promise.all(media.map(async (m) => {
        const t0 = Date.now();
        try {
            const r = await fetch(m.url, { headers: STREAM_HEADERS, signal: AbortSignal.timeout(_config.audioTimeoutMs) });
            if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (e) {
            dead.add(m.url);
            console.log(`[multimovies] audio rendition ${m.languageCode || m.name || '?'} dropped for ${tmdbId}: `
                + `${e.name === 'TimeoutError' ? `no answer in ${_config.audioTimeoutMs}ms` : e.message} (${Date.now() - t0}ms)`);
        }
    }));
    return dead;
}

async function getMultimoviesStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    console.log(`[multimovies] Fetching streams for TMDB ID: ${tmdbId}, Type: ${type}`);

    // Transport error or non-2xx: unknown, not empty. Thrown so the fan-out
    // records an error and does not cache "no streams".
    const res = await fetch(resolveUrl(tmdbId, type, seasonNum, episodeNum), {
        headers: { 'User-Agent': UA, Referer: `${ORIGIN}/${embedPath(tmdbId, type, seasonNum, episodeNum)}` },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`multimovies: vidbolt resolve HTTP ${res.status} for ${tmdbId}`);
    const body = await res.json();
    const sources = ((body && body.stream && body.stream.sources) || []).filter((s) => s && s.url && s.kind === 'hls');
    if (!sources.length) {
        console.log(`[multimovies] no hls source for ${tmdbId} (server=${body && body.stream && body.stream.server})`);
        return [];
    }

    // Only when a source says "Original": the title's TMDB original_language
    // (cached 6 h in utils/tmdb.js). Unknown -> null, that row stays unlabelled.
    let originalLang = null;
    if (sources.some((s) => /^original$/i.test(String(s.language || '').trim()))) {
        try {
            const d = await require('../utils/tmdb').getDetails(type, tmdbId);
            originalLang = (d && d.original_language) || null;
        } catch (e) {
            console.log(`[multimovies] TMDB original_language unknown for ${tmdbId}: ${e.message}`);
        }
    }

    const rows = await Promise.all(sources.map(async (src) => {
        let text;
        try {
            const r = await fetch(src.url, { headers: STREAM_HEADERS, signal: AbortSignal.timeout(MASTER_TIMEOUT_MS) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            text = await r.text();
        } catch (e) {
            console.log(`[multimovies] master unreadable for ${tmdbId}, dropped: ${e.message}`);
            return null;
        }
        if (!hls.parseLevels(text, src.url).length) {
            console.log(`[multimovies] master has no variants for ${tmdbId}, dropped`);
            return null;
        }
        const row = streamFromMaster(src, text, src.url, await deadAudioUrls(text, src.url, tmdbId), originalLang);
        const top = hls.parseLevels(text, src.url)[0];
        if (top && top.url && disguisedHost(top.url) === true) {
            console.log(`[multimovies] segments disguised as images for ${tmdbId}, dropped`);
            return null;
        }
        if (row.audio.length) {
            console.log(`[multimovies] master lists ${row.audio.length} audio rendition(s): `
                + `${row.audio.map((a) => a.language || '?').join('/')} - selectable`);
        } else {
            console.log(`[multimovies] master lists no audio renditions - not selectable`);
        }
        return row;
    }));

    const seen = new Set();
    const out = rows.filter((r) => r && !seen.has(r.url) && seen.add(r.url));
    console.log(`[multimovies] Got ${out.length} stream(s) for ${tmdbId}`);
    return out;
}

module.exports = {
    getMultimoviesStreams,
    STREAM_HEADERS,
    streamFromMaster,
    audioFromMaster,
    looksLikeImage,
    tierOf,
    _config,
    _clearDisguiseCache: () => { disguiseCache.clear(); disguiseInflight.clear(); },
    _disguiseSettled: () => Promise.all([...disguiseInflight.values()]),
};
