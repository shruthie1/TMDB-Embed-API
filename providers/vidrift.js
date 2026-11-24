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
// names no language and stays "Original" (never the TMDB original_language,
// pageLanguage). When two entries say Telugu, only the last keeps it
// (teluguClaimWinner). embedMeta.lang is NOT used: Krack, a Telugu
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

// Today's static values (VIDRIFT_BASE excluded); routes/resolve-config.json
// carries the same (provider self-heal Task 3).
const CONFIG_DEFAULTS = {
    bases: ['https://embed.vidrift.net', 'https://embed.vidrift.in'],
    moviePath: '/embed/movie/{id}',
    tvPath: '/embed/tv/{id}/{s}/{e}',
};

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
};

function streamHeaders(base) {
    return { 'User-Agent': UA, Referer: `${base}/`, Origin: base };
}

const { AsyncLocalStorage } = require('async_hooks');
const upstream = require('../utils/upstreamBase');
const selfheal = require('../lib/selfheal/config');
const strip = (u) => String(u).replace(/\/+$/, '');
// A path template under test by a heal run (lib/selfheal/vidrift.js).
const pathTrial = new AsyncLocalStorage();
const okTmpl = (t) => typeof t === 'string' && /^\/[^\s]*\{id\}/.test(t);

function moviePath() {
    const t = pathTrial.getStore() || selfheal.cfg('vidrift', 'moviePath', CONFIG_DEFAULTS.moviePath);
    return okTmpl(t) ? t : CONFIG_DEFAULTS.moviePath;
}
function tvPath() {
    const t = selfheal.cfg('vidrift', 'tvPath', CONFIG_DEFAULTS.tvPath);
    return okTmpl(t) && t.includes('{s}') && t.includes('{e}') ? t : CONFIG_DEFAULTS.tvPath;
}

// Hosts for THIS call, in order: VIDRIFT_BASE, a heal, config bases, today's
// BASES. Inside a heal verify (upstream.withBase) only the candidate, so a pass
// proves the candidate and not a fallback host.
const vidriftSeed = () => strip(selfheal.cfg('vidrift', 'bases', CONFIG_DEFAULTS.bases)[0]);
function liveBases() {
    const pin = upstream.pinned('vidrift');
    if (pin) return [pin];
    const cfgBases = selfheal.cfg('vidrift', 'bases', CONFIG_DEFAULTS.bases).map(strip);
    const env = process.env.VIDRIFT_BASE ? [strip(process.env.VIDRIFT_BASE)] : [];
    return [...new Set([...env, upstream.getBase('vidrift', vidriftSeed()), ...cfgBases, ...BASES])];
}

function embedUrl(base, tmdbId, mediaType, season, episode) {
    return mediaType === 'tv'
        ? `${base}${tvPath().replace('{id}', tmdbId).replace('{s}', season).replace('{e}', episode)}`
        : `${base}${moviePath().replace('{id}', tmdbId)}`;
}

// healRun: shared title-page trail + validator (lib/selfheal/vidrift.js). Its
// own-resolve check is RRR 579974, the title vidrift is verified on.
const VERIFY_TITLE = { tmdbId: '579974', mediaType: 'movie' };
const UPSTREAM = {
    name: 'vidrift',
    get seed() { return vidriftSeed(); },
    verifyTitle: VERIFY_TITLE,
    healRun: () => require('../lib/selfheal/vidrift').createRun({
        // The provider's own resolve of RRR with a trial movie path.
        ownResolvePath: (tmpl) => pathTrial.run(tmpl, async () => {
            const r = await getVidriftStreams(VERIFY_TITLE.tmdbId, VERIFY_TITLE.mediaType);
            return Array.isArray(r) && r.length > 0;
        }),
    }),
};

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

// "<lang> sub/subs/subbed/subtitles" carries the original audio with
// subtitles, so it is never an audio language (same rule as
// multimovies.js sourceLanguage and the APK VidriftResolver).
function langName(raw) {
    const k = String(raw || '').trim();
    if (!k || /^(und|unk|mul|zxx|original)$/i.test(k)) return null;
    if (/\bsub(s|bed|titles?)?$/i.test(k)) return null;
    return LABEL_LANG[k.toLowerCase()] || k;
}

