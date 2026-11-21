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

// EVERY VIDBOLT SERVER. /api/resolve with no server choice walks VidBolt's
// servers and returns the first that has the title, and which one answers
// varies: RRR (579974) gave `luna` (1 source, no language) at 14:16 and
// `callisto` (6 sources, 2 Telugu) at 14:22 on 2026-11-21. `only=<id>` asks one
// server (null stream when it lacks the title); `exclude=<a,b>` walks the rest.
// So every server is asked in parallel with `only=`, beside the plain resolve,
// and the rows are merged, deduped by master (masterKey). The server ids come
// from the embed page's "servers" JSON (cached SERVER_LIST_TTL_MS), with
// FALLBACK_SERVERS until it is read. Measured 2026-11-21, `only=` per server:
// RRR orion/quasar 0.7-0.9 s null, callisto 1.1 s, luna 3.7 s, vega 9.2 s and
// quantum 10.8 s null; 1423253 callisto 1.7 s (6 languages incl. Telugu),
// orion 2.2 s, quantum 14.1 s (4K). The plain resolve took 2.0-2.6 s. Each
// call is capped at resolveStepMs; the phase ends when all have answered, or
// when the plain resolve has answered and settleMs has passed, so a slow
// server does not hold the common case. Masters start as each answer lands.
// VidBolt's Cloudflare answers 403 to /api/resolve without a Referer.

const ORIGIN = 'https://vidbolt.xyz';
// Today's values; routes/resolve-config.json carries the same (provider
// self-heal Task 3). vidbolt.pro is a measured live mirror (spec row 7), tried
// only after the first base fails.
const CONFIG_DEFAULTS = {
    bases: [ORIGIN, 'https://vidbolt.pro'],
    resolvePath: '/api/resolve',
    playerPath: '/movie/{id}',
    sites: ['https://multimovies.wtf'],
    scrapers: ['https://raw.githubusercontent.com/mayurgj/nama/main/providers/multimovies.js'],
};
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0 Mobile Safari/537.36';
const MASTER_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 5000;
// vidbolt.xyz/movie/579974 embed page, "servers", 2026-11-21.
const FALLBACK_SERVERS = Object.freeze(['orion', 'callisto', 'luna', 'vega', 'quantum', 'quasar']);
const SERVER_LIST_TTL_MS = 6 * 60 * 60 * 1000;
// Mutable for tests only.
const _config = {
    audioTimeoutMs: 8000,
    tmdbWaitMs: Number(process.env.MULTIMOVIES_TMDB_WAIT_MS) || 2000,
    // Hard wall clock for the whole call, below the 20 s registry deadline.
    budgetMs: 15000,
    // Cap on each /api/resolve and embed-page call.
    resolveStepMs: 5000,
    // After the plain resolve answers, stop waiting for slower servers once
    // this much time has passed since the start.
    settleMs: 2000,
    // After an HTTP 429 from VidBolt, ask only the plain resolve for this long.
    throttleCooldownMs: 60000,
    // Per-server cooldown after COOLDOWN_STREAK unanswered asks in a row.
    cooldownMs: 60 * 60 * 1000,
};
// TMDB original_language ("te") or null; replaceable for tests.
const _deps = {
    originalLanguage: async (type, tmdbId) => {
        const d = await require('../utils/tmdb').getDetails(type, tmdbId);
        return (d && d.original_language) || null;
    },
};

// `promise`, or `fallback` after `ms`. The timer is always cleared.
function withCap(promise, ms, fallback) {
    let timer;
    const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
    return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}
const DISGUISE_CACHE_MS = 6 * 60 * 60 * 1000;

