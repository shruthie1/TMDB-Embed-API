'use strict';
// MultiMovies hub (Part B item 1): ties the servers MultiMovies lists for a
// title (lib/mmhub/page.js) to the extractors that resolve them.
//
// Every listed server with an extractor is a registry provider of its own
// (multimovies = VidBolt, vidrift, insertunit = GD mirror's first embed,
// vidout). /api/streams already runs them in parallel and the early-answer
// path serves each one's rows as they land, so the hub does NOT call them a
// second time (that would double every upstream call). After the fan-out it
// reads the title page in the background (cached 7 d / 6 h) and records, per
// listed server, rows / Telugu rows / errors on /api/health. Servers whose
// host is not in the config are logged `[mm] unknown server <host>` once.

const state = require('./state');
const { isTelugu } = require('./lastKnownGood');

// Test seam. Under `node --test` the default reader is off, so a test that
// runs the streams route never reaches MultiMovies or TMDB from the
// background (same rule as utils/store.js storePathFromEnv).
let reader = null;
function _setReader(fn) { reader = fn; }

/**
 * ctx: { tmdbId, type, season, episode, imdbId }
 * byProvider: Map(providerName -> { rows: [], err?: string })
 * deps.read (tests): replaces page.read
 */
async function observe(ctx, byProvider, deps = {}) {
    let page;
    try {
        const read = deps.read || reader || (process.env.NODE_TEST_CONTEXT ? null : require('./page').read);
        if (!read) return null;
        page = await read({ tmdbId: ctx.tmdbId, type: ctx.type, season: ctx.season, episode: ctx.episode, imdbId: ctx.imdbId });
    } catch (e) {
        console.warn(`[mm] observe failed ${ctx.tmdbId}: ${e.message}`);
        return null;
    }
    if (!page || !Array.isArray(page.servers)) return null;
    for (const srv of page.servers) {
        if (!srv.extractor) continue;
        const r = byProvider.get(srv.extractor);
        if (!r) continue;
        const rows = Array.isArray(r.rows) ? r.rows : [];
        state.serverResult(srv.name, { rows: rows.length, telugu: rows.filter(isTelugu).length,
            err: r.err || null, extractor: srv.extractor });
    }
    return page;
}

module.exports = { observe, _setReader };
