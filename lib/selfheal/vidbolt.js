'use strict';
// multimovies (VidBolt) host discovery when every known host fails.
//
// Order (spec section 5): redirect and config `bases` (utils/upstreamBase.js),
// then the MultiMovies title-page trail (3 GETs per site, shared with vidrift
// via lib/selfheal/titlePage.js), then the Nuvio scraper file (1 GET each,
// read as TEXT, never run). Every candidate must pass validate(): https, an
// /api/resolve JSON with an hls source whose master carries
// #EXT-X-MEDIA:TYPE=AUDIO. The registry then runs the provider's own resolve
// of Inception 27205 before anything is adopted.
//
// Caps per run: 3 candidates validated, 12 GETs (trails + validation).

const selfheal = require('./config');
const titlePage = require('./titlePage');
const { explain } = require('./classify');
const proof = require('./proof');

const NAME = 'multimovies';
const PROBE = titlePage.PROBE_TMDB;
const MAX_GETS = 12;
const MAX_VALIDATED = 3;
// Path checks have their own slots; they never use a host slot (review I2).
const MAX_PATH_CHECKS = 2;
const TIMEOUT_MS = 10000;
const DEFAULTS = {
    bases: ['https://vidbolt.xyz', 'https://vidbolt.pro'],
    resolvePath: '/api/resolve',
    playerPath: '/movie/{id}',
    sites: ['https://multimovies.wtf'],
    scrapers: ['https://raw.githubusercontent.com/mayurgj/nama/main/providers/multimovies.js'],
};

/** `{ vidbolt, site }` from the Nuvio scraper source text. Text only. */
function fromScraper(text) {
    const s = String(text || '');
    const vb = /name:\s*"VidBolt",\s*url:\s*"(https?:\/\/[^\/"]+)\/movie\//.exec(s);
    const site = /var SITE = \{[^}]*base:\s*"(https?:\/\/[^"]+)"/.exec(s);
    return { vidbolt: vb ? vb[1] : null, site: site ? site[1].replace(/\/+$/, '') : null };
}

const fill = (tmpl, id) => String(tmpl).replace('{id}', id);
const strip = (u) => String(u || '').replace(/\/+$/, '');

// Server ids from a VidBolt player page ("servers":[{"id":"orion",...}]).
// Same rule as providers/multimovies.js parseServerIds (not exported there).
function serverIds(html) {
    const m = /"servers"\s*:\s*(\[[^\]]*\])/.exec(String(html || ''));
    if (!m) return null;
    try {
        const ids = JSON.parse(m[1]).map((x) => x && x.id).filter((id) => typeof id === 'string' && /^[a-z0-9_-]{1,32}$/i.test(id));
        return ids.length ? ids : null;
    } catch { return null; }
}

/**
 * One heal run: shared GET/validation counters across trails and validate.
 * cfg(provider, field, fallback) defaults to the live config.
 */