// Headers the stream host gets through /m3u8-proxy. The scraper sent VidBolt's
// own Referer/Origin on every playlist and segment fetch.
// STREAM_HEADERS is today's value (exported); rows use streamHeaders(), which
// follows a config edit or a heal of the VidBolt host.
const STREAM_HEADERS = { 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN };
const upstream = require('../utils/upstreamBase');
const selfheal = require('../lib/selfheal/config');
const strip = (u) => String(u).replace(/\/+$/, '');
const mmSeed = () => strip(selfheal.cfg('multimovies', 'bases', CONFIG_DEFAULTS.bases)[0]);
// The live VidBolt origin for THIS call (a heal or remote edit wins over today's).
function origin() { return upstream.getBase('multimovies', mmSeed()); }
function streamHeaders() {
    const o = origin();
    return { 'User-Agent': UA, Referer: `${o}/`, Origin: o };
}
function resolvePath() {
    const p = selfheal.cfg('multimovies', 'resolvePath', CONFIG_DEFAULTS.resolvePath);
    return /^\/[\w./-]*$/.test(p) ? p : CONFIG_DEFAULTS.resolvePath;
}
// healRun: the VidBolt discovery chain (lib/selfheal/vidbolt.js), one per
// rediscover, so its GET and validation caps are per run.
// The VidBolt player page path (`/movie/{id}`), used as Referer and for the
// server-list page. Config or a `playerPath` heal may change it.
function playerPath(tmdbId) {
    const t = selfheal.cfg('multimovies', 'playerPath', CONFIG_DEFAULTS.playerPath);
    return (/^\/[^\s]*\{id\}/.test(t) ? t : CONFIG_DEFAULTS.playerPath).replace('{id}', tmdbId);
}
const UPSTREAM = {
    name: 'multimovies',
    get seed() { return mmSeed(); },
    healRun: () => require('../lib/selfheal/vidbolt').createRun(),
};

function embedPath(tmdbId, mediaType, season, episode) {
    return mediaType === 'tv'
        ? `tv/${tmdbId}/${season || 1}/${episode || 1}`
        : `movie/${tmdbId}`;
}

// `server` null: VidBolt picks. Else `only=<server>`.
function resolveUrl(tmdbId, mediaType, season, episode, server = null) {
    const base = mediaType === 'tv'
        ? `${origin()}${resolvePath()}?type=tv&id=${tmdbId}&season=${season || 1}&episode=${episode || 1}`
        : `${origin()}${resolvePath()}?type=movie&id=${tmdbId}`;
    return server ? `${base}&only=${encodeURIComponent(server)}` : base;
}

// Server ids from the embed page's config JSON ("servers":[{"id":"orion",...}]).
// null when the page has none we can read.
function parseServerIds(html) {
    const m = /"servers"\s*:\s*(\[[^\]]*\])/.exec(String(html || ''));
    if (!m) return null;
    try {
        const ids = JSON.parse(m[1]).map((s) => s && s.id).filter((id) => typeof id === 'string' && /^[a-z0-9_-]{1,32}$/i.test(id));
        return ids.length ? [...new Set(ids)] : null;
    } catch { return null; }
}

// Last server list read from an embed page: { ids, at }.
let serverList = null;
// VidBolt rate-limits per IP: about 16 /api/resolve calls inside ~15 s gave
// HTTP 429 on every call (2026-11-21 14:26-14:27 UTC, this Mac). After a 429
// the per-server fan-out (7 calls) pauses and only the plain resolve runs.
let throttledUntil = 0;

