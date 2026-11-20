const { resolveImdbId } = require('../utils/tmdb');
const { masterCodecs } = require('../lib/media/hlsManifest');

const STREAM_API = 'https://streamdata.vaplayer.ru/api.php';
const PLAYER_ORIGIN = 'https://nextgencloudfabric.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// VaPlayer changed its API by 2026-11-15: api.php now returns title and
// file_name only, and stream_urls appear only with a single-use, IP-bound
// api_token. Measured: tt31969655 and tt0816692 both came back without
// stream_urls, so the provider returned 0 on every title (14/14 bench).
// The chain, read from nextgencloudfabric.com/embed/assets/js/player.min.js
// and vadec.js:
//   1. GET vaplayer.ru/embed/va_src.php?path=/embed/<type>/<imdb>[/s/e] -> {src}
//   2. GET src (the player page)            -> CONFIG.apiToken
//   3. GET api.php?...&stream_urls&api_token -> stream_urls, base64 and
//      encrypted, plus va.wasm_url; the WASM exports alloc() and decrypt(),
//      and the plaintext (one url per line) starts at ptr+12.
//   4. GET <stream origin>/generate.php?api_token -> host token, appended as
//      ?token= (or replacing __TOKEN__). Without it the master answers 401.
const upstream = require('../utils/upstreamBase');

// Seed only; wrapperOrigin() is the live host (utils/upstreamBase.js).
const WRAPPER_ORIGIN = process.env.VAPLAYER_WRAPPER_ORIGIN || 'https://vaplayer.ru';
const UPSTREAM = { name: 'vaplayer', seed: WRAPPER_ORIGIN };
function wrapperOrigin() { return upstream.getBase('vaplayer', WRAPPER_ORIGIN); }
// api.php lives on streamdata.<wrapper host>. Unhealed it is the fixed
// STREAM_API; after a heal it follows the new wrapper host. A wrong guess here
// fails verify, so it is never applied.
function streamApi() {
    if (!upstream.isHealed('vaplayer', WRAPPER_ORIGIN)) return STREAM_API;
    return `https://streamdata.${new URL(wrapperOrigin()).host}/api.php`;
}
const STEP_TIMEOUT_MS = Number(process.env.VAPLAYER_STEP_TIMEOUT_MS) || 8000;

function apiHeaders(extra = {}) {
    return { 'User-Agent': USER_AGENT, Referer: `${PLAYER_ORIGIN}/`, Origin: PLAYER_ORIGIN, ...extra };
}

