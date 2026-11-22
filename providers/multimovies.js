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
const mmDash = require('../lib/media/mmDash');
const mpdHls = require('../lib/media/mpdHls');
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
    // Cap on each source's index.mpd GET (all in parallel). Short: on a miss
    // the title falls back to "last listed wins".
    mpdTimeoutMs: 2500,
};
// Replaceable for tests. (No TMDB lookup: "Original" never takes the
// title's original_language, see sourceLanguage.)
const _deps = {};

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
// they are never an audio language. "Original" names no language: it is NOT
// the title's TMDB original_language. Live 2026-11-22: Vidrift's RRR
// "Original" (TMDB te) is byte-identical to this provider's "English" RRR
// source and speech ID reads ta/hi; Jailer's "Original" (TMDB ta) is
// byte-identical to a MovieBox Malayalam source (ml 1.00). Unknown, never a
// guessed tag. The row keeps "Original" as its label.
function sourceLanguage(src) {
    const raw = String((src && src.language) || '').trim();
    if (!raw || /\bsub(s|bed|titles?)?$/i.test(raw)) return null;
    if (/^original$/i.test(raw)) return null;
    return knownLanguage(raw);
}

const TELUGU = 'Telugu';

// Several sources of one title may each say "Telugu". Live 2026-11-22, RRR:
// VidBolt lists 5820588283537016992 and 5355663801620775816 both as Telugu;
// speech ID reads the first as Tamil (ta 0.60/0.37/0.52) and the second as
// Telugu (te 1.00), and the owner hears the same every time. Only one Telugu
// claim stands: the LAST listed in the first answer that lists two or more.
// Claims never listed together have no order: none stands (unknown over
// wrong). Telugu only, because a wrong Telugu row plays first (Telugu-first
// ranking); Jailer's two "Malayalam" sources are both Malayalam (ml 1.00).
// `lists`: each answer's sources, in answer order. Returns the winning
// masterKey, or null when there is one claim or none (nothing to drop).
// Pure, exported.
function teluguClaimWinner(lists) {
    const claims = (list) => [...new Set((list || [])
        .filter((s) => s && s.url && sourceLanguage(s) === TELUGU)
        .map((s) => masterKey(s.url)))];
    const all = new Set((lists || []).flatMap(claims));
    if (all.size < 2) return null;
    for (const list of lists) {
        const keys = claims(list);
        if (keys.length >= 2) return keys[keys.length - 1];
    }
    return '';
}

// ---- MPD audio lang (2026-11-22, telugu-rule-check.md). Every MovieBox
// source is a bridge over sacdn.hakunaymatata.com/dash/<id>/master.m3u8; the
// bridge drops the DASH `lang`, but index.mpd beside it keeps it, and the
// CloudFront query (Policy, Signature, Key-Pair-Id) signs the whole /dash/<id>/
// folder. Against speech ID on 13 titles: `tel` 6 of 6, tam/kan/hin 4 of 4,
// `eng` 0 of 1 (Vikram's Tamil), `und` no information.
const MPD_HOST = 'sacdn.hakunaymatata.com';
const MPD_EVIDENCE = { tel: TELUGU, te: TELUGU, tam: 'Tamil', ta: 'Tamil', kan: 'Kannada', kn: 'Kannada',
    hin: 'Hindi', hi: 'Hindi', mal: 'Malayalam', ml: 'Malayalam' };