// PER-SERVER COOLDOWN (owner ruling 2026-11-21). A server with no 2xx answer
// (cut, timeout, HTTP error; a 429 leaves the streak as is) on COOLDOWN_STREAK asks in a row, across
// titles, is not asked for COOLDOWN_MS, and its absence does not make a result
// partial. After the hour one ask probes it (one at a time): 2xx clears the
// streak, anything else starts another hour. quantum was unheard on 14 of 14
// counted runs (2026-11-21), which made every answer partial and uncached.
// callisto is never cooled: it carries the Telugu masters (RRR, 1423253).
const COOLDOWN_STREAK = 3;
const NEVER_COOLED = new Set(['callisto']);
// id -> { streak, until, probing }
const serverHealth = new Map();
function health(id) {
    if (!serverHealth.has(id)) serverHealth.set(id, { streak: 0, until: 0, probing: false });
    return serverHealth.get(id);
}
// True when `id` must not be asked now. Claims the single probe when the hour is over.
function cooling(id) {
    if (NEVER_COOLED.has(id)) return false;
    const h = health(id);
    if (h.streak < COOLDOWN_STREAK) return false;
    if (Date.now() < h.until || h.probing) return true;
    h.probing = true;
    console.log(`[multimovies] server-cooldown probe ${id} streak=${h.streak}`);
    return false;
}
function recordServer(id, ok) {
    const h = health(id);
    h.probing = false;
    if (ok) {
        if (h.streak >= COOLDOWN_STREAK) console.log(`multimovies: server-cooldown ${id} off streak=0`);
        h.streak = 0;
        h.until = 0;
        return;
    }
    h.streak += 1;
    if (h.streak >= COOLDOWN_STREAK && !NEVER_COOLED.has(id)) {
        h.until = Date.now() + _config.cooldownMs;
        console.log(`multimovies: server-cooldown ${id} on streak=${h.streak}`);
    }
}
function knownServers() {
    return serverList && Date.now() - serverList.at < SERVER_LIST_TTL_MS ? serverList.ids : null;
}