function createRun({ cfg = selfheal.cfg } = {}) {
    // One GET budget for the whole run, shared with the registry (review M6).
    const budget = proof.createBudget(MAX_GETS);
    const state = { validated: 0, pathChecks: 0, landingFailed: false, pending: null };
    Object.defineProperty(state, 'gets', { get: () => budget.gets, enumerable: true });
    const read = (f, d) => cfg(NAME, f, d);

    // ctx.fetch is already charged inside a registry run; a bare fetch is not.
    const counted = (ctx) => {
        const f = ctx.fetch && ctx.fetch.charged ? ctx.fetch : budget.wrap(ctx.fetch);
        return (url, opts = {}) => f(url, { ...opts, redirect: 'follow', timeout: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    };
    const reject = (host, reason) => { console.warn(`[heal] ${NAME} reject ${host} ${reason}`); return false; };

    async function titlePageFrom(ctx, site) {
        const r = await titlePage.read({ fetch: counted(ctx) }, site);
        if (r.failedAt) {
            if (r.failedAt === 'landing') state.landingFailed = true;
            return [];
        }
        if (r.vidrift) titlePage.offer('vidrift', r.vidrift.origin);
        if (r.vidbolt && r.vidbolt.url) state.playerUrl = { origin: r.vidbolt.origin, url: r.vidbolt.url };
        return r.vidbolt ? [{ url: r.vidbolt.origin, how: 'titlepage', from: r.site }] : [];
    }

    // The title page's VidBolt URL may carry a new player path (review I2).
    // The query is dropped (a session token is not a path). The path must
    // serve a player page with a server list on its host; it is saved only
    // after that host passed validation: now when it is the current host,
    // else in onApplied() once the registry adopts that host.
    async function tryPlayerPath(ctx) {
        const p = state.playerUrl;
        if (!p) return;
        const raw = titlePage.pathFromUrl(p.url, PROBE);
        const tmpl = raw ? raw.split('?')[0] : null;
        if (!tmpl || !/^\/[\w./-]*\{id\}[\w./-]*$/.test(tmpl)) { reject(new URL(p.origin).host, 'nopath'); return; }
        if (tmpl === read('playerPath', DEFAULTS.playerPath)) return;
        const host = new URL(p.origin).host;
        if (state.pathChecks >= MAX_PATH_CHECKS) { reject(host, `path cap ${MAX_PATH_CHECKS}`); return; }
        state.pathChecks++;
        let ids = null;
        try {
            const res = await counted(ctx)(`${p.origin}${fill(tmpl, PROBE)}`, { headers: { 'user-agent': titlePage.UA, referer: `${p.origin}/` } });
            if (res.status >= 200 && res.status < 300) ids = serverIds(await res.text());
            else { reject(host, `path ${tmpl} http ${res.status}`); return; }
        } catch (e) { reject(host, `path ${tmpl} fetch ${e.message}`); return; }
        if (!ids) { reject(host, `path ${tmpl} no-server-list`); return; }
        const up = require('../../utils/upstreamBase');
        const current = up.getBase(NAME, strip(read('bases', DEFAULTS.bases)[0]));
        if (strip(p.origin) === current) {
            if (!(await validate(p.origin, ctx, tmpl, 'path'))) return;
            savePath(tmpl, 'titlepage');
            return;
        }
        state.pending = { origin: strip(p.origin), tmpl };
        console.warn(`[heal] ${NAME} path ${tmpl} pending host ${host}`);
    }

    function savePath(tmpl, how) {
        require('../../utils/upstreamBase').setField(NAME, 'playerPath', tmpl, how);
        console.warn(`[heal] ${NAME} path ${tmpl} via ${how}`);
    }

    // The registry calls this after it adopted `url` (own resolve and title
    // proof passed). A pending path for that host is saved now.
    function onApplied(url) {
        const pd = state.pending;
        if (pd && strip(url) === pd.origin) { savePath(pd.tmpl, 'titlepage'); state.pending = null; }
    }

    async function titlePageTrail(ctx) {
        const out = titlePage.takeOffers(NAME).map((url) => ({ url, how: 'titlepage', from: 'offer' }));
        for (const site of read('sites', DEFAULTS.sites)) {
            const found = await titlePageFrom(ctx, site);
            out.push(...found);
            if (found.length) break;
        }
        await tryPlayerPath(ctx);
        return out;
    }

    async function scraperTrail(ctx) {
        const out = [];
        for (const url of read('scrapers', DEFAULTS.scrapers)) {
            let text;
            try {
                const res = await counted(ctx)(url, { headers: { 'user-agent': titlePage.UA } });
                if (res.status < 200 || res.status >= 300) { console.warn(`[heal] ${NAME} scraper HTTP ${res.status} ${url}`); continue; }
                text = await res.text();
            } catch (e) { console.warn(`[heal] ${NAME} scraper failed ${url}: ${e.message}`); continue; }
            const s = fromScraper(text);
            if (s.vidbolt) out.push({ url: s.vidbolt, how: 'scraper', from: url });
            // The landing page was dead: the scraper's site may be the new one.
            if (s.site && state.landingFailed && !titlePage.fresh()) {
                console.warn(`[heal] ${NAME} scraper site ${s.site}: rerun titlepage`);
                out.push(...await titlePageFrom(ctx, s.site));
            }
        }
        return out;
    }

    async function validate(cand, ctx, playerTmpl = null, slot = 'host') {
        let host;
        try { host = new URL(cand).host; } catch { return reject(cand, 'bad-url'); }
        if (!/^https:\/\//.test(cand)) return reject(host, 'not-https');
        if (slot === 'host') {
            if (state.validated >= MAX_VALIDATED) return reject(host, `cap ${MAX_VALIDATED}`);
            state.validated++;
            // A host and a path that moved together: check the host with its path.
            if (!playerTmpl && state.pending && strip(cand) === state.pending.origin) playerTmpl = state.pending.tmpl;
        }
        const get = counted(ctx);
        const resolvePath = read('resolvePath', DEFAULTS.resolvePath);
        const referer = `${cand}${fill(playerTmpl || read('playerPath', DEFAULTS.playerPath), PROBE)}`;
        let res;
        try {
            res = await get(`${cand}${resolvePath}?type=movie&id=${PROBE}`, { headers: { 'user-agent': titlePage.UA, referer } });
        } catch (e) { return reject(host, `fetch ${e.message}`); }
        if (res.status === 404) {
            // 404 on the resolve path while the host root answers: the path
            // moved, not the host. The title page does not show resolvePath,
            // so this needs a human edit of the remote config (drift).
            let rootOk = false;
            try { const r = await get(`${cand}/`, { headers: { 'user-agent': titlePage.UA } }); rootOk = r.status >= 200 && r.status < 400; } catch { /* dead */ }
            const k = explain({ status: 404, base: true, hostAlive: rootOk });
            return reject(host, k.kind === 'drift' ? 'resolvePath (drift)' : `http 404 (${k.kind})`);
        }
        if (res.status < 200 || res.status >= 300) return reject(host, `http ${res.status}`);
        let j;
        try { j = JSON.parse(await res.text()); } catch { return reject(host, 'not-json'); }
        const sources = j && j.stream && Array.isArray(j.stream.sources) ? j.stream.sources : [];
        const hlsSrc = sources.filter((x) => x && x.kind === 'hls');
        if (!hlsSrc.length) return reject(host, 'no-hls-source');
        for (const src of hlsSrc) {
            let master = typeof src.master === 'string' ? src.master : null;
            if (!master && typeof src.url === 'string') {
                try {
                    const m = await get(new URL(src.url, cand).href, { headers: { 'user-agent': titlePage.UA, referer: `${cand}/`, origin: cand } });
                    if (m.status >= 200 && m.status < 300) master = await m.text();
                } catch (e) { console.warn(`[heal] ${NAME} master fetch failed ${host}: ${e.message}`); }
            }
            if (master && master.includes('#EXT-X-MEDIA:TYPE=AUDIO')) {
                console.warn(`[heal] ${NAME} valid ${host}`);
                return true;
            }
            break; // one master GET per candidate
        }
        return reject(host, 'no-audio-master');
    }

    const bases = read('bases', DEFAULTS.bases);
    return { extra: bases.slice(1), trails: [titlePageTrail, scraperTrail], validate, onApplied, budget, state };
}

module.exports = {
    fromScraper, createRun, serverIds, MAX_GETS, MAX_VALIDATED, MAX_PATH_CHECKS,
    // Parsers live in titlePage.js (shared with vidrift); re-exported here.
    currentSite: titlePage.currentSite, titlePath: titlePage.titlePath,
    vidboltFromTitle: (html) => { const r = titlePage.vidboltFromTitle(html); return r ? r.origin : null; },
};
