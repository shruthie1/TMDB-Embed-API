// vidrift - Vidrift's "Orion" server (embed.vidrift.net, mirror embed.vidrift.in),
// keyed on TMDB id.
//
// Ported from the community Nuvio scraper mayurgj/nama multimovies.js
// (`mmVidrift`, 2026-11-21); MultiMovies lists Vidrift as one of its servers.
// Measured from this Mac 2026-11-21 (new-providers.md, new-providers-build.md):
//   - ONE page GET resolves: /embed/movie/<tmdb> carries `var embedMeta = {...}`
//     whose orionStreams[] lists one HLS master PER LANGUAGE. RRR (579974):
//     "Orion · Original", "Orion · Hindi", "Orion · Telugu", "Orion · Bangla".
//     Krack (784572): orionStreams null at 18:53, two masters (Hindi, Telugu)
//     at 19:21, so null is treated as transient. Page 423-1403 ms.
//   - Both hosts return the same orion ids (RRR Original 36c0c007...).
//   - The masters need the host's own Referer + Origin: 403 with a foreign
//     Origin or none, 200 with Vidrift's. So web is proxied, the APK plays
//     direct with the row's headers (lib/routing/providerRoutes.js).
//   - Video is HEVC (CODECS hvc1.1.6.*), fMP4. Each master has ONE AUDIO
//     rendition, NAME="Audio", no LANGUAGE; its init segment says `und` (mdhd,
//     Original and Telugu).
//
// LANGUAGE. Per AUDIO rendition, its own LANGUAGE tag wins. Only when the
// master has exactly ONE untagged AUDIO rendition (or none, audio muxed) does
// the page label apply: the part after "·" ("Bangla" -> Bengali). "Original"
// takes the title's TMDB original_language (RRR te); unknown -> stays
// "Original" with no language. embedMeta.lang is NOT used: Krack, a Telugu
// film, had lang "" (review I2). Never read from a TMDB title string.
//
// FAILURES. A master that fails on every host is dropped and named in
// upstreamError, so the fan-out does not cache the partial answer as a full
// hit; when none survives the call throws. A dead page or a page without
// embedMeta / orionStreams moves to the next host. The whole call has a hard
// wall-clock budget below the 20 s registry deadline.

const axios = require('axios');
const hls = require('../lib/media/hlsManifest');

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0 Mobile Safari/537.36';
// Mutable for tests. budgetMs caps page + mirror + masters together.
const _config = {
    budgetMs: Number(process.env.VIDRIFT_BUDGET_MS) || 15000,
    pageTimeoutMs: Number(process.env.VIDRIFT_PAGE_TIMEOUT_MS) || 5000,
    masterTimeoutMs: Number(process.env.VIDRIFT_MASTER_TIMEOUT_MS) || 5000,
};
// The scraper sent MultiMovies' site as Referer on the embed page.
const PAGE_REFERER = 'https://m1.multimovies.courses/';

// Tried in order; a dead or broken host falls through to the next. Kept as a
// list so the self-heal plan (utils/upstreamBase.js) can put a healed host in
// front. VIDRIFT_BASE, when set, goes first.
const BASES = [
    ...(process.env.VIDRIFT_BASE ? [process.env.VIDRIFT_BASE] : []),
    'https://embed.vidrift.net',
    'https://embed.vidrift.in',
].map((b) => String(b).replace(/\/+$/, ''));

// The embed page answers 403 "Embed this page in an iframe." to Node's fetch
// (undici adds Sec-Fetch-Mode: cors) and 200 to axios and curl with the same
// UA + Referer (measured 2026-11-21, RRR: fetch 403 x2, axios 200 673 ms).
// So the page goes through axios, with an AbortSignal as the hard cap (axios
// `timeout` alone is an idle timer). Masters answer fetch normally.
// Replaceable for tests.
const _deps = {
    getPage: async (url, headers, signal) => {
        const r = await axios.get(url, {
            headers, signal, responseType: 'text', transformResponse: (d) => d,
            validateStatus: () => true, maxRedirects: 3,
        });
        return { status: r.status, text: String(r.data || '') };
    },
    // TMDB original_language ("te") or null. Cached 6 h in utils/tmdb.js.
    originalLanguage: async (type, tmdbId) => {
        const { getDetails } = require('../utils/tmdb');
        const d = await getDetails(type, tmdbId);
        return (d && d.original_language) || null;
    },
};

function streamHeaders(base) {
    return { 'User-Agent': UA, Referer: `${base}/`, Origin: base };
}

function embedUrl(base, tmdbId, mediaType, season, episode) {
    return mediaType === 'tv'
        ? `${base}/embed/tv/${tmdbId}/${season}/${episode}`
        : `${base}/embed/movie/${tmdbId}`;
}

// `var embedMeta = {...};` -> object, or null when the page has none.
function parseEmbedMeta(html) {
    const s = String(html || '');
    const at = s.search(/embedMeta\s*=\s*\{/);
    if (at < 0) return null;
    const start = s.indexOf('{', at);
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
            try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
    }
    return null;
}