// A master's stable identity across servers and re-resolves: the sacdn encode
// id when the url names one, else the inner host + path (the query holds
// rotating signatures). `?url=` wrappers (dash-hls-bridge) are unwrapped up to
// 3 deep. Same rule as the APK's MultiMoviesResolver.masterKey.
function masterKey(url) {
    let u = String(url || '');
    for (let i = 0; i < 3; i++) {
        let inner = null;
        try { inner = new URL(u).searchParams.get('url'); } catch { break; }
        if (!inner || !/^https?:/i.test(inner)) break;
        u = inner;
    }
    const id = /\/(\d{10,})_/.exec(u);
    if (id) return id[1];
    try { const p = new URL(u); return p.host + p.pathname; } catch { return u.split('?')[0]; }
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

// "Original" is not always the TMDB original language: Vidrift's "Original"
// for 1261763 (TMDB te) is the Tamil track (vidrift.js originalLanguageFor).
// When another source of the same title names that language itself, the
// "Original" source stays unlabelled: unknown, never a wrong tag. `sources`:
// every source VidBolt listed this call, across servers. Pure, exported.
function originalLanguageFor(sources, originalLang) {
    const language = knownLanguage(originalLang);
    if (!language) return null;
    const named = (sources || [])
        .filter((s) => !/^original$/i.test(String((s && s.language) || '').trim()))
        .map((s) => sourceLanguage(s));
    return named.includes(language) ? null : originalLang;
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

// An HLS playlist URL (.m3u8 in the path, or in a ?url= the bridge wraps).
// Old APKs (1.2.40) sideload row.subtitles as VTT, and a playlist there
// blocked start on a phone. The master already carries the HLS subtitle
// track, so only real vtt/srt files go in row.subtitles.
function isHlsPlaylistUrl(url) {
    let u = String(url || '');
    try { u += ' ' + decodeURIComponent(u); } catch { /* keep raw */ }
    return /\.m3u8?(?=$|[?#&\s])/i.test(u);
}

// Pure: the stream row for one fetched master. Exported for tests.
function streamFromMaster(src, masterText, masterUrl, deadAudioUrls = null, originalLang = null) {
    const levels = hls.parseLevels(masterText, masterUrl);
    if (!levels.length) return null;
    const audio = audioFromMaster(masterText, masterUrl, deadAudioUrls, sourceLanguage(src, originalLang));
    const languages = teluguFirst([...new Set(audio.map((a) => a.language).filter(Boolean))]);
    const quality = tierOf(levels[0]) || (/\b(2160|1440|1080|720|480|360)p\b/i.exec(src.quality || '') || [])[0] || 'Auto';
    const subtitles = hls.parseMedia(masterText, masterUrl, 'SUBTITLES')
        .filter((s) => s.url && !isHlsPlaylistUrl(s.url))
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
        headers: streamHeaders(),
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
        const res = await fetch(levelUrl, { headers: streamHeaders(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return null;
        const text = await res.text();
        const seg = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        if (!seg) return null;
        const r = await fetch(hls.resolveUri(seg, levelUrl), {
            headers: { ...streamHeaders(), Range: 'bytes=0-15' },
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
// `capMs` below audioTimeoutMs means the call budget cut the wait short: a
// rendition that did not answer in that shorter window is kept, not dropped.
async function deadAudioUrls(masterText, masterUrl, tmdbId, capMs = _config.audioTimeoutMs) {
    const media = hls.parseMedia(masterText, masterUrl, 'AUDIO').filter((m) => m.url);
    const dead = new Set();
    const cut = capMs < _config.audioTimeoutMs;
    await Promise.all(media.map(async (m) => {
        const t0 = Date.now();
        try {
            const r = await fetch(m.url, { headers: streamHeaders(), signal: AbortSignal.timeout(Math.max(1, capMs)) });
            if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (e) {
            if (cut && e.name === 'TimeoutError') {
                console.log(`[multimovies] audio rendition ${m.languageCode || m.name || '?'} kept for ${tmdbId}: `
                    + `budget left only ${capMs}ms to check it`);
                return;
            }
            dead.add(m.url);
            console.log(`[multimovies] audio rendition ${m.languageCode || m.name || '?'} dropped for ${tmdbId}: `
                + `${e.name === 'TimeoutError' ? `no answer in ${_config.audioTimeoutMs}ms` : e.message} (${Date.now() - t0}ms)`);
        }
    }));
    return dead;
}

// One /api/resolve call. { ok: true, server, sources } on 2xx JSON (sources:
// hls only, may be empty); { ok: false, timedOut, error } otherwise.
async function askVidbolt(url, referer, signal) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer }, signal });
        if (!res.ok) return { ok: false, timedOut: false, status: res.status, error: `HTTP ${res.status}` };
        const body = await res.json();
        const stream = body && body.stream;
        const sources = ((stream && stream.sources) || []).filter((s) => s && s.url && s.kind === 'hls');
        return { ok: true, server: (stream && stream.server) || null, sources };
    } catch (e) {
        const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
        return { ok: false, timedOut, error: timedOut ? 'no answer in time' : (e && e.message) || String(e) };
    }
}

async function getMultimoviesStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    console.log(`[multimovies] Fetching streams for TMDB ID: ${tmdbId}, Type: ${type}`);
    const t0 = Date.now();
    const deadline = t0 + _config.budgetMs;
    const left = () => deadline - Date.now();
    const path = embedPath(tmdbId, type, seasonNum, episodeNum);
    const referer = type === 'movie' ? `${origin()}${playerPath(tmdbId)}` : `${origin()}/${path}`;
    const phase = new AbortController();
    const stepSignal = () => AbortSignal.any([phase.signal, AbortSignal.timeout(Math.max(1, Math.min(_config.resolveStepMs, left())))]);

    // Only when a source says "Original": the title's TMDB original_language
    // (cached 6 h in utils/tmdb.js), started on the first such source, capped
    // at tmdbWaitMs; unknown or late -> null, that row stays unlabelled.
    let originalP = null;
    const original = () => originalP || (originalP = withCap(_deps.originalLanguage(type, tmdbId).catch((e) => {
        console.log(`[multimovies] TMDB original_language unknown for ${tmdbId}: ${e.message}`);
        return null;
    }), _config.tmdbWaitMs, null));

    // One master -> one row (or null). Starts as soon as its server answers.
    const masterJob = async (src) => {
        const origP = /^original$/i.test(String(src.language || '').trim()) ? original() : Promise.resolve(null);
        let text;
        try {
            const cap = Math.min(MASTER_TIMEOUT_MS, left());
            if (cap <= 0) throw new Error('budget exhausted');
            const r = await fetch(src.url, { headers: streamHeaders(), signal: AbortSignal.timeout(cap) });
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
        const audioCap = Math.max(0, Math.min(_config.audioTimeoutMs, left()));
        const dead = await deadAudioUrls(text, src.url, tmdbId, audioCap);
        let originalLang = await origP;
        if (originalLang) {
            // Every server's list is known once the ask phase ends (the
            // caller awaits that before any row, so this adds no wait).
            await phaseDone;
            const listed = [...answers.values()].flatMap((a) => (a && a.ok ? a.sources : []));
            const kept = originalLanguageFor(listed, originalLang);
            if (!kept) {
                console.log(`[multimovies] "Original" not labelled ${knownLanguage(originalLang)} for ${tmdbId}: `
                    + `another source names ${knownLanguage(originalLang)} - stays unlabelled`);
            }
            originalLang = kept;
        }
        const row = streamFromMaster(src, text, src.url, dead, originalLang);
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
    };

    // Resolve phase: the plain resolve, `only=` for every known server, and
    // (when the cached list is stale) the embed page for the current list.
    const throttled = Date.now() < throttledUntil;
    const listed = throttled ? [] : knownServers();
    const servers = [...(listed || FALLBACK_SERVERS)];
    // Servers actually asked this call (cooled ones are skipped).
    const asked = [];
    const cooled = [];
    if (throttled) console.log(`[multimovies] vidbolt throttled (429) until +${throttledUntil - Date.now()}ms: plain resolve only for ${tmdbId}`);
    const answers = new Map(); // ask label -> result
    const jobs = new Map(); // masterKey -> Promise<row|null>
    let pending = 0;
    let endPhase;
    const phaseDone = new Promise((r) => { endPhase = r; });
    const check = () => {
        if (pending === 0) endPhase('all answered');
        else if (answers.has('default') && Date.now() - t0 >= _config.settleMs) endPhase('settled');
    };
    const track = (p) => { pending += 1; p.finally(() => { pending -= 1; check(); }); };
    const ask = (server) => track(askVidbolt(resolveUrl(tmdbId, type, seasonNum, episodeNum, server), referer, stepSignal()).then((a) => {
        answers.set(server || 'default', a);
        if (a.status === 429) throttledUntil = Date.now() + _config.throttleCooldownMs;
        if (!throttled && a.ok && a.server && !servers.includes(a.server)) {
            // VidBolt named a server we do not list yet: ask it too.
            servers.push(a.server);
            askServer(a.server);
        }
        for (const src of a.ok ? a.sources : []) {
            const k = masterKey(src.url);
            if (!jobs.has(k)) jobs.set(k, masterJob(src));
        }
    }));
    function askServer(id) {
        if (cooling(id)) { cooled.push(id); return; }
        asked.push(id);
        ask(id);
    }
    ask(null);
    servers.forEach((s) => askServer(s));
    if (!listed) {
        track(fetch(referer, { headers: { 'User-Agent': UA, Referer: `${origin()}/` }, signal: stepSignal() })
            .then((r) => (r.ok ? r.text() : null))
            .then((html) => {
                const ids = parseServerIds(html);
                if (!ids) {
                    console.log(`[multimovies] server list unreadable from embed page, using ${servers.join(',')}`);
                    return;
                }
                serverList = { ids, at: Date.now() };
                const added = ids.filter((id) => !servers.includes(id));
                console.log(`[multimovies] server list from embed page: ${ids.join(',')}${added.length ? ` (new: ${added.join(',')})` : ''}`);
                added.forEach((id) => { servers.push(id); askServer(id); });
            })
            .catch((e) => console.log(`[multimovies] server list fetch failed, using ${servers.join(',')}: ${e.message}`)));
    }
    const settleTimer = setTimeout(check, _config.settleMs);
    const capTimer = setTimeout(() => endPhase('step cap'), _config.resolveStepMs);
    const why = await phaseDone;
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    phase.abort();

    // A 429 is VidBolt limiting our whole IP, not this server: the streak is left as is.
    for (const id of asked) {
        const a = answers.get(id);
        if (a && a.status === 429) { health(id).probing = false; continue; }
        recordServer(id, Boolean(a && a.ok));
    }
    const labels = ['default', ...asked];
    const summary = labels.map((l) => {
        const a = answers.get(l);
        if (!a) return `${l}=cut`;
        if (!a.ok) return `${l}=${a.timedOut ? 'timeout' : `error(${a.error})`}`;
        return `${l}=${a.sources.length}${l === 'default' && a.server ? `(${a.server})` : ''}`;
    }).join(' ');
    console.log(`[multimovies] servers for ${tmdbId} after ${Date.now() - t0}ms (${why}): ${summary}`
        + `${cooled.length ? ` cooled=${cooled.join(',')}` : ''}`);

    // Every server we did not hear from (settle cut, timeout, error, 429, or
    // the 429 back-off that asked none) may hold the only Telugu master. Such
    // an answer is partial: apiServer serves it but caches none of it.
    const unheard = labels.filter((l) => { const a = answers.get(l); return !a || !a.ok; });
    const partialWhy = throttled ? 'vidbolt 429 back-off, per-server asks skipped'
        : unheard.length ? `vidbolt server(s) not heard: ${unheard.map((l) => {
            const a = answers.get(l);
            return `${l}(${!a ? 'cut' : a.timedOut ? 'timeout' : a.error})`;
        }).join(',')}` : null;
    const partial = (rows) => {
        if (partialWhy) {
            rows.upstreamError = `multimovies ${partialWhy}`.slice(0, 300);
            console.log(`[multimovies] partial for ${tmdbId}: ${partialWhy}`);
        }
        return rows;
    };

    if (!jobs.size) {
        const def = answers.get('default');
        // Empty is trusted only when VidBolt said so: the plain resolve (which
        // walks every server) or every listed server answered 2xx.
        if ((def && def.ok) || (asked.length && asked.every((s) => answers.get(s) && answers.get(s).ok))) {
            console.log(`[multimovies] no hls source for ${tmdbId} (server=${def && def.server})`);
            return partial([]);
        }
        // Transport error or non-2xx: unknown, not empty. Thrown so the
        // fan-out records an error and does not cache "no streams".
        throw new Error(`multimovies: vidbolt resolve failed for ${tmdbId}: ${summary}`);
    }

    // Rows in ask order (plain resolve first, then servers in list order),
    // each master once.
    const done = new Map();
    await Promise.all([...jobs].map(async ([k, p]) => done.set(k, await p)));
    const out = [];
    const seen = new Set();
    for (const l of labels) {
        const a = answers.get(l);
        for (const src of (a && a.ok) ? a.sources : []) {
            const k = masterKey(src.url);
            if (seen.has(k)) continue;
            seen.add(k);
            if (done.get(k)) out.push(done.get(k));
        }
    }
    partial(out);
    console.log(`[multimovies] Got ${out.length} stream(s) for ${tmdbId} in ${Date.now() - t0}ms`);
    return out;
}

module.exports = {
    getMultimoviesStreams,
    CONFIG_DEFAULTS,
    UPSTREAM,
    _internal: { origin, resolveUrl, streamHeaders },
    STREAM_HEADERS,
    streamFromMaster,
    audioFromMaster,
    originalLanguageFor,
    looksLikeImage,
    tierOf,
    masterKey,
    parseServerIds,
    FALLBACK_SERVERS,
    _config,
    _deps,
    _clearDisguiseCache: () => { disguiseCache.clear(); disguiseInflight.clear(); },
    _disguiseSettled: () => Promise.all([...disguiseInflight.values()]),
    _clearServerList: () => { serverList = null; throttledUntil = 0; serverHealth.clear(); },
    _serverHealth: (id) => ({ ...health(id) }),
    _serverHealthSet: (id, patch) => { Object.assign(health(id), patch); },
    _setServerList: (ids) => { serverList = { ids: [...ids], at: Date.now() }; },
};