async function getText(url, headers) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${new URL(url).pathname}`);
    return r.text();
}

function embedPath(imdb, type, season, episode) {
    return type === 'tv' ? `/embed/tv/${imdb}/${season}/${episode}` : `/embed/movie/${imdb}`;
}

async function getApiToken(imdb, type, season, episode) {
    const path = embedPath(imdb, type, season, episode);
    const vs = JSON.parse(await getText(
        `${wrapperOrigin()}/embed/va_src.php?path=${encodeURIComponent(path)}`,
        { 'User-Agent': USER_AGENT, Referer: `${wrapperOrigin()}${path}` }));
    if (!vs || !vs.src) return null;
    const page = await getText(vs.src, { 'User-Agent': USER_AGENT, Referer: `${wrapperOrigin()}/` });
    const m = page.match(/"apiToken":"([^"]+)"/);
    return m ? m[1] : null;
}

const wasmCache = new Map(); // va.w -> Promise<WebAssembly.Module>
async function decryptStreamUrls(enc, va) {
    if (!va || !va.wasm_url) return [];
    const key = String(va.w || va.wasm_url);
    if (!wasmCache.has(key)) {
        wasmCache.set(key, fetch(va.wasm_url, { headers: apiHeaders(), signal: AbortSignal.timeout(STEP_TIMEOUT_MS) })
            .then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b))
            .catch((e) => { wasmCache.delete(key); throw e; }));
        while (wasmCache.size > 20) wasmCache.delete(wasmCache.keys().next().value);
    }
    const inst = await WebAssembly.instantiate(await wasmCache.get(key), {});
    const ex = inst.exports;
    const bytes = Buffer.from(enc, 'base64');
    const ptr = ex.alloc(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    const n = ex.decrypt(ptr, bytes.length);
    return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr + 12, n)).split('\n').filter(Boolean);
}

async function hostToken(origin, apiToken) {
    try {
        const t = (await getText(`${origin}/generate.php?api_token=${encodeURIComponent(apiToken)}`, apiHeaders())).trim();
        if (t.startsWith('{') || t.startsWith('[')) {
            const j = JSON.parse(t);
            return typeof j === 'string' ? j : (j.token || j.data || j.string || j.result || '');
        }
        return t;
    } catch {
        return '';
    }
}

function applyToken(url, token) {
    if (!token) return url;
    if (url.includes('__TOKEN__')) return url.split('__TOKEN__').join(token);
    return `${url}${url.includes('?') ? '&' : '?'}token=${token}`;
}

async function fetchStreamUrls(imdb, type, season, episode) {
    try {
        const apiToken = await getApiToken(imdb, type, season, episode);
        if (!apiToken) throw new Error('no apiToken on the player page');

        const params = new URLSearchParams({ imdb, type });
        if (type === 'tv' && season != null && episode != null) {
            params.set('season', String(season));
            params.set('episode', String(episode));
        }
        const url = `${streamApi()}?${params.toString()}&stream_urls&api_token=${encodeURIComponent(apiToken)}`;
        const json = JSON.parse(await getText(url, apiHeaders()));
        // Measured 2026-11-20: a title VaPlayer lacks answers HTTP 200
        // {"status_code":404}. That is the only clean "not here"; a rejected
        // token is {"status_code":"403","error":"invalid api token"} - a failure.
        if (String(json.status_code) === '404') {
            console.log(`[VaPlayer] not-found ${imdb} (api status_code 404)`);
            return { urls: [], fileName: '' };
        }
        if (json.status_code !== '200' && json.status_code !== 200) {
            throw new Error(`VaPlayer API error: ${json.error || `status_code=${json.status_code}`}`);
        }
        const data = json.data || {};
        let urls = data.stream_urls || [];
        if (typeof urls === 'string') urls = await decryptStreamUrls(urls, json.vp || json.va);

        // One host token per stream origin, shared by every url on it.
        const tokens = new Map();
        for (const u of urls) {
            const o = new URL(u).origin;
            if (!tokens.has(o)) tokens.set(o, hostToken(o, apiToken));
        }
        const signed = await Promise.all(urls.map(async (u) => applyToken(u, await tokens.get(new URL(u).origin))));
        return { urls: signed, fileName: data.file_name || '' };
    } catch (err) {
        // Rethrown: an HTTP error, timeout or bad token is "unknown", and the
        // aggregator must not cache it as "this title has no streams".
        console.warn(`[VaPlayer] fetch failed for ${imdb}: ${err.message}`);
        throw err;
    }
}

// VaPlayer hands out several stream_urls for the SAME file - they differ only
// in a signed, gzip+base64 playback token, and are meant as retry fallbacks
// rather than as alternative versions. Emitting one card per token showed the
// viewer "HLS 1/2/3" (literally the array index) where all three played the
// identical media.
//
// The media identity is a 32-hex content hash, but it is NOT in the url the
// api returns - that is only `/pl/<token>/master.m3u8`. The hash sits one level
// down, in the variant urls inside the fetched master. Measured on Peddi, all
// three tokens resolved to 001cecdb7e6781bb6af772eae807caa8 for the 360p leg,
// while the 360p/720p/1080p variants within a single master each had their own
// distinct hash - so the hash identifies media, not quality.
//
// Fetching each master costs one small request per token (~1.8KB) and is the
// only way to see the hash, so dedupe resolves them concurrently.
async function mediaKey(url) {
    try {
        const controller = new AbortController();
        // 8000ms was the original budget, but this probe is an OPTIMISATION -
        // it only dedupes tokens that point at the same media. When the origin
        // is unreachable the wait buys nothing and becomes the slowest thing in
        // the whole resolve. Measured 2026-09-23 on 628241: all three probes
        // timed out at exactly 8002ms and returned null, making VaPlayer 8.3s
        // of a 10.1s request while `urbansolardiyprojectshub.site` answered 522.
        // A reachable origin returns this 1.8KB master well inside 2.5s.
        const timer = setTimeout(() => controller.abort(), Number(process.env.VAPLAYER_PROBE_TIMEOUT_MS) || 2500);
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': `${PLAYER_ORIGIN}/`,
                'Origin': PLAYER_ORIGIN
            }
        });
        clearTimeout(timer);
        if (!resp.ok) return null;
        const body = await resp.text();
        // Every variant hash in order - two masters of the same media list the
        // same set, so the joined list is a stable fingerprint.
        const hashes = [...new Set(body.match(/\/[0-9a-f]{32}\//g) || [])];
        // Measured on Leo: one of the three tokens returns a master with zero
        // variants. That is a dead token, not another version - it would play
        // as an empty card. No hashes means nothing to play, so drop it.
        if (!hashes.length) return null;
        // The master also states the real ladder. We already have the body, so
        // reading RESOLUTION here costs nothing and replaces the filename guess
        // below with what the stream actually offers.
        return { key: hashes.join(','), heights: parseHeights(body), codecs: masterCodecs(body) };
    } catch {
        return null;
    }
}

// Heights advertised by the master's EXT-X-STREAM-INF lines, best first.
function parseHeights(body) {
    const out = [];
    for (const m of String(body).matchAll(/RESOLUTION=(\d+)x(\d+)/gi)) {
        const h = Number(m[2]);
        if (Number.isFinite(h) && h > 0) out.push(h);
    }
    return [...new Set(out)].sort((a, b) => b - a);
}

// VaPlayer's file_name is a release name, and its "1080p" token describes the
// SOURCE the release was made from, not what this HLS ladder serves. Measured
// on four 2026 Telugu titles, every stream whose filename said 1080p topped out
// at heights 804/808/800 - a ~720p ladder. Reporting the filename made the UI
// label a 720p stream as 1080p and sort it above genuine 720p streams.
// The manifest is the source of truth; the filename is only a fallback for the
// case where no master could be read at all.
const TIERS = [2160, 1440, 1080, 720, 480, 360, 240];
function heightToLabel(height) {
    let best = TIERS[0];
    for (const t of TIERS) if (Math.abs(t - height) < Math.abs(best - height)) best = t;
    return `${best}p`;
}

// The API also returns file_name - the original release name. It carries the
// source, quality and audio layout ("...WEBRip.x264.AAC5.1-[YTS.GG]"), which
// is the only language signal VaPlayer exposes: the manifests declare no
// EXT-X-MEDIA renditions and the single AAC track is tagged `und`.
function releaseInfo(fileName) {
    const base = String(fileName || '').split('/').pop() || '';
    return base
        .replace(/\.(mkv|mp4|avi|webm|m3u8)$/i, '')
        .replace(/[._]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function toStreams(streamUrls, labelSuffix = '', fileName = '') {
    const info = releaseInfo(fileName);
    const claimed = (info.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[0] || null;
    const probes = await Promise.all(streamUrls.map((url) => mediaKey(url)));
    const seen = new Set();
    const unique = [];
    let heights = [];
    // CODECS per kept url, so the player can skip a codec it cannot decode.
    const codecsByUrl = new Map();
    streamUrls.forEach((url, i) => {
        const probe = probes[i];
        if (!probe || seen.has(probe.key)) return;
        seen.add(probe.key);
        unique.push(url);
        codecsByUrl.set(url, probe.codecs || null);
        if (probe.heights && probe.heights.length > heights.length) heights = probe.heights;
    });

    // Prefer what the manifest advertises; fall back to the release name only
    // when no master could be read.
    const quality = heights.length ? heightToLabel(heights[0]) : (claimed || 'Auto');
    if (heights.length && claimed && quality !== claimed) {
        console.log(`[VaPlayer] release name says ${claimed} but the manifest tops out at ${heights[0]}p -> reporting ${quality}`);
    }

    // If every token failed to resolve we still have urls that may well play -
    // the probe is an optimisation, not a gate. Fall back to the raw list
    // rather than returning nothing.
    if (!unique.length && streamUrls.length) unique.push(streamUrls[0]);

    return unique.map((url, i) => ({
        name: 'VaPlayer',
        title: [
            `VaPlayer${labelSuffix ? ` ${labelSuffix}` : ''}`,
            unique.length > 1 ? `HLS ${i + 1}` : null,
            info || null
        ].filter(Boolean).join(' · '),
        url,
        quality,
        // The real ladder, so a player can build a quality menu without
        // re-fetching the master. Empty when no master could be read.
        levels: heights.map((h) => ({ height: h, quality: heightToLabel(h) })),
        codecs: codecsByUrl.get(url) || null,
        provider: 'VaPlayer',
        headers: {
            'Referer': `${PLAYER_ORIGIN}/`,
            'Origin': PLAYER_ORIGIN,
            'User-Agent': USER_AGENT
        }
    }));
}

async function getVaplayerStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[VaPlayer] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    try {
        const imdbId = await resolveImdbId(mediaType === 'tv' ? 'tv' : 'movie', tmdbId);
        if (!imdbId || !imdbId.startsWith('tt')) {
            console.log(`[VaPlayer] No IMDB ID resolved for TMDB ${tmdbId}`);
            return [];
        }

        const { urls, fileName } = mediaType === 'tv' && seasonNum !== null && episodeNum !== null
            ? await fetchStreamUrls(imdbId, 'tv', seasonNum, episodeNum)
            : await fetchStreamUrls(imdbId, 'movie');

        const streams = await toStreams(urls, mediaType === 'tv' ? `S${seasonNum}E${episodeNum}` : '', fileName);
        console.log(`[VaPlayer] Got ${streams.length} stream(s) from ${urls.length} url(s) for ${imdbId}${fileName ? ` | ${fileName.split('/').pop()}` : ''}`);
        return streams;
    } catch (err) {
        console.error(`[VaPlayer] Error: ${err.message}`);
        throw err; // an upstream failure is an error, not "no streams"
    }
}

module.exports = { applyToken, decryptStreamUrls, getVaplayerStreams, UPSTREAM };