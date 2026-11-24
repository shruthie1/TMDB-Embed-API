'use strict';
// vidout - MultiMovies' "VIDOUT" server (vidout.pages.dev). Its player reads
// a public GitHub catalogue keyed on the TMDB id:
//   movie: raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/movie/<tmdb>
//          -> one line, the HLS master url (.../hls3/.../master.txt)
//   tv:    .../hls/tv/<tmdb>/S<season>.json -> { "<episode>": url }
// A title missing from the catalogue answers 404 (the page then falls back to
// other embeds); that is no rows here, not an error.
//
// Measured 2026-11-24 (multimovies-servers.md, insertunit-vidout.md):
//   - Pushpa 2 (857598): master 200 with 4 tagged renditions hi (DEFAULT),
//     ml, ta, te. RRR (579974): one 1080p variant, audio muxed, no tag.
//   - Master and playlists need Referer vidout.pages.dev (404 without, 200
//     with). Not bound to the IP or User-Agent (VM-resolved url 200 from the
//     Mac). So web goes through /m3u8-proxy, the APK sends the Referer.
//   - Segments are MPEG-TS named .woff2, served as `video/MP2T`.
//   - Only a direct master is used; the catalogue's iframe (`#`) and packed
//     player (/e/<id>) links are skipped.
//
// Language comes only from the master (lib/media/taggedHlsRow.js): RRR's
// untagged track stays unknown.

const tagged = require('../lib/media/taggedHlsRow');

const CATALOGUE = 'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls';
const ORIGIN = 'https://vidout.pages.dev';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = Object.freeze({ 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN });

const _config = {
    budgetMs: Number(process.env.VIDOUT_BUDGET_MS) || 12000,
    stepTimeoutMs: 6000,
};

const _deps = {
    fetchText: (url, headers, timeoutMs = _config.stepTimeoutMs) => tagged.fetchText(url, headers, timeoutMs),
    runtimeMinutes: (tmdbId) => require('../lib/selfheal/proof').runtimeMinutes(tmdbId),
};

// Canary validation title: Pushpa 2, the tagged Telugu master.
const CANARY_TITLE = { tmdbId: '857598', mediaType: 'movie' };

function catalogueUrl(tmdbId, type, season = null) {
    return type === 'tv' ? `${CATALOGUE}/tv/${tmdbId}/S${season}.json` : `${CATALOGUE}/movie/${tmdbId}`;
}

/** Pure: the catalogue value if it is a direct master url, else null. */
function usableLink(value) {
    const link = String(value || '').trim();
    if (!/^https?:\/\/\S+$/.test(link) || link.includes('#')) return null;
    if (/\/(e|v|embed)\/[a-z0-9]+$/i.test(link)) return null;
    return link;
}

function rowFromMaster(masterText, masterUrl) {
    return tagged.rowFromMaster(masterText, masterUrl, { provider: 'vidout', display: 'VIDOUT', headers: HEADERS });
}

async function getVidoutStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    if (type === 'tv' && !(seasonNum && episodeNum)) {
        console.log(`[vidout] tv ${tmdbId} without season/episode - no rows (never guess S1E1)`);
        return [];
    }
    const t0 = Date.now();
    const deadline = t0 + _config.budgetMs;
    const left = () => Math.max(500, Math.min(_config.stepTimeoutMs, deadline - Date.now()));
    const cat = await _deps.fetchText(catalogueUrl(tmdbId, type, seasonNum), { 'User-Agent': UA }, left());
    if (cat.status === 404) {
        console.log(`[vidout] not-in-catalogue ${type} ${tmdbId}`);
        return [];
    }
    if (!(cat.status >= 200 && cat.status < 300)) throw new Error(`vidout: catalogue HTTP ${cat.status} for ${tmdbId}`);
    let value = cat.text;
    if (type === 'tv') {
        let map = null;
        try { map = JSON.parse(cat.text); } catch { map = null; }
        value = map && typeof map === 'object' ? map[String(episodeNum)] : null;
    }
    const masterUrl = usableLink(value);
    if (!masterUrl) {
        console.log(`[vidout] no direct master for ${type} ${tmdbId}${type === 'tv' ? ` S${seasonNum}E${episodeNum}` : ''}`);
        return [];
    }
    const master = await _deps.fetchText(masterUrl, HEADERS, left());
    if (!(master.status >= 200 && master.status < 300)) throw new Error(`vidout: master HTTP ${master.status} for ${tmdbId}`);
    const row = rowFromMaster(master.text, masterUrl);
    if (!row) throw new Error(`vidout: master without variants for ${tmdbId}`);
    if (type === 'movie') {
        const runtime = await _deps.runtimeMinutes(tmdbId).catch(() => null);
        const rc = await tagged.runtimeCheck(master.text, masterUrl, runtime, (u) => _deps.fetchText(u, HEADERS, left()));
        const mins = rc.seconds ? Math.round(rc.seconds / 60) : '-';
        if (rc.verdict === 'mismatch') {
            console.log(`[vidout] runtime mismatch ${tmdbId}: ${mins}m vs ${runtime}m - row dropped`);
            return [];
        }
        console.log(`[vidout] runtime ${rc.verdict} ${tmdbId}: ${mins}m vs ${runtime || '-'}m`);
    }
    console.log(`[vidout] ok ${tmdbId} in ${Date.now() - t0}ms rows=1 langs=[${row.languages.join(',')}] ${row.quality}`);
    return [row];
}

module.exports = {
    getVidoutStreams,
    CANARY_TITLE,
    HEADERS,
    catalogueUrl,
    usableLink,
    rowFromMaster,
    _config,
    _deps,
};
