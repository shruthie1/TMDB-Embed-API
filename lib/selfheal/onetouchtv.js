'use strict';
// onetouchtv heal run (review I3, 2026-11-21). A candidate api host is
// adopted only if, ON THAT HOST, the search for the validation title finds it
// (findBestOttMatch: title "RRR", year 2022) and its detail answers. Nothing
// is read from the provider's caches or last-good rows (those are keyed by
// title, not host). 2 GETs per candidate, from the run budget.
//
// Validation title: RRR 579974. onetouchtv answered 0 rows for Inception and
// 1 row "RRR (2022)" for RRR (laptop, 2026-11-21).

const proof = require('./proof');

const NAME = 'onetouchtv';
const MAX_VALIDATED = 3;
const VERIFY = { tmdbId: '579974', mediaType: 'movie', title: 'RRR', year: 2022 };

/**
 * deps: { fetchOnce(url) -> decrypted result, findBestOttMatch, bases() }
 * (providers/onetouchtv.js passes its own).
 */
function createRun(deps) {
    const budget = proof.createBudget();
    const state = { validated: 0, proven: new Set() };
    const strip = (u) => String(u || '').replace(/\/+$/, '');
    const reject = (host, why) => { console.warn(`[heal] ${NAME} reject ${host} ${why}`); return false; };

    async function get(url) {
        if (!budget.charge(1)) throw new Error(`heal GET cap ${budget.max}`);
        return deps.fetchOnce(url);
    }

    async function validate(cand) {
        let host;
        try { host = new URL(cand).host; } catch { return reject(cand, 'bad-url'); }
        if (!/^https:\/\//.test(cand)) return reject(host, 'not-https');
        if (state.validated >= MAX_VALIDATED) return reject(host, `cap ${MAX_VALIDATED}`);
        state.validated++;
        const base = strip(cand);
        let results;
        try { results = await get(`${base}/vod/search?keyword=${encodeURIComponent(VERIFY.title)}`); } catch (e) {
            return reject(host, `search ${e.message}`);
        }
        const match = deps.findBestOttMatch(Array.isArray(results) ? results : [], VERIFY.title, VERIFY.year, 'movie', 1);
        if (!match || match.id === undefined) return reject(host, 'title-not-found');
        let detail;
        try { detail = await get(`${base}/vod/${match.id}/detail`); } catch (e) {
            return reject(host, `detail ${e.message}`);
        }
        if (!detail) return reject(host, 'detail-empty');
        console.warn(`[heal] ${NAME} valid ${host} title "${match.title}"`);
        state.proven.add(base);
        return true;
    }

    const titleProven = async (cand) => (state.proven.has(strip(cand)) ? true : null);
    const bases = (deps.bases ? deps.bases() : []).map(strip);
    // Task 6: the Flutter bundle names the api host (="https://api3...").
    // upstreamBase's player scan misses it (main.dart.js is not a <script
    // src> on the page, and api3. fails its /^api[.-]/ test). 1 GET, lazy:
    // runs only after the redirect and config candidates failed.
    async function bundleTrail(ctx) {
        const front = deps.front ? strip(deps.front()) : '';
        if (!front) return [];
        const f = ctx && ctx.fetch && ctx.fetch.charged ? ctx.fetch : budget.wrap((ctx && ctx.fetch) || globalThis.fetch);
        const r = await f(`${front}/main.dart.js`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
        if (!r || r.status !== 200) { console.warn(`[heal] ${NAME} bundle HTTP ${r && r.status}`); return []; }
        const hosts = require('./keys').apiHostsFromBundle(await r.text());
        console.warn(`[heal] ${NAME} bundle hosts ${hosts.join(',') || 'none'}`);
        return hosts.map((url) => ({ url, how: 'bundle', from: front }));
    }
    return { extra: bases.slice(1), trails: [bundleTrail], validate, titleProven, budget, state };
}

module.exports = { createRun, VERIFY };