// "Orion · Telugu" -> { language: 'Telugu', label: 'Telugu' }.
// "Orion · Original" -> { language: null, label: 'Original' }, always.
// "Original" is not the TMDB original language. 1261763 (TMDB te): its
// Original audio is the Tamil track (byte-identical, 2026-11-21). Live
// 2026-11-22: RRR (TMDB te) listed only Original, prod labelled it Telugu,
// and its audio is byte-identical to MultiMovies' "English" RRR source
// (0 of 666,405 bytes differ; speech ID ta/hi, the phone saw lang=und).
// Jailer (TMDB ta): Original is byte-identical to a MovieBox Malayalam source
// (speech ID ml 1.00). Unknown, never a guessed tag. Pure, exported.
function pageLanguage(entry) {
    const label = String((entry && entry.name) || '').replace(/^.*·\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim();
    if (!label) return { language: null, label: null };
    if (/^original$/i.test(label)) return { language: null, label: 'Original' };
    const language = langName(label);
    return { language, label: language };
}

// Two page entries may each say Telugu; at most one is (multimovies.js
// teluguClaimWinner: the RRR MovieBox pair, first Tamil, second Telugu).
// Only the LAST Telugu entry in page order keeps it. Returns that entry's
// index in `entries`, or null with fewer than two claims. Telugu only: a
// wrong Telugu row plays first. Pure, exported.
function teluguClaimWinner(entries) {
    const idx = (entries || []).map((e, i) => (pageLanguage(e).language === 'Telugu' ? i : -1)).filter((i) => i >= 0);
    return idx.length >= 2 ? idx[idx.length - 1] : null;
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

// An HLS playlist URL (.m3u8 in the path, or in a ?url= the bridge wraps).
// Old APKs (1.2.40) sideload row.subtitles as VTT, and a playlist there
// blocked start on a phone. The master already carries the HLS subtitle
// track, so only real vtt/srt files go in row.subtitles.
function isHlsPlaylistUrl(url) {
    let u = String(url || '');
    try { u += ' ' + decodeURIComponent(u); } catch { /* keep raw */ }
    return /\.m3u8?(?=$|[?#&\s])/i.test(u);
}

// Pure: the row for one fetched master. Exported for tests.
// `opts.dropLabel`: this entry's Telugu lost to a later entry's
// (teluguClaimWinner): the page label is not stamped.
function streamFromMaster(entry, masterText, masterUrl, base, opts = null) {
    const levels = hls.parseLevels(masterText, masterUrl);
    if (!levels.length) return null;
    const listed = pageLanguage(entry);
    const dropLabel = Boolean(opts && typeof opts === 'object' && opts.dropLabel && listed.language);
    // The note names no language: normaliseStream reads language words from
    // name/title when languages[] is empty, and would put Telugu back. The
    // listed label stays in the `telugu-claim dropped` log line.
    const page = dropLabel ? { language: null, label: 'Unknown' } : listed;
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
    const note = dropLabel && !languages.includes(listed.language) ? ' [duplicate listing, unverified]' : '';
    const subtitles = hls.parseMedia(masterText, masterUrl, 'SUBTITLES')
        .filter((s) => s.url && !isHlsPlaylistUrl(s.url))
        .map((s, i) => ({ url: s.url, lang: s.languageCode || s.name || `Subtitle ${i + 1}`, id: `vr-sub-${i}` }));
    return {
        name: `Vidrift | ${quality} | ${label}`,
        title: `Vidrift · Orion · ${label}${note}`,
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
    // A host whose page and embedMeta parse but whose orionStreams is null:
    // the title has no rows there (soak 1, 1496785 on both hosts). Still an
    // error, so the fan-out does not cache it (null was seen to be transient
    // on Krack), but marked titleEmpty so it never feeds the host fail
    // streak or a rediscover (providers/registry.js noteUpstream).
    let titleEmpty = false;
    let nullHosts = 0;
    const bases = liveBases();
    for (let i = 0; i < bases.length; i++) {
        const base = bases[i];
        const url = embedUrl(base, tmdbId, type, season, episode);
        const t0 = Date.now();
        try {
            const res = await _deps.getPage(url, { 'User-Agent': UA, Referer: PAGE_REFERER },
                stepSignal(_config.pageTimeoutMs, deadline));
            if (!(res.status >= 200 && res.status < 300)) throw new Error(`HTTP ${res.status}`);
            const meta = parseEmbedMeta(res.text);
            if (!meta) throw new Error('no embedMeta in page');
            if (meta.orionStreams === null) { titleEmpty = true; nullHosts += 1; throw new Error('orionStreams null'); }
            if (!Array.isArray(meta.orionStreams)) throw new Error('orionStreams missing');
            console.log(`[vidrift] page ${base} ${Date.now() - t0}ms`);
            return { meta, bases: [base, ...bases.filter((b) => b !== base)] };
        } catch (e) {
            const msg = e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ERR_CANCELED'
                ? `no answer in ${Date.now() - t0}ms` : e.message;
            errors.push(`${base}: ${msg}`);
            console.log(`[vidrift] host ${base} failed for ${tmdbId} (${Date.now() - t0}ms): ${msg}`);
            if (Date.now() >= deadline) break;
        }
    }
    // Every host asked answered "orionStreams null": the title is not listed
    // there. Not an error (b5ab4e6 rule, as vidout/insertunit): it must not
    // feed the hub's down streak or the breaker. A mix with a failed host
    // stays an error marked titleEmpty.
    if (nullHosts > 0 && nullHosts === errors.length) {
        console.log(`[vidrift] not-listed ${tmdbId}: orionStreams null on ${nullHosts} host(s)`);
        return { notListed: true };
    }
    const err = new Error(`vidrift: every host failed for ${tmdbId}: ${errors.join('; ')}`);
    if (titleEmpty) {
        err.titleEmpty = true;
        console.log(`[vidrift] title-empty ${tmdbId}: orionStreams null, host not counted`);
    }
    throw err;
}

// One master: the page host first, then the mirrors, inside the budget.
// Returns the raw text; the row is built once the TMDB wait is over.
async function fetchMaster(entry, bases, deadline) {
    const errors = [];
    for (const base of bases) {
        const masterUrl = new URL(entry.url || entry.proxyUrl, `${base}/`).href;
        const t0 = Date.now();
        try {
            const r = await fetch(masterUrl, { headers: streamHeaders(base), signal: stepSignal(_config.masterTimeoutMs, deadline) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const text = await r.text();
            if (!hls.parseLevels(text, masterUrl).length) throw new Error('no variants');
            return { entry, text, masterUrl, base, ms: Date.now() - t0 };
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
    const page = await fetchPage(tmdbId, type, seasonNum, episodeNum, deadline);
    if (page.notListed) return Object.assign([], { notListed: true });
    const { meta, bases } = page;
    const entries = meta.orionStreams
        .filter((s) => s && (s.url || s.proxyUrl) && (s.type || 'hls') === 'hls');
    if (!entries.length) {
        console.log(`[vidrift] page lists no orion streams for ${tmdbId}`);
        return [];
    }
    const results = await Promise.all(entries.map((e) => fetchMaster(e, bases, deadline)));
    const winner = teluguClaimWinner(entries);
    const failed = results.filter((r) => r.error).map((r) => r.error);
    const built = results.filter((r) => !r.error).map((r) => {
        const i = entries.indexOf(r.entry);
        const dropLabel = winner !== null && i !== winner && pageLanguage(r.entry).language === 'Telugu';
        if (dropLabel) {
            console.log(`[vidrift] telugu-claim dropped for ${tmdbId}: entry ${i} "${r.entry.name}" listed Telugu, `
                + `kept entry ${winner} (listed later)`);
        }
        const row = streamFromMaster(r.entry, r.text, r.masterUrl, r.base, { dropLabel });
        console.log(`[vidrift] "${r.entry.name}" -> ${row.languages.join('/') || 'unlabelled'} ${row.quality} `
            + `${row.videoCodec || '?'} audio=${row.audio.length} ${r.base} (${r.ms}ms)`);
        return row;
    });
    const seen = new Set();
    const out = built.filter((r) => r && !seen.has(r.url) && seen.add(r.url));
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
    CONFIG_DEFAULTS,
    UPSTREAM,
    _internal: { liveBases, moviePath, tvPath },
    streamHeaders,
    embedUrl,
    parseEmbedMeta,
    pageLanguage,
    teluguClaimWinner,
    streamFromMaster,
    _config,
    _deps,
};