// The signed index.mpd URL for one source, or null when it is not a signed
// sacdn DASH folder. The signature params sit on the innermost URL or on a wrapper.
function mpdUrlOf(url) {
    const layers = [];
    let u = String(url || '');
    for (let i = 0; i < 4; i++) {
        let p;
        try { p = new URL(u); } catch { break; }
        layers.push(p);
        const inner = p.searchParams.get('url');
        if (!inner || !/^https?:/i.test(inner)) break;
        u = inner;
    }
    const target = layers[layers.length - 1];
    if (!target || target.host !== MPD_HOST || !/^\/dash\/[^/]+\//.test(target.pathname)) return null;
    const signed = ['Policy', 'Signature', 'Key-Pair-Id'];
    // Unsigned, sacdn answers 403: no MPD to read.
    const from = [...layers].reverse().find((l) => signed.every((k) => l.searchParams.has(k)));
    if (!from) return null;
    const q = signed.map((k) => `${k}=${encodeURIComponent(from.searchParams.get(k))}`).join('&');
    return `https://${MPD_HOST}${target.pathname.replace(/[^/]*$/, 'index.mpd')}?${q}`;
}

// The audio `lang` of an MPD, lower case, when its audio AdaptationSets name
// exactly one; else null (none, several, or empty).
function mpdAudioLang(text) {
    const langs = new Set();
    for (const m of String(text || '').matchAll(/<AdaptationSet\b[^>]*>/g)) {
        const tag = m[0];
        if (!/contentType="audio"|mimeType="audio\//.test(tag)) continue;
        const l = (/\slang="([^"]*)"/.exec(tag) || [])[1];
        if (l && l.trim()) langs.add(l.trim().toLowerCase());
    }
    return langs.size === 1 ? [...langs][0] : null;
}

// Pure. `lists`: each answer's sources in arrival order. `mpd`: masterKey ->
// { ok: true, lang } | { ok: false, error }; a key with no entry has no MPD.
// Returns { fallback, why, claims, tel, fixed, sources: masterKey ->
// { listed, language, drop, reason, mpd } }. `language` is what the source's
// lone untagged rendition is stamped with.
//  - MPD `tel`/`te`: Telugu, whatever the label ("Kurdish sub" Devara).
//  - Listed Telugu with any other or no tag: Telugu dropped, unverified.
//  - A listed language that a tam/kan/hin/mal tag contradicts: the tag.
//  - `eng`, `und`, no tag: the label stands.
// Fallback (any MPD failed, or a Telugu claim has no MPD): the old rule,
// "last listed wins" (teluguClaimWinner), for the whole title.
function mpdLanguagePlan(lists, mpd) {
    const sources = new Map();
    for (const src of (lists || []).flat()) {
        if (!src || !src.url) continue;
        const k = masterKey(src.url);
        if (!sources.has(k)) sources.set(k, { listed: sourceLanguage(src), language: sourceLanguage(src), drop: false, reason: null, mpd: null });
    }
    const keys = [...sources.keys()];
    const claims = keys.filter((k) => sources.get(k).listed === TELUGU).length;
    const failed = keys.filter((k) => mpd.has(k) && !mpd.get(k).ok);
    const unsigned = keys.filter((k) => sources.get(k).listed === TELUGU && !mpd.has(k));
    if (failed.length || unsigned.length) {
        const winner = teluguClaimWinner(lists);
        for (const [k, s] of sources) {
            if (s.listed === TELUGU && winner !== null && winner !== k) {
                Object.assign(s, { language: null, drop: true, reason: 'duplicate' });
            }
        }
        const why = [failed.length ? `mpd failed ${failed.map((k) => `${k}(${mpd.get(k).error})`).join(',')}` : '',
            unsigned.length ? `no mpd for Telugu claim ${unsigned.join(',')}` : ''].filter(Boolean).join('; ');
        return { fallback: true, why, claims, tel: 0, fixed: 0, sources };
    }
    let tel = 0;
    let fixed = 0;
    for (const [k, s] of sources) {
        const code = mpd.has(k) ? mpd.get(k).lang : null;
        s.mpd = code;
        const evidence = code ? MPD_EVIDENCE[code] || null : null;
        if (evidence === TELUGU) {
            tel += 1;
            if (s.listed !== TELUGU) { s.language = TELUGU; fixed += 1; }
        } else if (s.listed === TELUGU) {
            Object.assign(s, { language: null, drop: true, reason: 'mpd' });
            fixed += 1;
        } else if (evidence && s.listed && evidence !== s.listed) {
            s.language = evidence;
            fixed += 1;
        }
    }
    return { fallback: false, why: null, claims, tel, fixed, sources };
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
// `opts.dropLabel`: this source's "Telugu" is not stamped on the rendition
// (`opts.reason` 'mpd': its MPD tag is not tel; 'duplicate': it lost
// teluguClaimWinner in the fallback). `opts.language`: the language to stamp
// in place of the listed one (mpdLanguagePlan).
function streamFromMaster(src, masterText, masterUrl, deadAudioUrls = null, opts = null) {
    const levels = hls.parseLevels(masterText, masterUrl);
    if (!levels.length) return null;
    const o = opts && typeof opts === 'object' ? opts : {};
    const dropLabel = Boolean(o.dropLabel);
    const listed = sourceLanguage(src);
    // `o.language` (mpdLanguagePlan) replaces the listed language when given.
    const stamp = dropLabel ? null : ('language' in o ? o.language : listed);
    const audio = audioFromMaster(masterText, masterUrl, deadAudioUrls, stamp);
    const languages = teluguFirst([...new Set(audio.map((a) => a.language).filter(Boolean))]);
    const quality = tierOf(levels[0]) || (/\b(2160|1440|1080|720|480|360)p\b/i.exec(src.quality || '') || [])[0] || 'Auto';
    const subtitles = hls.parseMedia(masterText, masterUrl, 'SUBTITLES')
        .filter((s) => s.url && !isHlsPlaylistUrl(s.url))
        .map((s, i) => ({ url: s.url, lang: s.languageCode || s.name || `Subtitle ${i + 1}`, id: `mm-sub-${i}` }));
    // A lone rendition that names no language ("Audio") under an "Original"
    // source reads "Original", as listed.
    const isOriginal = /^original$/i.test(String((src && src.language) || '').trim());
    const named = languages.filter((l) => knownLanguage(l));
    const label = audio.length > 1 ? 'Multi Audio'
        : (isOriginal && !named.length) ? 'Original' : (languages[0] || 'Unknown');
    // No language word in the note: normaliseStream reads language words from
    // name/title when languages[] is empty. The listed label and the MPD tag
    // are in the `telugu-claim dropped` log line.
    const note = dropLabel && listed && !named.includes(listed)
        ? (o.reason === 'mpd' ? ' [audio tag disagrees, unverified]' : ' [duplicate listing, unverified]') : '';
    return {
        name: `MultiMovies | ${quality} | ${label}`,
        title: `MultiMovies · VidBolt · ${label}${languages.length ? ` (${languages.join(', ')})` : ''}${note}`,
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

    // A /dash/ source -> one dash-direct row, or null when its index.mpd GET
    // failed (then masterJob tries the bridge as before). Liveness is that
    // GET: 200 and a video Representation. The bridge is not asked.
    const dashJob = async (src, k) => {
        const m = await mpds.get(k);
        if (!m || !m.ok) {
            // No usable MPD: the old bridge path, so no row is lost to it.
            console.log(`[multimovies] mpd unreadable for ${tmdbId} ${k}: ${(m && m.error) || 'no mpd'} - bridge path`);
            return null;
        }
        const plan = await langPlan();
        const d = plan.sources.get(k);
        // The plan decides (mpd-lang rule). Only in its fallback (another
        // source's MPD failed) does this source's own MPD tag win, as evidence.
        const own = plan.fallback && m.lang ? MPD_EVIDENCE[m.lang] || null : null;
        const language = own || (d ? (d.drop ? null : d.language) : sourceLanguage(src));
        const vmUrl = mmDash.masterUrlFor(mmDash.envBase(), m.mpdUrl, language || '-');
        // The row's master: the route's shape, one untagged "Audio" rendition
        // so streamFromMaster stamps `language` exactly as on bridge rows.
        const rowMaster = mpdHls.masterPlaylist(m.parsed, (rep) => `${vmUrl.split('?')[0].replace(/master\.m3u8$/, '')}${rep.id}.m3u8`,
            { language: { code: null, name: 'Audio' } });
        const row = streamFromMaster(src, rowMaster, vmUrl, null,
            own ? { language: own } : d ? { language: d.language, dropLabel: d.drop, reason: d.reason } : null);
        if (!row) return null;
        const vcodec = m.parsed.reps.find((r) => r.kind === 'video' && r.codecs);
        row.videoCodec = hls.videoCodecFamily(vcodec && vcodec.codecs) || videoCodecOf('', src.url);
        // VM route + sacdn segments need no request headers; the route serves
        // its own playlists, so /m3u8-proxy never wraps it.
        row.headers = {};
        row.__noProxy = true;
        row.dashDirect = true;
        console.log(`[multimovies] master lists ${row.audio.length} audio rendition(s): `
            + `${row.audio.map((a) => a.language || '?').join('/')} - selectable (dash-direct, mpd ${m.lang || '-'})`);
        return row;
    };

    // One master -> one row (or null). Starts as soon as its server answers.
    const masterJob = async (src) => {
        const dk = masterKey(src.url);
        if (mpdUrlOf(src.url) && mpds.has(dk)) {
            const direct = await dashJob(src, dk);
            if (direct) return direct;
        }
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
        // The title's language plan (MPD tags, or the last-wins fallback)
        // needs every answer and every MPD: ready after the ask phase plus
        // at most mpdTimeoutMs.
        const plan = await langPlan();
        const d = plan.sources.get(masterKey(src.url));
        const row = streamFromMaster(src, text, src.url, dead,
            d ? { language: d.language, dropLabel: d.drop, reason: d.reason } : null);
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
    const mpds = new Map(); // masterKey -> Promise<{ ok, lang } | { ok: false, error }>
    // index.mpd for one source of this title, started as its answer lands.
    const fetchMpd = async (mpdUrl) => {
        try {
            const signal = AbortSignal.timeout(Math.max(1, Math.min(_config.mpdTimeoutMs, left())));
            const r = await fetch(mpdUrl, { headers: streamHeaders(), signal });
            if (!r.ok) { if (r.body && r.body.cancel) r.body.cancel().catch(() => {}); return { ok: false, error: `HTTP ${r.status}` }; }
            const text = await r.text();
            if (!/<MPD\b/.test(text)) return { ok: false, error: 'not an MPD' };
            // Kept for the /mm/hls route; throws when no video Representation.
            let parsed;
            try { parsed = mmDash.rememberMpd(mpdUrl, text); } catch (e) { return { ok: false, error: e.message }; }
            return { ok: true, lang: mpdAudioLang(text), mpdUrl, parsed };
        } catch (e) {
            return { ok: false, error: e && e.name === 'TimeoutError' ? `no answer in ${_config.mpdTimeoutMs}ms` : (e && e.message) || String(e) };
        }
    };
    let planP = null;
    const langPlan = () => planP || (planP = phaseDone.then(async () => {
        const lists = [...answers.values()].map((a) => (a && a.ok ? a.sources : []));
        const got = new Map();
        await Promise.all([...mpds].map(async ([k, p]) => got.set(k, await p)));
        const plan = mpdLanguagePlan(lists, got);
        if (plan.fallback) {
            console.log(`[multimovies] mpd-lang fallback for ${tmdbId}: ${plan.why} - last listed Telugu wins`);
            const winner = teluguClaimWinner(lists);
            for (const [k, d] of plan.sources) {
                if (d.drop) {
                    console.log(`[multimovies] telugu-claim dropped for ${tmdbId}: ${k} listed Telugu, `
                        + (winner ? `kept ${winner} (listed later)` : 'claims never listed together - none kept'));
                }
            }
        } else {
            for (const [k, d] of plan.sources) {
                if (d.language === d.listed && !d.drop) continue;
                console.log(`[multimovies] mpd-lang fix for ${tmdbId}: ${k} listed ${d.listed || '-'}, mpd ${d.mpd || '-'}`
                    + ` -> ${d.drop ? 'unverified' : d.language}`);
            }
        }
        console.log(`[multimovies] mpd-lang ${tmdbId} claims=${plan.claims} tel=${plan.tel} fixed=${plan.fixed} fallback=${plan.fallback ? 1 : 0}`);
        return plan;
    }));
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
            if (!mpds.has(k) && !jobs.has(k)) {
                const mpdUrl = mpdUrlOf(src.url);
                if (mpdUrl) mpds.set(k, fetchMpd(mpdUrl));
            }
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
            // VidBolt answered 2xx with no source: no rows for this title.
            // When some server went unheard the answer stays partial (not
            // cached) but is marked titleEmpty, so it never moves the host.
            const rows = partial([]);
            if (rows.upstreamError) rows.titleEmpty = true;
            return rows;
        }
        // Transport error or non-2xx: unknown, not empty. Thrown so the
        // fan-out records an error and does not cache "no streams".
        throw new Error(`multimovies: vidbolt resolve failed for ${tmdbId}: ${summary}`);
    }

    // Rows in ask order (plain resolve first, then servers in list order),
    // each master once.
    const done = new Map();
    // The plan logs its mpd-lang line even when every master fails.
    await Promise.all([langPlan(), ...[...jobs].map(async ([k, p]) => done.set(k, await p))]);
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
    const direct = out.filter((r) => r.dashDirect).length;
    console.log(`[multimovies] dash-direct ${tmdbId} sources=${direct} bridge=${out.length - direct}`);
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
    teluguClaimWinner,
    mpdLanguagePlan,
    mpdUrlOf,
    mpdAudioLang,
    sourceLanguage,
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
