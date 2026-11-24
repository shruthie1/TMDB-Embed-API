'use strict';
// insertunit - the first server inside MultiMovies' "GD mirror" embed
// (api.insertunit.ws/embed/imdb/<imdb>), keyed on the IMDb id.
//
// Measured 2026-11-24 (multimovies-servers.md, insertunit-vidout.md):
//   - ONE page GET: plain HTML whose player opts carry the master as a JS
//     literal `hls: "https://<x>.interkh.com/.../master.m3u8?<signed>"`.
//     A series page carries `seasons: [{season, episodes: [{episode, hls}]}]`.
//   - The master tags each audio rendition: RRR has rus0-5 `ru` (DEFAULT=YES),
//     tel6 `te`, hin7 `hi`; Pushpa 2 has ru/hi/ta and no Telugu. The page's
//     own labels ("Original", "Hindi Original") are NOT used: "Original" is
//     te on RRR and hi on Pushpa 2.
//   - Signed segments are bound to the User-Agent that fetched the page:
//     same UA 200 (Mac fetching a VM-resolved master), another UA 410. Not
//     bound to the IP. A Referer from insertunit answered 400. So the row
//     carries the page UA only; web goes through /m3u8-proxy (a browser
//     cannot set User-Agent), the APK sends it direct.
//   - VM1 cannot getaddrinfo the *.interkh.com rendition hosts (DNAME,
//     utils/dnsFallback.js), so every fetch here uses the fallback lookup.
//   - Max 720p. Signed for 10 days (`t`).
//
// Language comes only from the master (lib/media/taggedHlsRow.js).

const tagged = require('../lib/media/taggedHlsRow');

const ORIGIN = 'https://api.insertunit.ws';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const _config = {
    budgetMs: Number(process.env.INSERTUNIT_BUDGET_MS) || 12000,
    stepTimeoutMs: 6000,
};

// Replaceable for tests.
const _deps = {
    fetchText: (url, headers, timeoutMs = _config.stepTimeoutMs) => tagged.fetchText(url, headers, timeoutMs),
    imdbOf: (type, tmdbId) => require('../utils/tmdb').resolveImdbId(type, tmdbId),
    runtimeMinutes: (tmdbId) => require('../lib/selfheal/proof').runtimeMinutes(tmdbId),
};

// Page patterns (Part B item 3): read from resolve-config `insertunit` at call
// time, tried in order; these code defaults stand in when the config has none.
// The first is the form measured 2026-11-24 (`hls: "https://..."`); the
// others are the shapes the same player config takes when serialised as JSON
// or as a jwplayer-style `file:`.
const CONFIG_DEFAULTS = {
    hlsPatterns: [
        '\\bhls:\\s*"(https?:\\/\\/[^"]+)"',
        '"hls"\\s*:\\s*"(https?:\\/\\/[^"]+)"',
        '\\bfile:\\s*"(https?:\\/\\/[^"]+\\.m3u8[^"]*)"',
    ],
    seasonsPatterns: [
        '\\bseasons:\\s*\\[',
        '"seasons"\\s*:\\s*\\[',
    ],
};

function patterns(override) {
    const pick = (field) => {
        if (override && Array.isArray(override[field])) return override[field];
        try { return require('../lib/selfheal/config').cfg('insertunit', field, CONFIG_DEFAULTS[field]); } catch { return CONFIG_DEFAULTS[field]; }
    };
    // Config first, then any code default it does not already list.
    const merged = (field) => [...new Set([...pick(field), ...CONFIG_DEFAULTS[field]])];
    return { hls: merged('hlsPatterns'), seasons: merged('seasonsPatterns') };
}
function safeRe(src) { try { return new RegExp(src); } catch { return null; } }

// The canary's validation title (providers/registry.js verifyTitleOf): RRR,
// where the Telugu rendition was found. No heal: this provider has one host.
const CANARY_TITLE = { tmdbId: '579974', mediaType: 'movie' };

function embedUrl(imdbId) {
    return `${ORIGIN}/embed/imdb/${imdbId}`;
}

// The JSON array that starts at `from` ('[' ... matching ']'), or null.
function arrayAt(s, from) {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = from; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '[') depth++;
        else if (c === ']' && --depth === 0) {
            try { return JSON.parse(s.slice(from, i + 1)); } catch { return null; }
        }
    }
    return null;
}

/** The seasons array on a series page, or null. */
function seasonsFromPage(s, pats) {
    for (const src of pats.seasons) {
        const re = safeRe(src);
        const m = re && re.exec(s);
        if (!m) continue;
        const seasons = arrayAt(s, s.indexOf('[', m.index));
        if (Array.isArray(seasons)) return seasons;
    }
    return null;
}