// Page label -> language name the stream schema knows. Unknown labels pass
// through as written so no tag is lost.
const LABEL_LANG = {
    te: 'Telugu', tel: 'Telugu', telugu: 'Telugu',
    hi: 'Hindi', hin: 'Hindi', hindi: 'Hindi',
    ta: 'Tamil', tam: 'Tamil', tamil: 'Tamil',
    ml: 'Malayalam', mal: 'Malayalam', malayalam: 'Malayalam',
    kn: 'Kannada', kan: 'Kannada', kannada: 'Kannada',
    bn: 'Bengali', ben: 'Bengali', bangla: 'Bengali', bengali: 'Bengali',
    mr: 'Marathi', mar: 'Marathi', marathi: 'Marathi',
    en: 'English', eng: 'English', english: 'English',
};

function langName(raw) {
    const k = String(raw || '').trim();
    if (!k || /^(und|unk|mul|zxx|original)$/i.test(k)) return null;
    return LABEL_LANG[k.toLowerCase()] || k;
}

// "Orion · Telugu" -> { language: 'Telugu', label: 'Telugu' }.
// "Orion · Original" -> TMDB original language, or { language: null, label: 'Original' }.
function pageLanguage(entry, originalLang) {
    const label = String((entry && entry.name) || '').replace(/^.*·\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim();
    if (!label) return { language: null, label: null };
    if (/^original$/i.test(label)) {
        const language = langName(originalLang);
        return { language, label: language || 'Original' };
    }
    const language = langName(label);
    return { language, label: language };
}

// Tier from height. Width only lifts a letterboxed encode (1920x800 is a
// 1080p encode), never above 1080p: RRR Hindi is 2592x1080, a 21:9 1080p,
// which width-first rules called 1440p (live 2026-11-21).
function tierOf(level) {
    const w = Number(level && level.width) || 0;
    const h = Number(level && level.height) || 0;
    const byH = h >= 2000 ? 2160 : h >= 1400 ? 1440 : h >= 1000 ? 1080 : h >= 700 ? 720 : h >= 460 ? 480 : h > 0 ? 360 : 0;
    const byW = w >= 1800 ? 1080 : w >= 1200 ? 720 : w >= 800 ? 480 : w > 0 ? 360 : 0;
    const t = Math.max(byH, byW);
    return t ? `${t}p` : null;
}

function videoCodecOf(masterText, masterUrl) {
    const stated = hls.videoCodecFamily(hls.masterCodecs(masterText));
    if (stated) return stated;
    let u = String(masterUrl || '');
    try { u += ' ' + decodeURIComponent(u); } catch { /* keep raw */ }
    return /(h265|hevc|x265|hvc1|hev1)/i.test(u) ? 'hevc' : null;
}

// Pure: the row for one fetched master. Exported for tests.
function streamFromMaster(entry, masterText, masterUrl, base, originalLang) {
    const levels = hls.parseLevels(masterText, masterUrl);
    if (!levels.length) return null;
    const page = pageLanguage(entry, originalLang);
    const renditions = hls.parseMedia(masterText, masterUrl, 'AUDIO');
    const audio = renditions.map((m) => {
        const stated = langName(m.languageCode);
        // The page names the master's one language; only a single untagged
        // rendition can be that one. Several: leave them as the master states.
        const language = stated || (renditions.length === 1 ? page.language : null);
        return { language, name: m.name || null, channels: m.channels || null, codec: null, default: m.isDefault };
    });
    if (renditions.length === 1 && audio[0].language && page.language && audio[0].language !== page.language) {
        console.log(`[vidrift] page says ${page.language}, master says ${audio[0].language} for ${masterUrl} - master wins`);
    }
    const languages = renditions.length
        ? [...new Set(audio.map((a) => a.language).filter(Boolean))]
        : (page.language ? [page.language] : []);
    const quality = tierOf(levels[0]) || 'Auto';
    const label = languages.length ? languages.join('/') : (page.label || 'Unknown');
    const subtitles = hls.parseMedia(masterText, masterUrl, 'SUBTITLES')
        .filter((s) => s.url)
        .map((s, i) => ({ url: s.url, lang: s.languageCode || s.name || `Subtitle ${i + 1}`, id: `vr-sub-${i}` }));
    return {
        name: `Vidrift | ${quality} | ${label}`,
        title: `Vidrift · Orion · ${label}`,
        url: masterUrl,
        provider: 'vidrift',
        quality,
        container: 'hls',
        languages,
        audio,
        selectableAudio: audio.some((a) => a.language),
        levels: levels.map((l) => ({ height: l.height, quality: tierOf(l), bandwidth: l.bandwidth, codecs: l.codecs })),
        codecs: hls.masterCodecs(masterText),
        videoCodec: videoCodecOf(masterText, masterUrl),
        subtitles,
        headers: streamHeaders(base),
    };
}

// A signal that aborts at min(stepMs, what is left of the budget).
function stepSignal(stepMs, deadline) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('vidrift: budget exhausted');
    return AbortSignal.timeout(Math.min(stepMs, left));
}

