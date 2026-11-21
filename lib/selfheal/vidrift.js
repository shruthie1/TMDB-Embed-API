'use strict';
// vidrift host and path discovery when every known host fails.
//
// Shares the MultiMovies title-page trail with multimovies
// (lib/selfheal/titlePage.js): the page lists a server named "Vidrift" with
// its full embed URL. The Nuvio scraper has no Vidrift entry (measured
// v1.3.1), so it only gives a MultiMovies SITE to rerun the title page from.
//
// First a probe of the current host classifies the failure
// (lib/selfheal/classify.js): a 403 (down) or a Cloudflare challenge
// (blocked) is not a move, so no title-page GET is made. A 404 on the path
// while the host root answers is drift: the title page's URL may carry a new
// path template, which is validated and saved as a `moviePath` heal.
//
// Every host candidate must pass validate(): https, the RRR 579974 page has
// embedMeta.orionStreams with at least 1 entry, and its first master answers
// #EXTM3U. The registry then runs the provider's own resolve of RRR.
// Caps per run: 3 candidates validated, 12 GETs.

const selfheal = require('./config');
const titlePage = require('./titlePage');
const { explain, shouldHeal } = require('./classify');
const proof = require('./proof');

const NAME = 'vidrift';
const PROBE = '579974'; // RRR: Telugu, 4 orion masters (measured 2026-11-21)
const MAX_GETS = 12;
const MAX_VALIDATED = 3;
const MAX_PATH_CHECKS = 2; // own slots, never a host slot (review I2)
const TIMEOUT_MS = 10000;
const DEFAULTS = { bases: ['https://embed.vidrift.net', 'https://embed.vidrift.in'], moviePath: '/embed/movie/{id}' };
const MM_DEFAULTS = {
    sites: ['https://multimovies.wtf'],
    scrapers: ['https://raw.githubusercontent.com/mayurgj/nama/main/providers/multimovies.js'],
};
const PAGE_REFERER = 'https://m1.multimovies.courses/';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/124.0 Mobile Safari/537.36';

// `var embedMeta = {...};` -> object, or null. The provider's own parser, so
// the heal and the resolve read the page the same way.
function embedMeta(html) { return require('../../providers/vidrift').parseEmbedMeta(html); }

