const { getDetails } = require('../utils/tmdb');
const { getStore, mediaIdentityOf } = require('../utils/store');
const {
    normalizeTitle: normaliseTitle,
    looseTitle: loosenTitle,
    searchSpellings,
    isPrefixWithSuffixNoise,
} = require('../utils/titleMatch');

const STREAM_CACHE_TTL = 25 * 60 * 1000;
// Short cooldown for empty/failed lookups so a transient throttle does not
// masquerade as a lasting "no streams" answer, and so repeated page loads
// stop re-probing a provider that is currently refusing us.
const EMPTY_CACHE_TTL = Number(process.env.NETMIRROR_EMPTY_TTL_MS) || 90 * 1000;
// 'disney' was here too, but PLATFORM_MAP gives it the same `ott: 'hs'` as
// hotstar, and `ott` is the only thing that varies between platform requests
// (newTvHeaders). It searched the same endpoint with the same headers for the
// same title and returned the same rows - three extra requests per lookup, for
// a provider that rate limits per IP. Dropped.
const PLATFORM_ORDER = ['netflix', 'primevideo', 'hotstar', 'disney'];

const UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36'
];
const ACCEPT_LANG_POOL = [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9',
    'en-IN,en;q=0.9,hi;q=0.7',
    'en-US,en;q=0.8,es;q=0.5'
];
let uaIndex = 0;
let langIndex = 0;

function nextUA() { return UA_POOL[uaIndex++ % UA_POOL.length]; }
function nextLang() { return ACCEPT_LANG_POOL[langIndex++ % ACCEPT_LANG_POOL.length]; }

// Resolve this provider's hosts over DNS-over-HTTPS.
//
// ACT Broadband answers net27.cc with its own block server (49.205.171.201,
// `403 Court Orders`), and intercepts port 53 so naming @1.1.1.1 does not help
// either. Measured 2026-09-23: every request here failed with ECONNRESET in
// ~60ms, which surfaced as `Netflix direct failed: fetch failed` and 0 streams
// on every title - the provider looked dead when only the NAME was wrong.
//
// Scoped to this module with a local dispatcher rather than
// setGlobalDispatcher, so no other provider's DNS behaviour changes.
const { Agent } = require('undici');
const { dohLookup } = require('../utils/dohResolver');
const { probeAudioTracks } = require('../lib/media/mp4AudioProbe');

// Long keep-alive: on the prod VM (Hostinger AS47583) a middlebox resets most
// TLS handshakes whose SNI names a mirror. Measured 2026-11-15 from the VM:
// 9 of 12 `curl https://net27.cc/` attempts got "Connection reset by peer",
// while SNI cloudflare.com to the same IP always connected. A handshake that
// gets through is fine afterwards, so keep it open and reuse it.
const dohAgent = new Agent({
    connect: { lookup: dohLookup },
    keepAliveTimeout: 60 * 1000,
    keepAliveMaxTimeout: 10 * 60 * 1000,
});