// First host whose page carries embedMeta with an orionStreams array.
// Throws when none does, so the fan-out records an error and does not cache
// "no streams". Returns the hosts left to try for masters, page host first.
async function fetchPage(tmdbId, type, season, episode, deadline) {
    const errors = [];
    for (let i = 0; i < BASES.length; i++) {
        const base = BASES[i];
        const url = embedUrl(base, tmdbId, type, season, episode);
        const t0 = Date.now();
        try {
            const res = await _deps.getPage(url, { 'User-Agent': UA, Referer: PAGE_REFERER },
                stepSignal(_config.pageTimeoutMs, deadline));
            if (!(res.status >= 200 && res.status < 300)) throw new Error(`HTTP ${res.status}`);
            const meta = parseEmbedMeta(res.text);
            if (!meta) throw new Error('no embedMeta in page');
            if (!Array.isArray(meta.orionStreams)) throw new Error(`orionStreams ${meta.orionStreams === null ? 'null' : 'missing'}`);
            console.log(`[vidrift] page ${base} ${Date.now() - t0}ms`);
            return { meta, bases: [base, ...BASES.filter((b) => b !== base)] };
        } catch (e) {
            const msg = e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ERR_CANCELED'
                ? `no answer in ${Date.now() - t0}ms` : e.message;
            errors.push(`${base}: ${msg}`);
            console.log(`[vidrift] host ${base} failed for ${tmdbId} (${Date.now() - t0}ms): ${msg}`);
            if (Date.now() >= deadline) break;
        }
    }
    throw new Error(`vidrift: every host failed for ${tmdbId}: ${errors.join('; ')}`);
}

// One master: the page host first, then the mirrors, inside the budget.
async function fetchMaster(entry, bases, deadline, originalLang) {
    const errors = [];
    for (const base of bases) {
        const masterUrl = new URL(entry.url || entry.proxyUrl, `${base}/`).href;
        const t0 = Date.now();
        try {
            const r = await fetch(masterUrl, { headers: streamHeaders(base), signal: stepSignal(_config.masterTimeoutMs, deadline) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const row = streamFromMaster(entry, await r.text(), masterUrl, base, originalLang);
            if (!row) throw new Error('no variants');
            console.log(`[vidrift] "${entry.name}" -> ${row.languages.join('/') || 'unlabelled'} ${row.quality} `
                + `${row.videoCodec || '?'} audio=${row.audio.length} ${base} (${Date.now() - t0}ms)`);
            return { row };
        } catch (e) {
            const msg = e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer in ${Date.now() - t0}ms` : e.message;
            errors.push(`${new URL(base).host} ${msg}`);
            if (Date.now() >= deadline) break;
        }
    }
    return { error: `"${entry.name}" ${errors.join(', ')}` };
}

async function getVidriftStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    if (type === 'tv' && !(seasonNum && episodeNum)) {
        console.log(`[vidrift] tv ${tmdbId} without season/episode - no rows (never guess S1E1)`);
        return [];
    }
    console.log(`[vidrift] Fetching streams for TMDB ID: ${tmdbId}, Type: ${type}`);
    const deadline = Date.now() + _config.budgetMs;
    // Started now, read only if a page entry says "Original".
    const origP = _deps.originalLanguage(type, tmdbId).catch((e) => {
        console.log(`[vidrift] TMDB original_language unknown for ${tmdbId}: ${e.message}`);
        return null;
    });

    const { meta, bases } = await fetchPage(tmdbId, type, seasonNum, episodeNum, deadline);
    const entries = meta.orionStreams
        .filter((s) => s && (s.url || s.proxyUrl) && (s.type || 'hls') === 'hls');
    if (!entries.length) {
        console.log(`[vidrift] page lists no orion streams for ${tmdbId}`);
        return [];
    }
    let originalLang = null;
    if (entries.some((e) => /·\s*original\s*$/i.test(String(e.name || '')))) {
        const left = Math.max(0, deadline - Date.now());
        originalLang = await Promise.race([origP, new Promise((r) => setTimeout(() => r(null), left).unref())]);
    }

    const results = await Promise.all(entries.map((e) => fetchMaster(e, bases, deadline, originalLang)));
    const failed = results.filter((r) => r.error).map((r) => r.error);
    const seen = new Set();
    const out = results.map((r) => r.row).filter((r) => r && !seen.has(r.url) && seen.add(r.url));
    if (!out.length) throw new Error(`vidrift: every master failed for ${tmdbId}: ${failed.join('; ')}`);
    if (failed.length) {
        out.upstreamError = `vidrift master(s) failed: ${failed.join('; ')}`.slice(0, 300);
        console.log(`[vidrift] ${failed.length} master(s) dropped for ${tmdbId}: ${failed.join('; ')}`);
    }
    console.log(`[vidrift] Got ${out.length} stream(s) for ${tmdbId}: ${out.map((r) => r.languages.join('/') || '?').join(', ')}`);
    return out;
}

module.exports = {
    getVidriftStreams,
    BASES,
    streamHeaders,
    embedUrl,
    parseEmbedMeta,
    pageLanguage,
    streamFromMaster,
    _config,
    _deps,
};
