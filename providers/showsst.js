// showsst - a plain JSON api keyed on TMDB id.
//
// Ported from the sibling resolver (ott/apps/resolver/src/resolver/fastsource.js).
// Two things make it worth having despite its ceiling:
//   - it maps on TMDB id directly, so it cannot land on the wrong film the way
//     a title-matched provider can;
//   - it answers in a second or two with no auth, no session, no browser.
//
// HOST HISTORY. The routes (/movie?id=&mode=json, /tv?id=&season=&episode=)
// never changed; only the host did.
//   - api.shows.st until 2026-09-11 (Cloudflare blocked the zone for ToS).
//   - api.vidlove.cc until 2026-11-05: its NS was reset to the registrar's
//     default (ns1.dnsserv.nu/.se), which answer REFUSED, so every resolver
//     returns SERVFAIL. Cloudflare also blocked the HLS CDN phantomflix.net.
//   - api.vidqueen.st and api.vidmario.net since. Found 2026-11-16 in the
//     network's own site 67movies.st, which now embeds player.vidqueen.st.
// SHOWSST_API_BASE + SHOWSST_ORIGIN put one more mirror in front.
//
// THE API GATES ON BROWSER HEADERS. Measured 2026-11-16: with a bare UA +
// Referer it answers 200 {"source":null} for every title (even 155). Dropping
// any one of Accept-Language, Referer, Sec-Fetch-Site/Mode/Dest, sec-ch-ua,
// sec-ch-ua-platform, priority or compression brings the null back. An Origin
// that is not one of its players gets 403 "forbidden". /vphint returns
// {"dc":false} from a residential IP, so a datacenter IP may also be gated.
//
// WHAT IT SERVES NOW. Only the default source answers (sources=s1..s7 are
// null on the titles tried): MovieBox MP4 files, one URL per quality, up to
// 2160p, with byte-range support. The old 1080p HLS ladder ("VidAPI") died
// with phantomflix.net. HLS is still handled in case it returns.
//
// NO SELECTABLE AUDIO. One muxed track in the release language. The api names
// no language, but the MP4 does: ffprobe reads the audio track's own tag
// (mdhd/elng). Measured 2026-11-24: Jailer 937020 MovieBox file tagged `tam`,
// shipped as languages []. Only that tag is used; `und` stays unknown.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.SHOWSST_TIMEOUT_MS) || 12000;
const PROBE_TIMEOUT_MS = 4000;

const MIRRORS = [
    ...(process.env.SHOWSST_API_BASE ? [{
        api: process.env.SHOWSST_API_BASE,
        player: process.env.SHOWSST_ORIGIN || process.env.SHOWSST_API_BASE.replace('//api.', '//player.'),
    }] : []),
    { api: 'https://api.vidqueen.st', player: 'https://player.vidqueen.st' },
    { api: 'https://api.vidmario.net', player: 'https://player.vidmario.net' },
].map((m) => ({ api: String(m.api).replace(/\/+$/, ''), player: String(m.player).replace(/\/+$/, '') }));
const API_BASE = MIRRORS[0].api;
// Today's static mirrors (env mirror excluded); routes/resolve-config.json
// carries the same (provider self-heal Task 3).
const CONFIG_DEFAULTS = {
    mirrors: [
        { api: 'https://api.vidqueen.st', player: 'https://player.vidqueen.st' },
        { api: 'https://api.vidmario.net', player: 'https://player.vidmario.net' },
    ],
};