// Connection-level failures that a fresh attempt can get past. Each fails in
// ~60ms, so a few retries cost little. A bad certificate is never accepted:
// the retry opens a new connection and verifies again.
const RETRYABLE_CONN = new Set([
    'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const CONN_RETRIES = Number(process.env.NETMIRROR_CONN_RETRIES) || 5;

// Every fetch in this file goes through here so a new call site cannot quietly
// skip the resolver and start failing again.
async function nmFetch(url, options = {}, fetchImpl = fetch) {
    let lastErr;
    for (let attempt = 0; attempt < CONN_RETRIES; attempt++) {
        if (options.signal && options.signal.aborted) break;
        try {
            return await fetchImpl(url, { dispatcher: dohAgent, ...options });
        } catch (err) {
            lastErr = err;
            const code = err && err.cause && err.cause.code;
            if (!RETRYABLE_CONN.has(code)) throw err;
        }
    }
    throw lastErr;
}

const streamCache = new Map();
const inflight = new Map();
let resolvedApiUrl = '';
// The newtv api base used to be cached for the life of the process, so a
// rotated base stayed pinned until a restart. Ported from ott's
// resolveApiBase: recheck after a TTL, and drop it after 2 consecutive search
// failures so the next resolve asks checknewtv.php again (ONE request).
const NEWTV_API_TTL_MS = Number(process.env.NETMIRROR_NEWTV_API_TTL_MS) || 10 * 60 * 1000;
const NEWTV_MAX_FAILURES = 2;
let resolvedApiAt = 0;
let newTvFailures = 0;

function noteNewTvFailure() {
    if (!resolvedApiUrl) return;
    newTvFailures += 1;
    if (newTvFailures >= NEWTV_MAX_FAILURES) {
        console.log(`[NetMirror] newtv api ${resolvedApiUrl} failed ${newTvFailures}x - rediscovering on next resolve`);
        resolvedApiUrl = '';
        resolvedApiAt = 0;
        newTvFailures = 0;
    }
}

function noteNewTvOk() { newTvFailures = 0; }

const NEW_TV_DOMAINS = [
    'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==',
    'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=',
    'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg=='
];

// disney rides the hotstar catalogue (same `hs` ott) - that is upstream's
// mapping, and it is a separate CATALOGUE query, not a duplicate of hotstar:
// the two return different rows for the same title.
const PLATFORM_MAP = { netflix: { ott: 'nf' }, primevideo: { ott: 'pv' }, hotstar: { ott: 'hs' }, disney: { ott: 'hs' } };

// Spacing between platform chains. newtv rate limits per IP and answers an
// over-limit request with HTTP 200 and a substituted video, or eventually with
// nothing at all, so pacing is correctness here and not just politeness.
const PLATFORM_GAP_MS = Number(process.env.NETMIRROR_PLATFORM_GAP_MS) || 1200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The direct API lives behind a rotating set of mirror domains, and which one
// answers changes without notice. Measured 2026-09-23: net27.cc, netfree.cc and
// iosmirror.cc all resolve to the same origin, while net30.cc had already been
// re-parked as a "Coming Soon" page - so a single hardcoded host is a provider
// that dies silently the next time the operators move.
//
// Ordered; the first that answers wins and is remembered for the process.
const API_MIRRORS = (process.env.NETMIRROR_API_BASE
    ? [process.env.NETMIRROR_API_BASE]
    : ['https://net27.cc', 'https://netfree.cc', 'https://iosmirror.cc', 'https://net79.cc'])
    .map((u) => u.replace(/\/$/, ''));

let liveMirror = null;

function apiBase() {
    return liveMirror || API_MIRRORS[0];
}

/**
 * Call `build(base)` against each mirror until one returns a usable response.
 *
 * A mirror that is DNS-poisoned or parked fails fast (ECONNRESET in ~60ms on
 * ACT, or a 404/HTML page), so walking the list costs little and means the
 * provider survives an operator moving domains.
 */
async function withMirror(build) {
    const order = liveMirror
        ? [liveMirror, ...API_MIRRORS.filter((m) => m !== liveMirror)]
        : API_MIRRORS;
    let lastErr = null;
    for (const base of order) {
        try {
            const out = await build(base);
            if (out !== null && out !== undefined) {
                if (liveMirror !== base) {
                    console.log(`[NetMirror] using mirror ${base}`);
                    liveMirror = base;
                }
                return out;
            }
        } catch (err) {
            lastErr = err;
            console.log(`[NetMirror] mirror ${base} failed: ${err.cause?.code || err.message}`);
        }
    }
    if (lastErr) throw lastErr;
    return null;
}

function streamReferer() {
    return process.env.NETMIRROR_STREAM_REFERER || 'https://videodownloader.site/';
}

function newTvHeaders(ott, extra = {}) {
    return {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Requested-With': 'NetmirrorNewTV v1.0',
        'Accept': 'application/json, text/plain, */*',
        'Ott': ott,
        'User-Agent': nextUA(),
        'Accept-Language': nextLang(),
        ...extra
    };
}

async function resolveNewTvApi() {
    if (resolvedApiUrl && Date.now() - resolvedApiAt < NEWTV_API_TTL_MS) return resolvedApiUrl;
    resolvedApiUrl = '';
    newTvFailures = 0;
    const custom = (process.env.NEWTV_DOMAINS || '')
        .split(',')
        .map((value) => value.trim().replace(/\/$/, ''))
        .filter(Boolean);
    const domains = [
        ...custom,
        ...NEW_TV_DOMAINS.map((value) => Buffer.from(value, 'base64').toString('utf8'))
    ];

    for (const domain of domains) {
        try {
            const response = await nmFetch(`${domain}/checknewtv.php`, {
                headers: { ...newTvHeaders('nf') },
                signal: AbortSignal.timeout(10000)
            });
            const data = await response.json();
            if (data.token_hash) {
                resolvedApiUrl = Buffer.from(data.token_hash, 'base64').toString('utf8').replace(/\/$/, '');
                resolvedApiAt = Date.now();
                return resolvedApiUrl;
            }
        } catch {
            // Try the next rotating discovery domain.
        }
    }
    throw new Error('NetMirror NewTV API discovery failed');
}

// An upstream failure (HTTP error, timeout, throttle) is "unknown", not
// "this title has no streams". Rows carry the reason as `upstreamError` so
// getNetmirrorStreams can keep it out of the long caches and the aggregator
// does not cache it as empty (providers/registry.js).
function failure(reason, rows = []) {
    return Object.assign(rows, { upstreamError: String(reason) });
}

async function fetchNetflix(tmdbId, type, title, season, episode) {
    // True once a mirror answered with a well-formed "no" (ok:false). Without
    // one, a null from withMirror means every mirror failed with an HTTP error.
    let answeredNo = false;
    let lastStatus = null;
    try {
        // Resolved per attempt: withMirror may settle on a different mirror than
        // the one this call started with, and the Referer and caption URLs below
        // must match whichever host actually answered.
        let base = apiBase();
        const data = await withMirror(async (candidate) => {
            const url = type === 'series'
                ? `${candidate}/api/embed-tmdb/${tmdbId}?type=tv&se=${season}&ep=${episode}`
                : `${candidate}/api/embed-tmdb/${tmdbId}`;
            const response = await nmFetch(url, {
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    Referer: `${candidate}/`,
                    'User-Agent': nextUA(),
                    'Accept-Language': nextLang()
                },
                signal: AbortSignal.timeout(20000)
            });
            if (!response.ok) { lastStatus = response.status; return null; } // null = try the next mirror
            const body = await response.json();
            if (body.ok !== true) { answeredNo = true; return null; }
            base = candidate;
            return body;
        });
        if (!data) {
            if (answeredNo) return [];
            return failure(`netflix: every mirror failed (last HTTP ${lastStatus})`);
        }
        const subtitles = (data.captions || []).flatMap((caption, index) => {
            if (!caption.url) return [];
            return [{
                id: `netflix-${index}-${caption.lang || 'en'}`,
                url: caption.url.startsWith('/') ? `${base}${caption.url}` : caption.url,
                lang: caption.lang || 'en',
                label: caption.name || 'English'
            }];
        });
        const headers = { Referer: streamReferer(), 'User-Agent': nextUA() };

        // Read the audio language OUT OF THE FILE.
        //
        // /api/embed-tmdb/ returns {url, resolution, size} and nothing about
        // audio, so every stream from this path used to reach the player with
        // languages:[] - no audio menu entry, and invisible to the canonical
        // Telugu-first sort. The tag was there all along. Measured 2026-09-23:
        //
        //   628241 Ala Vaikunthapurramuloo  aac language=tel   reported []
        //   912649 Venom: The Last Dance    aac language=eng   reported []
        //
        // One probe per DISTINCT file: these rungs are the same cut at
        // different resolutions, so they share an audio track, and probing the
        // smallest one answers for all of them. See lib/media/mp4AudioProbe.js
        // for why this does not download the film.
        // The probe BLOCKS on purpose.
        //
        // /api/embed-tmdb/ returns {url, resolution, size} and no audio data,
        // so ffprobe reading the mp4's moov atom is the only source of truth
        // for what language this file actually carries. Measured 2026-09-23:
        // 7330-9226ms cold, ~0ms warm (30min cache, lib/media/mp4AudioProbe.js).
        //
        // A non-blocking version was tried and REVERTED. It returned the
        // streams immediately and warmed the cache in the background, which cut
        // NetMirror to ~4s but shipped languages:[] on the request the viewer
        // actually sees - the Telugu tag this probe exists to find. Losing
        // audio information to save a few seconds is the wrong trade: an
        // unlabelled stream is invisible to the language-first ranking, so the
        // viewer does not get a slower Telugu result, they get no Telugu result.
        //
        // Cost is bounded by the registry deadline (PROVIDER_DEADLINE_MS) and
        // paid once per file per 30 minutes.
        const withAudio = async (entries) => {
            if (!entries.length) return entries;
            const smallest = entries.reduce((a, b) =>
                (Number(b.__size) || Infinity) < (Number(a.__size) || Infinity) ? b : a);
            const audio = await probeAudioTracks(smallest.url, headers).catch(() => []);
            const languages = [...new Set(audio.map((t) => t.language).filter(Boolean))];
            return entries.map(({ __size, ...e }) => ({
                ...e,
                ...(audio.length ? { audio } : {}),
                ...(languages.length ? { languages } : {}),
            }));
        };

        const streams = (data.streams || []).filter((stream) => stream.url).map((stream) => ({
            name: 'NetMirror | Netflix',
            title: `${title}\n${stream.resolution ? `${stream.resolution}p` : 'Auto'}`,
            url: stream.url,
            quality: stream.resolution ? `${stream.resolution}p` : 'Auto',
            provider: 'NetMirror',
            headers,
            __size: stream.size,
            ...(subtitles.length ? { subtitles } : {})
        }));
        if (streams.length) return withAudio(streams);
        if (!data.mp4) return [];
        return withAudio([{
            name: 'NetMirror | Netflix',
            title: `${title}\nAuto`,
            url: data.mp4,
            quality: 'Auto',
            provider: 'NetMirror',
            headers,
            ...(subtitles.length ? { subtitles } : {})
        }]);
    } catch (error) {
        console.log(`[NetMirror] Netflix direct failed: ${error.message}`);
        return failure(`netflix: ${error.message}`);
    }
}

function parseNumber(value) {
    if (!value) return null;
    const parsed = parseInt(String(value).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function getEpisodes(api, showId, postData, config) {
    const result = [];
    const selectedSeason = Array.isArray(postData.season) ? postData.season.findIndex((item) => item.selected) : -1;
    const selectedSeasonId = selectedSeason >= 0 ? postData.season[selectedSeason].id : postData.nextPageSeason;
    const add = (episode, seasonNumber) => {
        result.push({
            id: episode.id,
            s: seasonNumber || parseNumber(episode.sNum),
            ep: parseNumber(episode.ep) || parseNumber(episode.epNum)
        });
    };

    for (const episode of postData.episodes || []) {
        if (episode) add(episode, selectedSeason >= 0 ? selectedSeason + 1 : null);
    }

    if (postData.nextPageShow === 1 && selectedSeasonId) {
        try {
            const response = await nmFetch(
                `${api}/newtv/episodes.php?id=${encodeURIComponent(selectedSeasonId)}&page=2`,
                { headers: newTvHeaders(config.ott), signal: AbortSignal.timeout(15000) }
            );
            const data = await response.json();
            for (const episode of data.episodes || []) {
                if (episode) add(episode, selectedSeason >= 0 ? selectedSeason + 1 : null);
            }
        } catch {
            // The first page is still useful when pagination is unavailable.
        }
    }

    return result;
}

// NetMirror's search returns loose matches, and taking searchResult[0] blindly
// has handed back an entirely different film: a request for RRR resolved to a
// title whose media id belonged to another movie. Compare normalised titles and
// skip the platform rather than serve the wrong picture.

// Transliteration of the same name differs by one doubled vowel far more often
// than it differs in any other way: TMDB's "Bāhubali" deaccents to "bahubali"
// while the catalogue row reads "Baahubali", and "Raajakumara"/"Rajakumara" and
// "Naanu"/"Nanu" behave the same. Collapsing runs of the same vowel makes those
// compare equal. Used ONLY as a fallback after the strict compare, so it can
// never turn a strict match into a different film.

// NetMirror models dubs as SEPARATE catalogue rows carrying the language in
// the title - "Master (Telugu)", "Jawan: Telugu Extended Cut" - rather than as
// selectable audio tracks inside one file the way CastleTV does. Exact equality
// therefore discarded every language row: normaliseTitle('RRR (Hindi)') is
// 'rrr hindi', which never equals 'rrr'. Strip a trailing language marker so
// those rows match their base title, and keep what was stripped as a label.
const LANG_WORDS = ['Hindi', 'Telugu', 'Tamil', 'Malayalam', 'Kannada', 'English',
    'Bengali', 'Marathi', 'Punjabi', 'Gujarati', 'Urdu', 'Odia', 'Assamese', 'Bhojpuri'];
const LANG_ALT = LANG_WORDS.join('|');

function titleCase(word) {
    const w = String(word);
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function splitTitleLanguage(value) {
    const raw = String(value || '').trim();
    // "Jawan: Telugu Extended Cut" / "Jawan: Extended Cut"
    let m = raw.match(new RegExp('^(.*?):\\s*(?:(' + LANG_ALT + ')\\s+)?(.*(?:Cut|Version|Edition))$', 'i'));
    if (m) return { base: m[1].trim(), language: m[2] ? titleCase(m[2]) : null };
    // "RRR (Hindi)"
    m = raw.match(new RegExp('^(.*?)\\s*\\((' + LANG_ALT + ')\\)\\s*$', 'i'));
    if (m) return { base: m[1].trim(), language: titleCase(m[2]) };
    // "Movie - Telugu"
    m = raw.match(new RegExp('^(.*?)\\s*[-\u2013]\\s*(' + LANG_ALT + ')\\s*$', 'i'));
    if (m) return { base: m[1].trim(), language: titleCase(m[2]) };
    return { base: raw, language: null };
}

// Every catalogue row whose BASE title matches, untagged rows first. Untagged
// first is deliberate: measured across 71 popular Indian titles, the rows that
// carried a real multi-audio manifest were the ones WITHOUT a language in the
// title, while 42 of 49 language-tagged rows resolved to a shared placeholder
// file (files/220884, seen under unrelated films). The tagged rows are still
// worth returning as extra options, just never as the primary pick.
function pickSearchMatches(results, wantedTitle) {
    const wanted = normaliseTitle(wantedTitle);
    if (!wanted) return [];
    const rows = (results || [])
        .filter((item) => item && item.id)
        .map((item) => {
            const split = splitTitleLanguage(item.t || item.title);
            return { item, language: split.language, base: split.base };
        });

    const strict = rows
        .filter((row) => normaliseTitle(row.base) === wanted)
        .sort((a, b) => (a.language ? 1 : 0) - (b.language ? 1 : 0));

    if (strict.length) return strict;

    // Nothing matched exactly. Retry on the loosened spelling - "Baahubali"
    // against TMDB's deaccented "Bahubali" - before giving up.
    const loose = loosenTitle(wantedTitle);
    const loosened = rows
        .filter((row) => loosenTitle(row.base) === loose)
        .sort((a, b) => (a.language ? 1 : 0) - (b.language ? 1 : 0));
    if (loosened.length) return loosened;

    // Last pass: the catalogue may omit a sequel suffix TMDB carries, listing
    // "Devara" where TMDB says "Devara: Part 1". isPrefixWithSuffixNoise allows
    // only that - a whole-word prefix whose remainder is part/chapter noise -
    // so a row that drops a real title word still loses to no match.
    return rows
        .filter((row) => isPrefixWithSuffixNoise(normaliseTitle(row.base), wanted)
            || isPrefixWithSuffixNoise(loosenTitle(row.base), loose))
        .sort((a, b) => (a.language ? 1 : 0) - (b.language ? 1 : 0));
}

function pickSearchMatch(results, wantedTitle) {
    const best = pickSearchMatches(results, wantedTitle)[0];
    return best ? best.item : null;
}

// Progressively looser search spellings for one TMDB title. Deduplicated and
// ordered most-faithful first; the caller stops at the first one that matches,
// so a title that works as-is costs exactly one request as before.

// True when the master's VIDEO rungs really belong to `wantedId`. A master that
// serves its video from a different file id is the placeholder described above.
// Network failure returns true: this is a guard against a known decoy, not a
// general validator, and a flaky fetch must not drop a working stream.
async function masterMatchesTitle(masterUrl, wantedId, referer) {
    try {
        const resp = await nmFetch(masterUrl, {
            headers: { Referer: referer || '', 'User-Agent': nextUA() },
            signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return true;
        const body = await resp.text();
        if (!/#EXT-X-STREAM-INF/i.test(body)) return true;

        // Only the lines that are URIs (a variant) rather than tags (audio and
        // subtitle renditions carry their id in a URI="" attribute instead).
        const videoIds = new Set();
        for (const raw of body.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const m = line.match(/files\/(\d+)/);
            if (m) videoIds.add(m[1]);
        }
        if (!videoIds.size) return true;

        const want = String(wantedId);
        if (videoIds.has(want)) return true;
        console.log(`[NetMirror] master for ${want} serves video from ${[...videoIds].join(',')}`);
        return false;
    } catch {
        return true;
    }
}

// newtv answers a lookup the catalogue does not have with an HTML "Page Not
// Found" page (or a 404), not JSON. Prod audit 2026-11-20: response.json()
// threw on it for primevideo/hotstar/disney, the throw became upstreamError,
// and the whole NetMirror answer (Netflix rows included) went uncached as a
// partial, so the title was asked again: 11 errors + 6 partials a day. That
// page means "no rows here", so it returns null. Anything else that is not
// JSON (a 5xx, a challenge page) still throws: that is an unknown, not an empty.
const PAGE_NOT_FOUND_RE = /page\s+not\s+found/i;
async function readNewTvJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (err) {
        if (response.status === 404 || PAGE_NOT_FOUND_RE.test(text)) return null;
        throw new Error(`HTTP ${response.status}: ${err.message}`);
    }
}

async function fetchPlatform(platform, title, type, season, episode) {
    try {
        const config = PLATFORM_MAP[platform];
        const api = await resolveNewTvApi();
        let matches = [];
        let lastSeen = [];
        // NetMirror's search matches on punctuation too, while TMDB titles carry
        // their own. Measured: "Kalki 2898-AD" and "Kantara - A Legend: Chapter 1"
        // both return ZERO rows, while the same titles with punctuation reduced
        // to spaces return the real entries. Try the TMDB spelling first, then
        // progressively looser ones, and stop at the first query that matches.
        for (const query of searchSpellings(title)) {
            const searchResponse = await nmFetch(
                `${api}/newtv/search.php?s=${encodeURIComponent(query)}`,
                { headers: newTvHeaders(config.ott), signal: AbortSignal.timeout(15000) }
            );
            const searchData = await readNewTvJson(searchResponse);
            if (searchData === null) {
                console.log(`[NetMirror] ${platform} catalogue: page not found for "${query}" - no rows`);
                return [];
            }
            noteNewTvOk();
            const results = searchData.searchResult || [];
            if (results.length) lastSeen = results;
            matches = pickSearchMatches(results, title);
            if (matches.length) break;
        }
        if (!matches.length) {
            const seen = lastSeen.slice(0, 3).map((item) => item && (item.t || item.title)).filter(Boolean);
            console.log(`[NetMirror] ${platform} no title match for "${title}"${seen.length ? ` (saw: ${seen.join(', ')})` : ''}`);
            return [];
        }
        // Resolve each language row, not just the first. NetMirror only ever
        // exposes one audio track per file, so a second language is a second
        // catalogue entry - dropping the rest is dropping the language choice.
        const out = [];
        let err = null;
        for (const match of matches.slice(0, MAX_LANGUAGE_ROWS)) {
            const rows = await resolveMatch(api, config, platform, match, title, type, season, episode);
            if (rows.upstreamError) err = rows.upstreamError;
            out.push(...rows);
        }
        return err ? failure(err, out) : out;
    } catch (error) {
        console.log(`[NetMirror] ${platform} failed: ${error.message}`);
        noteNewTvFailure();
        return failure(`${platform}: ${error.message}`);
    }
}

// How many catalogue rows of one title we will resolve. Each row costs a
// post.php + player.php pair against a provider that rate limits per IP, so
// this is capped rather than unbounded.
const MAX_LANGUAGE_ROWS = Number(process.env.NETMIRROR_MAX_LANG_ROWS) || 4;

async function resolveMatch(api, config, platform, match, title, type, season, episode) {
    const first = match.item;
    try {

        const postResponse = await nmFetch(
            `${api}/newtv/post.php?id=${encodeURIComponent(first.id)}`,
            { headers: newTvHeaders(config.ott, { Lastep: '', Usertoken: '' }), signal: AbortSignal.timeout(15000) }
        );
        const postData = await readNewTvJson(postResponse);
        if (postData === null) {
            console.log(`[NetMirror] ${platform} post: page not found for id ${first.id} - no rows`);
            return [];
        }

        let targetId = first.id;
        if (type === 'series') {
            const episodes = await getEpisodes(api, first.id, postData, config);
            const target = episodes.find((item) => item.s === season && item.ep === episode);
            if (!target) return [];
            targetId = target.id;
        } else if (postData.type === 't' || ((postData.episodes || []).filter(Boolean).length > 0)) {
            return [];
        } else {
            targetId = postData.main_id || first.id;
        }

        const playerResponse = await nmFetch(
            `${api}/newtv/player.php?id=${encodeURIComponent(targetId)}`,
            { headers: newTvHeaders(config.ott, { Usertoken: '' }), signal: AbortSignal.timeout(15000) }
        );
        const player = await readNewTvJson(playerResponse);
        if (player === null) {
            console.log(`[NetMirror] ${platform} player: page not found for id ${targetId} - no rows`);
            return [];
        }
        if (player.status && player.status !== 'ok') {
            console.log(`[NetMirror] ${platform} player status: ${player.status} — accepting if link present`);
        }
        if (!player.video_link) return [];
        const label = platform === 'primevideo'
            ? 'Prime Video'
            : platform.charAt(0).toUpperCase() + platform.slice(1);
        // post.php carries the authoritative language list for the title:
        //   lang: [{"l":"Hindi","s":"hin"}, ... {"l":"Telugu","s":"tel"}]
        // and those are exactly the EXT-X-MEDIA audio renditions the master
        // playlist ends up exposing. Prefer it over the language parsed out of
        // the catalogue title, which only ever describes a single dub row.
        const postLangs = Array.isArray(postData.lang)
            ? postData.lang.map((entry) => entry && entry.l).filter(Boolean)
            : [];
        const languages = postLangs.length ? postLangs : (match.language ? [match.language] : []);
        // The watch UI reads the language out of a [...] tag in `name` (see
        // languageFromLabel in public/watch.js), the same shape CastleTV emits.
        // Carry `language` as a field too so callers do not have to parse it.
        const langTag = languages.length ? ` [${languages.join('/')}]` : '';

        // Reject the decoy master.
        //
        // NetMirror answers for titles it does not really carry by returning a
        // master whose AUDIO renditions belong to the requested title but whose
        // VIDEO rungs all point at a shared placeholder file. Measured on
        // movie/256040: the master is .../hls/hs/1000074338.m3u8, its audio is
        // files/1000074338/a/{0,1,2} and every one of its 1080p/720p/480p video
        // rungs is files/220884 - the same placeholder this file's comment at
        // pickSearchMatches already records as appearing under unrelated films.
        // It fetches with HTTP 200 and real video/mp2t segments, so nothing
        // downstream can tell it is the wrong film; the picture simply is not
        // the title, and the player's startup fallback bounces straight back to
        // another provider. Catch it here, where the id is known.
        if (!(await masterMatchesTitle(player.video_link, targetId, player.referer || api))) {
            // Still rejected (CLAUDE.md rule 4), but reported as a throttle:
            // the title IS there, so this must not be cached as "no streams".
            console.log(`[NetMirror] ${platform} returned a placeholder master for "${title}" — rejecting`);
            return failure(`${platform}: throttled (placeholder master)`);
        }

        return [{
            name: `NetMirror${langTag} | ${label}`,
            title: `${title}\nAuto`,
            url: player.video_link,
            quality: 'Auto',
            provider: 'NetMirror',
            ...(languages.length ? { language: languages.join('/') } : {}),
            headers: {
                Referer: player.referer || api,
                'User-Agent': nextUA()
            }
        }];
    } catch (error) {
        console.log(`[NetMirror] ${platform} failed: ${error.message}`);
        return failure(`${platform}: ${error.message}`);
    }
}

// The language of an UNLABELLED Netflix embed-tmdb file, read from Netflix's
// own catalogue entry (search.php -> post.php, never player.php).
//
// embed-tmdb ships the full-length mp4 with its one audio track tagged `und`,
// which mp4AudioProbe drops, so a real Telugu file reached the ranking with
// languages:[] and lost to a truncated labelled one (Krack 784572: 9033s
// Netflix mp4 vs a 102.5min Castle Telugu file). post.php's `lang` list names
// the title's audio. Exactly one language is a label; several is a guess, so
// nothing is returned.
//
// Rate limits (CLAUDE.md #5): ONE search (first spelling only) and ONE
// post.php, no retry, no loop. The caller runs it only for unlabelled rows,
// and the evidence it writes labels the file on later probes, so it does not
// repeat for the same file.
async function netflixLanguageFromPost(title, type, year) {
    try {
        const ott = PLATFORM_MAP.netflix.ott;
        const api = await resolveNewTvApi();
        const query = searchSpellings(title)[0] || title;
        const searchData = await readNewTvJson(await nmFetch(
            `${api}/newtv/search.php?s=${encodeURIComponent(query)}`,
            { headers: newTvHeaders(ott), signal: AbortSignal.timeout(15000) }
        ));
        if (searchData === null) return null;
        noteNewTvOk();
        const match = pickSearchMatches(searchData.searchResult || [], title)[0];
        if (!match) {
            console.log(`[NetMirror] netflix-lang no catalogue match for "${title}"`);
            return null;
        }
        const post = await readNewTvJson(await nmFetch(
            `${api}/newtv/post.php?id=${encodeURIComponent(match.item.id)}`,
            { headers: newTvHeaders(ott, { Lastep: '', Usertoken: '' }), signal: AbortSignal.timeout(15000) }
        ));
        if (post === null) return null;
        if (type === 'movie' && (post.type === 't' || (post.episodes || []).filter(Boolean).length)) {
            console.log(`[NetMirror] netflix-lang "${title}" matched a series entry - skipped`);
            return null;
        }
        const postYear = Number(String(post.year || '').slice(0, 4));
        if (year && postYear > 1900 && Math.abs(postYear - year) > 1) {
            console.log(`[NetMirror] netflix-lang "${title}" year ${postYear} vs ${year} - skipped`);
            return null;
        }
        const langs = [...new Set((Array.isArray(post.lang) ? post.lang : [])
            .map((entry) => entry && String(entry.l || '').trim()).filter(Boolean))];
        if (langs.length !== 1) {
            console.log(`[NetMirror] netflix-lang "${title}" lists ${langs.length} languages - not guessing`);
            return null;
        }
        return langs[0];
    } catch (error) {
        console.log(`[NetMirror] netflix-lang failed: ${error.message}`);
        return null;
    }
}

// Label unlabelled Netflix rows with `lang` and store it as provider evidence
// on each file's media identity. mp4AudioProbe's applyEvidence then relabels
// the single `und` track on every later probe of the same file.
function labelNetflixRows(rows, lang, ctx) {
    const seen = new Set();
    return rows.map((row) => {
        if (!row || row.language || (row.languages || []).length) return row;
        const identity = mediaIdentityOf(row.url);
        if (identity && !seen.has(identity)) {
            seen.add(identity);
            try {
                getStore().putAudioEvidence({ ...ctx, provider: 'netmirror', mediaIdentity: identity,
                    source: 'provider', lang });
            } catch (e) { console.warn(`[NetMirror] netflix-lang evidence write failed: ${e.message}`); }
        }
        const audio = Array.isArray(row.audio) && row.audio.length === 1 && !row.audio[0].language
            ? [{ ...row.audio[0], language: lang }] : row.audio;
        return { ...row, languages: [lang], ...(audio ? { audio } : {}) };
    });
}

// A stream url that the CDN is currently throttling.
//
// THE PROBLEM THIS SOLVES (measured 2026-09-23): the 429 does not come from
// NetMirror's API, it comes from the CDN that serves the mp4
// (bcdnxw.hakunaymatata.com, nginx `429 Too Many Requests`). The API call
// before it succeeds, so the throttled url was cached as a GOOD stream for the
// full 25 minutes and only failed later, in the player, as an unexplained dead
// source. Every edge IP returned 429 and a freshly signed url returned 429
// too, so it is per-IP throttling and re-resolving the title cannot fix it.
//
// A single ranged GET of a few bytes is enough to tell a throttled url from a
// working one, and it is the same request the player makes first anyway.
const CDN_PROBE_BYTES = Number(process.env.NETMIRROR_PROBE_BYTES) || 512;
// Cheap and bounded: one probe per stream, and a slow CDN must not hold up the
// whole resolve.
const CDN_PROBE_TIMEOUT_MS = Number(process.env.NETMIRROR_PROBE_TIMEOUT_MS) || 8000;
// How long to consider the CDN throttled once it says so. Short, because the
// limit lifts on its own - measured, it cleared within the hour with no action.
const CDN_COOLDOWN_MS = Number(process.env.NETMIRROR_CDN_COOLDOWN_MS) || 5 * 60 * 1000;

const throttledCdns = new Map(); // host -> epoch ms when it may be probed again

function cdnHost(url) {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

function cdnCoolingMs(url) {
    const h = cdnHost(url);
    if (!h) return 0;
    const until = throttledCdns.get(h) || 0;
    if (until && until <= Date.now()) { throttledCdns.delete(h); return 0; }
    return until ? until - Date.now() : 0;
}

/**
 * Drop streams whose CDN is currently rate limiting us.
 *
 * Returns { streams, throttled } so the caller can tell "this title genuinely
 * has nothing" apart from "we are being throttled right now" - they need very
 * different cache TTLs, and conflating them is what turned a few minutes of
 * throttling into 25 minutes of a missing provider.
 */
async function dropThrottled(streams) {
    if (!streams.length) return { streams, throttled: false };
    let throttled = false;
    const keep = [];

    for (const stream of streams) {
        const cooling = cdnCoolingMs(stream.url);
        if (cooling) {
            throttled = true;
            console.log(`[NetMirror] skipping ${cdnHost(stream.url)} - throttled, ${Math.round(cooling / 1000)}s left`);
            continue;
        }
        try {
            const resp = await nmFetch(stream.url, {
                method: 'GET',
                headers: { ...(stream.headers || {}), Range: `bytes=0-${CDN_PROBE_BYTES - 1}` },
                signal: AbortSignal.timeout(CDN_PROBE_TIMEOUT_MS),
            });
            // Read or discard the body so the socket returns to the pool.
            try { await resp.arrayBuffer(); } catch { /* nothing to read */ }

            if (resp.status === 429 || resp.status === 503) {
                const host = cdnHost(stream.url);
                // Honour Retry-After when the CDN sends one; it knows better
                // than our default.
                const ra = Number(resp.headers.get('retry-after'));
                const waitMs = Number.isFinite(ra) && ra > 0
                    ? Math.min(ra * 1000, 30 * 60 * 1000)
                    : CDN_COOLDOWN_MS;
                if (host) throttledCdns.set(host, Date.now() + waitMs);
                console.log(`[NetMirror] ${host} returned ${resp.status}; cooling down ${Math.round(waitMs / 1000)}s`);
                throttled = true;
                continue;
            }
            // 200 and 206 both mean the bytes are there; a range-ignoring CDN
            // answers 200 and that is still a working url.
            if (resp.ok || resp.status === 206) { keep.push(stream); continue; }

            console.log(`[NetMirror] dropping stream - CDN answered ${resp.status}`);
        } catch (err) {
            // A probe failure is not proof the stream is bad: keep it and let
            // the player decide, rather than hiding a source over one timeout.
            console.log(`[NetMirror] probe failed (${err.name === 'TimeoutError' ? 'timeout' : err.message}); keeping stream`);
            keep.push(stream);
        }
    }
    return { streams: keep, throttled };
}

function hdOnly(streams, forceHd) {
    if (!forceHd) return streams;
    const hd = streams.filter((stream) => {
        const match = (stream.quality || '').match(/(\d+)p/i);
        return !match || Number(match[1]) >= 720;
    });
    return hd.length ? hd : streams;
}

async function getNetmirrorStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[NetMirror] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    const type = mediaType === 'tv' ? 'series' : 'movie';
    const season = mediaType === 'tv' ? (seasonNum || null) : null;
    const episode = mediaType === 'tv' ? (episodeNum || null) : null;

    try {
        const details = await getDetails(mediaType === 'tv' ? 'tv' : 'movie', tmdbId);
        const title = (details && (details.title || details.name)) || '';
        if (!title) {
            console.log(`[NetMirror] No TMDB title resolved for ${tmdbId}`);
            return [];
        }

        const key = `${tmdbId}:${type}:${season || 0}:${episode || 0}`;
        const cached = streamCache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            if (cached.error && !cached.streams.length) {
                // Not via the catch below: that would re-arm the backoff on
                // every request and never let NetMirror be asked again.
                return Promise.reject(new Error(`backing off: ${cached.error}`));
            }
            const out = hdOnly(cached.streams, true);
            return cached.error ? failure(cached.error, [...out]) : out;
        }
        const running = inflight.get(key);
        if (running) return running;

        const request = (async () => {
            const direct = await fetchNetflix(tmdbId, type, title, season, episode);
            let upstreamError = direct.upstreamError || null;
            // Previously every remaining platform ran to completion through
            // Promise.all even once one had returned a stream. Each platform is
            // a three request chain (search -> post -> player), so a title
            // found on the first fallback still cost six more requests against
            // a provider that rate limits per IP. Stop at the first hit.
            let collected = [...direct];
            // The early exit above used to be `if (!collected.length)`, which
            // skipped the platform path entirely whenever the /api/embed-tmdb
            // call returned anything. That was wrong: the two paths return
            // DIFFERENT content, not the same content twice. embed-tmdb hands
            // back single-audio mp4s (measured: one aac track each, no
            // renditions), while the platform catalogue is where the language
            // rows live. Titles like Master lost their language options to it.
            // Keep the request saving where it is safe - if direct already gave
            // us a language-labelled stream, we do not need to go looking.
            // Every platform is asked, and each one that answers becomes its own
            // row. A title can sit on Netflix in Telugu and on Prime in Hindi -
            // measured 2026-09-23, 81252029 Ala Vaikunthapurramuloo:
            //   netflix    langs=[Telugu]
            //   primevideo langs=[Hindi]
            // so these are DIFFERENT offerings, not duplicates of one another,
            // and collapsing them loses a real choice from the audio menu.
            //
            // Two earlier shapes were both wrong:
            //
            //  - `if (found.some(s => s.language)) break;` stopped at the first
            //    platform that produced a language, so Prime and Hotstar rows
            //    were never emitted once Netflix answered. It was added to save
            //    requests against a per-IP rate limiter, which is the right
            //    concern but the wrong lever: it paid for pacing with rows.
            //
            //  - upstream's `Promise.all(PLATFORM_ORDER.map(...))` fires every
            //    platform at once. Each platform is a three request chain
            //    (search -> post -> player), so that is nine simultaneous
            //    requests into the same rate limiter. Measured 2026-09-24 after
            //    heavy probing, newtv stopped answering entirely:
            //    "primevideo failed: The operation was aborted due to timeout".
            //
            // Sequential with a gap keeps every row AND stays gentle. The gap is
            // the whole rate-limit budget: raise NETMIRROR_PLATFORM_GAP_MS if
            // the provider starts timing out.
            const labelled = (rows) => rows.some(
                (stream) => stream && (stream.language || (stream.languages || []).length));
            // Unlabelled Netflix rows: ask Netflix's own post.php for the
            // language before the other catalogues (one search + one post).
            let askedNetflix = false;
            if (collected.length && !labelled(collected)) {
                askedNetflix = true;
                const year = Number(String((details && (details.release_date || details.first_air_date)) || '')
                    .slice(0, 4)) || null;
                const lang = await netflixLanguageFromPost(title, type, year);
                if (lang) {
                    console.log(`[NetMirror] netflix-lang ${tmdbId} labelled ${lang} from post.php`);
                    collected = labelNetflixRows(collected, lang,
                        { tmdbId, type: mediaType === 'tv' ? 'tv' : 'movie', season, episode });
                }
            }
            const haveLanguages = labelled(collected);
            if (!haveLanguages) {
                let asked = askedNetflix ? 1 : 0;
                for (const platform of PLATFORM_ORDER) {
                    // netflix already ran as `direct` (the embed-tmdb path).
                    if (platform === 'netflix') continue;
                    if (asked++) await sleep(PLATFORM_GAP_MS);
                    const found = await fetchPlatform(platform, title, type, season, episode);
                    if (found.upstreamError) upstreamError = found.upstreamError;
                    if (found.length) collected.push(...found);
                }
            }
            // Check the CDN BEFORE caching. The 429 comes from the file host,
            // not the API, so without this a throttled url is stored as a good
            // stream for 25 minutes and fails later in the player instead.
            const { streams: live, throttled } = await dropThrottled(hdOnly(collected, true));
            const streams = live;
            if (throttled && !upstreamError) upstreamError = 'CDN throttled';

            // Three different outcomes, three different TTLs. A throttle is the
            // shortest: the limit lifts by itself, so re-asking soon is right,
            // while treating it as "no streams" would hide the provider for 25
            // minutes over something that fixed itself in a few.
            let ttl;
            let why;
            if (upstreamError) {
                // Part or all of the answer is unknown. Short backoff (the
                // rate limiter still gets its rest), never the 25 min hit TTL,
                // and the failure travels with the result so nothing above
                // caches it as complete or as empty.
                ttl = throttled ? Math.min(CDN_COOLDOWN_MS, EMPTY_CACHE_TTL) : EMPTY_CACHE_TTL;
                why = ` (upstream failed: ${upstreamError} - retrying in ${Math.round(ttl / 1000)}s)`;
            } else if (streams.length) {
                ttl = STREAM_CACHE_TTL;
            } else if (throttled) {
                ttl = Math.min(CDN_COOLDOWN_MS, EMPTY_CACHE_TTL);
                why = ` (CDN throttled - retrying in ${Math.round(ttl / 1000)}s)`;
            } else {
                ttl = EMPTY_CACHE_TTL;
                why = ` (empty - backing off ${Math.round(EMPTY_CACHE_TTL / 1000)}s)`;
            }
            streamCache.set(key, { streams, expiresAt: Date.now() + ttl, error: upstreamError });
            console.log(`[NetMirror] ${tmdbId} streams ready: ${streams.length}${why || ''}`);
            if (upstreamError && !streams.length) throw new Error(upstreamError);
            return upstreamError ? failure(upstreamError, [...streams]) : streams;
        })().finally(() => inflight.delete(key));

        inflight.set(key, request);
        return request;
    } catch (err) {
        // Without a cooldown here every page load retried immediately, which
        // meant we hit NetMirror hardest exactly while they were rate limiting
        // us. Record the failure so the next few requests skip them entirely.
        console.error(`[NetMirror] Error: ${err.message} - backing off ${Math.round(EMPTY_CACHE_TTL / 1000)}s`);
        try {
            const k = `${tmdbId}:${type}:${seasonNum || 0}:${episodeNum || 0}`;
            streamCache.set(k, { streams: [], expiresAt: Date.now() + EMPTY_CACHE_TTL, error: err.message });
        } catch (_) { /* key build is best effort */ }
        throw err; // unknown, not "no streams"
    }
}

// masterMatchesTitle is exported for tests. It is the only thing standing
// between the viewer and the wrong film: NetMirror returns a well-formed master
// whose AUDIO renditions carry the correct per-title id and real languages,
// while the VIDEO rungs point at one shared decoy id. Measured 2026-09-22 on
// 155 (The Dark Knight) and 693134 (Dune: Part Two) - both served video from
// files/220884.
module.exports = { getNetmirrorStreams, masterMatchesTitle, nmFetch };