function createRun({ cfg = selfheal.cfg, ownResolvePath = null } = {}) {
    // One GET budget for the whole run, shared with the registry (review M6).
    const budget = proof.createBudget(MAX_GETS);
    const state = { validated: 0, pathChecks: 0, landingFailed: false, skip: null, pending: null, proven: new Set() };
    Object.defineProperty(state, 'gets', { get: () => budget.gets, enumerable: true });
    const read = (f, d) => cfg(NAME, f, d);
    const mm = (f, d) => cfg('multimovies', f, d);
    const moviePath = () => read('moviePath', DEFAULTS.moviePath);

    const counted = (ctx) => {
        const f = ctx.fetch && ctx.fetch.charged ? ctx.fetch : budget.wrap(ctx.fetch);
        return (url, opts = {}) => f(url, { ...opts, redirect: 'follow', timeout: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    };
    const reject = (host, reason) => { console.warn(`[heal] ${NAME} reject ${host} ${reason}`); return false; };
    const referer = () => { const m = titlePage.fresh(); return m ? `${m.site}/` : PAGE_REFERER; };

    // Page + first master on `cand` with the path template `tmpl`.
    async function check(cand, tmpl, ctx, slot = 'host') {
        let host;
        try { host = new URL(cand).host; } catch { return reject(cand, 'bad-url'); }
        if (!/^https:\/\//.test(cand)) return reject(host, 'not-https');
        if (slot === 'host') {
            if (state.validated >= MAX_VALIDATED) return reject(host, `cap ${MAX_VALIDATED}`);
            state.validated++;
        } else {
            if (state.pathChecks >= MAX_PATH_CHECKS) return reject(host, `path cap ${MAX_PATH_CHECKS}`);
            state.pathChecks++;
        }
        const get = counted(ctx);
        let res;
        try {
            res = await get(`${cand}${tmpl.replace('{id}', PROBE)}`, { headers: { 'user-agent': UA, referer: referer() } });
        } catch (e) { return reject(host, `fetch ${e.message}`); }
        if (res.status < 200 || res.status >= 300) return reject(host, `http ${res.status}`);
        const meta = embedMeta(await res.text());
        if (!meta) return reject(host, 'no-embedMeta');
        if (!Array.isArray(meta.orionStreams) || !meta.orionStreams.length) {
            return reject(host, `orionStreams ${meta.orionStreams === null ? 'null' : Array.isArray(meta.orionStreams) ? 'empty' : 'missing'}`);
        }
        // Review I3: the page must be the validation title itself.
        if (String(meta.tmdbId) !== PROBE) return reject(host, `title-mismatch tmdbId ${meta.tmdbId}`);
        const first = meta.orionStreams[0] || {};
        let masterUrl;
        try { masterUrl = new URL(first.url || first.proxyUrl, `${cand}/`).href; } catch { return reject(host, 'bad-master-url'); }
        try {
            const m = await get(masterUrl, { headers: { 'user-agent': UA, referer: `${cand}/`, origin: cand } });
            const body = m.status >= 200 && m.status < 300 ? await m.text() : '';
            if (!String(body).trimStart().startsWith('#EXTM3U')) return reject(host, `master ${m.status} not-m3u8`);
        } catch (e) { return reject(host, `master ${e.message}`); }
        console.warn(`[heal] ${NAME} valid ${host}`);
        state.proven.add(strip(cand));
        return true;
    }

    // One probe of the current host decides whether a title-page run helps.
    async function probe(ctx, current) {
        const get = counted(ctx);
        let res;
        try {
            res = await get(`${current}${moviePath().replace('{id}', PROBE)}`, { headers: { 'user-agent': UA, referer: referer() } });
        } catch (e) {
            return explain({ message: e.message });
        }
        if (res.status === 404) {
            let rootOk = false;
            try { const r = await get(`${current}/`, { headers: { 'user-agent': UA } }); rootOk = r.status >= 200 && r.status < 400; } catch { /* host dead */ }
            return explain({ status: 404, base: true, hostAlive: rootOk });
        }
        const body = res.status >= 400 ? await res.text().catch(() => '') : '';
        const headers = res.headers;
        return explain({ status: res.status, body, headers, message: `HTTP ${res.status}` });
    }

    // A new movie path from the title page (review I2, M7). On the current
    // host: check it (path slot), own resolve pinned to that host, save. On a
    // new host: pending; validate() checks that host with this path and
    // onApplied() saves it once the registry adopted the host.
    async function tryPath(ctx, origin, url) {
        const tmpl = titlePage.pathFromUrl(url, titlePage.PROBE_TMDB);
        if (!tmpl) { reject(origin, 'nopath'); return; }
        if (tmpl === moviePath()) return;
        const up = require('../../utils/upstreamBase');
        const current = up.getBase(NAME, strip(read('bases', DEFAULTS.bases)[0]));
        if (strip(origin) !== current) {
            state.pending = { origin: strip(origin), tmpl };
            console.warn(`[heal] ${NAME} path ${tmpl} pending host ${new URL(origin).host}`);
            return;
        }
        if (!(await check(origin, tmpl, ctx, 'path'))) return;
        if (ownResolvePath && !(await up.withBase(NAME, strip(origin), () => ownResolvePath(tmpl)))) {
            reject(origin, 'path-own-resolve-empty');
            return;
        }
        savePath(tmpl);
    }

    function savePath(tmpl) {
        require('../../utils/upstreamBase').setField(NAME, 'moviePath', tmpl, 'titlepage');
        console.warn(`[heal] ${NAME} path ${tmpl} via titlepage`);
    }

    function onApplied(url) {
        const pd = state.pending;
        if (pd && strip(url) === pd.origin) { savePath(pd.tmpl); state.pending = null; }
    }

    async function fromPage(ctx, site) {
        const r = await titlePage.read({ fetch: counted(ctx) }, site);
        if (r.failedAt) {
            if (r.failedAt === 'landing') state.landingFailed = true;
            return [];
        }
        if (r.vidbolt) titlePage.offer('multimovies', r.vidbolt.origin);
        if (!r.vidrift) return [];
        // The page's path is evidence whether the host moved or only the
        // path did (review M7); tryPath decides now or pending.
        await tryPath(ctx, r.vidrift.origin, r.vidrift.url);
        return [{ url: r.vidrift.origin, how: 'titlepage', from: r.site }];
    }

    async function titlePageTrail(ctx) {
        const up = require('../../utils/upstreamBase');
        const current = up.getBase(NAME, strip(read('bases', DEFAULTS.bases)[0]));
        const kind = await probe(ctx, current);
        state.kind = kind.kind;
        console.warn(`[heal] ${NAME} probe ${current} ${kind.kind} rule=${kind.rule}`);
        // Review I1: blocked, throttled or 5xx skips; a timeout or a reset
        // may be a move, so the title page is read.
        if (!shouldHeal(kind)) {
            state.skip = kind.kind;
            console.warn(`[heal] ${NAME} skip titlepage (${kind.kind})`);
            return [];
        }
        const out = titlePage.takeOffers(NAME).map((url) => ({ url, how: 'titlepage', from: 'offer' }));
        for (const site of mm('sites', MM_DEFAULTS.sites)) {
            const found = await fromPage(ctx, site);
            out.push(...found);
            if (found.length) break;
        }
        return out;
    }

    async function scraperTrail(ctx) {
        if (state.skip || !state.landingFailed) return [];
        const out = [];
        for (const url of mm('scrapers', MM_DEFAULTS.scrapers)) {
            let text;
            try {
                const res = await counted(ctx)(url, { headers: { 'user-agent': titlePage.UA } });
                if (res.status < 200 || res.status >= 300) continue;
                text = await res.text();
            } catch (e) { console.warn(`[heal] ${NAME} scraper failed ${url}: ${e.message}`); continue; }
            // SITE.base only: the scraper names no Vidrift host.
            const site = require('./vidbolt').fromScraper(text).site;
            if (site) {
                console.warn(`[heal] ${NAME} scraper site ${site}: rerun titlepage`);
                out.push(...await fromPage(ctx, site));
            }
        }
        return out;
    }

    const pendingFor = (cand) => (state.pending && strip(cand) === state.pending.origin ? state.pending.tmpl : null);
    const validate = (cand, ctx) => check(cand, pendingFor(cand) || moviePath(), ctx);
    // A host that moved with its path resolves with the pending path (the
    // registry has pinned the candidate). Rows are not needed after: the
    // title is proven by embedMeta.tmdbId (titleProven).
    const ownResolve = async (cand, fn, vt) => {
        const tmpl = pendingFor(cand);
        if (tmpl && ownResolvePath) return (await ownResolvePath(tmpl)) ? [{ provenBy: 'embedMeta' }] : [];
        return fn(vt.tmdbId, vt.mediaType, null, null);
    };
    const titleProven = async (cand) => (state.proven.has(strip(cand)) ? true : null);
    const bases = read('bases', DEFAULTS.bases).map(strip);
    return { extra: bases.slice(1), trails: [titlePageTrail, scraperTrail], validate, ownResolve, titleProven, onApplied, budget, state };
}

const strip = (u) => String(u).replace(/\/+$/, '');

module.exports = {
    createRun, embedMeta, MAX_GETS, MAX_VALIDATED, MAX_PATH_CHECKS, PROBE,
    vidriftFromTitle: titlePage.vidriftFromTitle, pathFromUrl: titlePage.pathFromUrl,
};