/** Pure: the page's HLS master for a movie, or for one episode; null when none. */
function masterFromPage(html, type, season = null, episode = null, override = null) {
    const s = String(html || '');
    const pats = patterns(override);
    if (type !== 'tv') {
        for (const src of pats.hls) {
            const re = safeRe(src);
            const m = re && re.exec(s);
            if (m && m[1]) return m[1];
        }
        return null;
    }
    const seasons = seasonsFromPage(s, pats);
    if (!Array.isArray(seasons)) return null;
    const se = seasons.find((x) => x && Number(x.season) === Number(season));
    const ep = se && Array.isArray(se.episodes) && se.episodes.find((x) => x && Number(x.episode) === Number(episode));
    const url = ep && typeof ep.hls === 'string' ? ep.hls : null;
    return url && /^https?:\/\//.test(url) ? url : null;
}

/** Pure: the row for a fetched master. */
function rowFromMaster(masterText, masterUrl) {
    return tagged.rowFromMaster(masterText, masterUrl, { provider: 'insertunit', display: 'Insertunit', headers: { 'User-Agent': UA } });
}

async function getInsertunitStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    if (type === 'tv' && !(seasonNum && episodeNum)) {
        console.log(`[insertunit] tv ${tmdbId} without season/episode - no rows (never guess S1E1)`);
        return [];
    }
    const t0 = Date.now();
    const deadline = t0 + _config.budgetMs;
    const left = () => Math.max(500, Math.min(_config.stepTimeoutMs, deadline - Date.now()));
    const imdb = await _deps.imdbOf(type, tmdbId);
    if (!imdb || !/^tt\d+$/.test(imdb)) {
        console.log(`[insertunit] no IMDb id for ${type} ${tmdbId} - no rows`);
        return [];
    }
    const page = await _deps.fetchText(embedUrl(imdb), { 'User-Agent': UA }, left());
    if (page.status === 404) {
        console.log(`[insertunit] not-found ${imdb} (HTTP 404)`);
        // Upstream says "no such title": not a failure, keep it out of the
        // breaker (see providers/vidout.js notListed).
        return Object.assign([], { notListed: true });
    }
    if (!(page.status >= 200 && page.status < 300)) throw new Error(`insertunit: page HTTP ${page.status} for ${imdb}`);
    const masterUrl = masterFromPage(page.text, type, seasonNum, episodeNum);
    if (!masterUrl) {
        console.log(`[insertunit] no hls master on the page for ${imdb}${type === 'tv' ? ` S${seasonNum}E${episodeNum}` : ''}`);
        // No pattern matched anything (a series page with no seasons array,
        // or a movie page with no master): keep a redacted copy for diagnosis.
        if (type !== 'tv' || !seasonsFromPage(String(page.text || ''), patterns())) {
            require('../lib/mmhub/page').parseFailed('insertunit', page.text, { sampleDir: _deps.sampleDir });
        }
        return [];
    }
    const master = await _deps.fetchText(masterUrl, { 'User-Agent': UA }, left());
    if (!(master.status >= 200 && master.status < 300)) throw new Error(`insertunit: master HTTP ${master.status} for ${imdb}`);
    const row = rowFromMaster(master.text, masterUrl);
    if (!row) throw new Error(`insertunit: master without variants for ${imdb}`);
    if (type === 'movie') {
        const runtime = await _deps.runtimeMinutes(tmdbId).catch(() => null);
        const rc = await tagged.runtimeCheck(master.text, masterUrl, runtime,
            (u) => _deps.fetchText(u, { 'User-Agent': UA }, left()));
        const mins = rc.seconds ? Math.round(rc.seconds / 60) : '-';
        if (rc.verdict === 'mismatch') {
            console.log(`[insertunit] runtime mismatch ${tmdbId}: ${mins}m vs ${runtime}m - row dropped`);
            return [];
        }
        console.log(`[insertunit] runtime ${rc.verdict} ${tmdbId}: ${mins}m vs ${runtime || '-'}m`);
    }
    console.log(`[insertunit] ok ${tmdbId} in ${Date.now() - t0}ms rows=1 langs=[${row.languages.join(',')}] ${row.quality}`);
    return [row];
}

module.exports = {
    getInsertunitStreams,
    CONFIG_DEFAULTS,
    CANARY_TITLE,
    UA,
    embedUrl,
    masterFromPage,
    rowFromMaster,
    _config,
    _deps,
};