// A healed api host (utils/upstreamBase.js) goes in front of the static list,
// read per call. Its player is the same name with `api.` -> `player.`, the
// pairing every mirror so far has used.
const upstream = require('../utils/upstreamBase');
const { verifyOne } = require('../lib/media/segmentVerify');
const { probeAudioTracks, cachedAudioTracks } = require('../lib/media/mp4AudioProbe');
const languagesLater = require('../lib/media/languagesLater');
const { canonicalLanguage } = require('../utils/streamSchema');
const playerFor = (api) => api.replace('//api.', '//player.');
const selfheal = require('../lib/selfheal/config');
// Env mirror first (as today), then the config list (remote, else built-in =
// today's static list). Read per call.
function staticMirrors() {
    const list = selfheal.cfg('showsst', 'mirrors', CONFIG_DEFAULTS.mirrors)
        .filter((m) => m && typeof m.api === 'string' && /^https?:\/\//.test(m.api))
        .map((m) => ({ api: m.api.replace(/\/+$/, ''), player: String(m.player || playerFor(m.api)).replace(/\/+$/, '') }));
    const env = process.env.SHOWSST_API_BASE ? [MIRRORS[0]] : [];
    const out = [...env, ...list.filter((m) => !env.some((e) => e.api === m.api))];
    return out.length ? out : MIRRORS;
}
const UPSTREAM = { name: 'showsst', get seed() { return staticMirrors()[0].api; }, player: playerFor };
function mirrors() {
    const base = staticMirrors();
    const api = upstream.getBase('showsst', base[0].api);
    if (api === base[0].api) return base;
    const known = base.find((m) => m.api === api);
    const first = known || { api, player: playerFor(api) };
    return [first, ...base.filter((m) => m !== first)];
}

// Headers for the stream host. The MP4 hosts answer 206 with or without a
// Referer; the player's own Referer is kept as the safe default.
function streamHeaders(player = MIRRORS[0].player) {
    return { 'User-Agent': UA, Referer: `${player}/`, Origin: player };
}

// What Chrome sends on the player's cross-origin fetch. Each one is needed.
function apiHeaders(player) {
    return {
        'User-Agent': UA,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Origin: player,
        Referer: `${player}/`,
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        priority: 'u=1, i',
    };
}

// MovieBox URLs are `.../api?d=<blob>` with no extension, and the proxy sends
// anything without `.mp4`/`.mkv` to /m3u8-proxy, which would read an 8 GB file
// as playlist text. Ask the host what the URL is.
async function probeContainer(url, headers, fallback) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
    if (/\.(mp4|mkv)(\?|$)/i.test(url)) return 'mp4';
    try {
        const res = await fetch(url, {
            headers: { ...headers, Range: 'bytes=0-15' },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const type = String(res.headers.get('content-type') || '').toLowerCase();
        const head = Buffer.from(await res.arrayBuffer()).subarray(0, 16);
        if (head.toString('latin1').startsWith('#EXTM3U') || /mpegurl/.test(type)) return 'hls';
        if (head.subarray(4, 8).toString('latin1') === 'ftyp' || /video\/mp4/.test(type)) return 'mp4';
        if (/matroska|x-mkv/.test(type)) return 'mkv';
    } catch (e) {
        console.log(`[showsst] container probe failed: ${e.message}; assuming ${fallback}`);
    }
    return fallback;
}

// A fragment never leaves the client, so `#.mp4` changes nothing upstream but
// makes processStreamsForProxy pick /ts-proxy (it matches /\.(mp4|mkv)$/).
// 2026-11-24 (movie/1359490): the HLS source listed 1034 segments on
// p16-sg.tiktokcdn.com and each one is a 70 B 1x1 PNG (HTTP 200, image/png),
// with or without Referer/Origin. Players fetched them forever. One read of
// the first segment says so; only that proof drops the source. A timeout or a
// network error is no verdict, and the source stays.
const DEAD_SEGMENT = /^segment (short|html|text)\b/;

async function deadSegments(url, headers) {
    const v = await verifyOne({ url, headers, container: 'hls' });
    return !v.ok && DEAD_SEGMENT.test(v.reason || '') ? v.reason : null;
}

// The MP4's own audio tags, or nothing. ffprobe reads the moov (a few hundred
// KB) and caches per file for 30 min (lib/media/mp4AudioProbe.js, 12 s
// timeout). The answer never waits for it (owner 2026-11-24: ShowsSt went
// from ~2.0 s to 3.0 s average, 5.5 s max, and J2's ?full=1 to 7.5 s): a
// cached tag labels the row now, a cold file is probed in the background and
// the next read carries the tag (lib/media/languagesLater.js).
function shapeAudio(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const audio = tracks.map((t) => ({ ...t, language: (t.language && canonicalLanguage(t.language)) || t.language || null }));
    const languages = [...new Set(audio.map((t) => t.language).filter(Boolean))];
    return { audio, languages };
}

/** Cached tags only: undefined = never probed (probe later), null = probed, nothing usable. */
function fileAudioNow(url, { cached = cachedAudioTracks } = {}) {
    const tracks = cached(url);
    return tracks === undefined ? undefined : shapeAudio(tracks);
}

async function fileAudio(url, headers, { probe = probeAudioTracks } = {}) {
    return shapeAudio(await Promise.resolve().then(() => probe(url, headers)).catch(() => null));
}

function forProxy(url, container) {
    return container === 'mp4' || container === 'mkv' ? `${url}#.${container}` : url;
}

async function callMirror(mirror, path) {
    const res = await fetch(`${mirror.api}${path}`, {
        headers: apiHeaders(mirror.player),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function getShowsstStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[showsst] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    // `season`/`episode` spelled out in full: `s`/`e` get {"error":"missing parameters"}.
    const path = mediaType === 'tv'
        ? `/tv?id=${tmdbId}&season=${seasonNum || 1}&episode=${episodeNum || 1}&mode=json`
        : `/movie?id=${tmdbId}&mode=json`;

    // Fail over on transport errors and non-2xx only. A null source is the
    // shared backend's real answer; asking the next mirror repeats it.
    let body = null; let mirror = null;
    const order = mirrors();
    for (const m of order) {
        try {
            body = await callMirror(m, path);
            mirror = m;
            break;
        } catch (e) {
            console.log(`[showsst] ${m.api} failed for ${tmdbId}: ${e.message}`);
        }
    }
    // Every mirror failed (transport error or non-2xx): unknown, not empty.
    if (!body) throw new Error(`showsst: all ${order.length} mirrors failed for ${tmdbId}`);
    const source = body && body.source;
    if (!source || !source.url) {
        // The mirror answered without a source: not in this catalogue, which
        // must not count toward the breaker.
        console.log(`[showsst] No source url for ${tmdbId}`);
        return Object.assign([], { notListed: true });
    }

    const subtitles = Array.isArray(body.subtitles)
        ? body.subtitles.filter((s) => s && (s.file || s.url)).map((s, i) => ({
            url: s.file || s.url, lang: s.label || s.lang || `Subtitle ${i + 1}`, id: `sst-${i}`,
        }))
        : [];

    const headers = streamHeaders(mirror.player);
    // HEVC is dropped the way the player drops it when the browser cannot decode it.
    const variants = Array.isArray(source.qualities) && source.qualities.length
        ? source.qualities.filter((q) => q && q.url && q.codec !== 'hevc')
            .map((q) => ({ url: q.url, quality: q.quality || 'Auto' }))
        : [{ url: source.url, quality: typeof source.manifest === 'string' ? 'Auto' : '1080p' }];
    if (!variants.length) variants.push({ url: source.url, quality: 'Auto' });

    // One probe: every variant of a source is served by the same host and kind.
    // When the probe cannot answer (lens.surrealviews.com took >4s for 16 bytes
    // on 1376856), a per-quality URL list means separate progressive files;
    // an HLS source carries its ladder inside one master instead.
    const hasQualities = Array.isArray(source.qualities) && source.qualities.length > 0;
    const container = await probeContainer(variants[0].url, headers, hasQualities ? 'mp4' : 'hls');
    const label = source.label || 'source';
    if (container === 'hls') {
        const dead = await deadSegments(variants[0].url, headers);
        if (dead) {
            console.log(`[showsst] dead segments for ${tmdbId} (${label}): ${dead}; source dropped`);
            return [];
        }
    }
    // Each quality is its own file: each is read for its own tags.
    const isFile = container === 'mp4' || container === 'mkv';
    const found = isFile ? variants.map((v) => fileAudioNow(v.url)) : variants.map(() => null);
    const coldIdx = found.map((f, i) => (f === undefined ? i : -1)).filter((i) => i >= 0);
    console.log(`[showsst] Got ${variants.length} stream(s) for ${tmdbId} (${label}, ${container}, ${mirror.api}) `
        + `lang=${found.map((f) => (f === undefined ? 'probing' : (f && f.languages.join('/')) || 'und')).join(',')}`);
    const rows = variants.map((v, i) => ({
        url: forProxy(v.url, container),
        provider: 'showsst',
        languages: found[i] ? found[i].languages : [],
        ...(found[i] ? { audio: found[i].audio } : {}),
        ...(found[i] && found[i].languages.length ? { languageSource: 'mp4-tag' } : {}),
        selectableAudio: false,
        quality: v.quality,
        container,
        subtitles,
        headers,
        title: `showsst · ${label}`,
    }));
    if (coldIdx.length) languagesLater.later('showsst', tmdbId, probeColdFiles(coldIdx.map((i) => ({ row: rows[i], url: variants[i].url })), headers));
    return rows;
}

// Background: ffprobe each cold file, label its row in place, return the changed rows.
function probeColdFiles(cold, headers, { probe = probeAudioTracks } = {}) {
    return async () => {
        const changed = [];
        await Promise.all(cold.map(async ({ row, url }) => {
            const f = await fileAudio(url, headers, { probe });
            if (!f) return;
            row.audio = f.audio;
            if (f.languages.length) { row.languages = f.languages; row.languageSource = 'mp4-tag'; }
            changed.push(row);
        }));
        return changed;
    };
}

module.exports = { getShowsstStreams, fileAudio, fileAudioNow, probeColdFiles, API_BASE, MIRRORS, UPSTREAM, streamHeaders, CONFIG_DEFAULTS, _mirrors: mirrors };
