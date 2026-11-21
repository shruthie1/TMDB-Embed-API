'use strict';
// The MultiMovies title page names the live host of BOTH VidBolt (multimovies
// provider) and Vidrift: watchConfig.initialServers lists each server with its
// embed URL (measured 2026-11-21 on the saved Inception page: 6 servers,
// "Vidrift" https://embed.vidrift.net/embed/movie/27205, "Vidbolt"
// https://vidbolt.xyz/movie/27205).
//
// One run = 3 GETs: landing page (current site), search, title page. The
// parsed result is memoised for 30 min, so a heal of the other provider in that
// window makes no title-page GET. The memo only OFFERS hosts; each provider
// validates on its own before anything is adopted.
//
// Spec: docs/superpowers/specs/2026-11-21-provider-selfheal-design.md
// section 5, "multimovies (VidBolt) and vidrift: shared discovery chain".

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const MEMO_MS = 30 * 60 * 1000;
const PROBE_QUERY = 'inception';
const PROBE_TMDB = '27205';

/** Most frequent `https://<x>.multimovies.<tld>` origin on the page, or null. */
function currentSite(html) {
    const counts = new Map();
    for (const m of String(html || '').matchAll(/https?:\/\/[a-z0-9-]+\.multimovies\.[a-z]{2,}/gi)) {
        const o = m[0].toLowerCase();
        counts.set(o, (counts.get(o) || 0) + 1);
    }
    let best = null;
    for (const [o, n] of counts) if (!best || n > best[1]) best = [o, n];
    return best ? best[0] : null;
}

/** `/movie/inception-<n>` from the search page, or null. */
function titlePath(html) {
    const m = /href="(\/movie\/inception-\d+)"/i.exec(String(html || ''));
    return m ? m[1] : null;
}

// The object literal after `const watchConfig =`, by brace matching (strings
// respected). JSON only; never evaluated.
function watchConfig(html) {
    const s = String(html || '');
    const at = s.search(/const\s+watchConfig\s*=\s*\{/);
    if (at < 0) return null;
    const start = s.indexOf('{', at);
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
            try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
    }
    return null;
}

/** URL of the initialServers entry whose name matches nameRe, or null. */
function serverUrl(html, nameRe) {
    const wc = watchConfig(html);
    const list = wc && Array.isArray(wc.initialServers) ? wc.initialServers : [];
    const hit = list.find((x) => x && typeof x.name === 'string' && nameRe.test(x.name.trim()) && typeof x.url === 'string');
    return hit ? hit.url : null;
}

/**
 * `{ origin, path }` from a full embed URL, with the path segment equal to
 * tmdbId replaced by `{id}`. null when no segment equals the id (an IMDb id or
 * a hash gives no path template).
 */
function pathFromUrl(url, tmdbId) {
    let u;
    try { u = new URL(url); } catch { return null; }
    const segs = u.pathname.split('/');
    const i = segs.findIndex((x) => x === String(tmdbId));
    if (i < 0) return null;
    segs[i] = '{id}';
    return segs.join('/') + (u.search || '');
}

const originOf = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; } };

// VidBolt's server button, anchored on its label; used when watchConfig is
// missing. Never a host match on the string "vidbolt".
const VIDBOLT_BUTTON_RE = /<button[^>]*data-url="(https?:\/\/[^\/"]+)\/movie\/\d+"[^>]*>(?:(?!<\/button>)[\s\S])*?server-name">\s*vidbolt\s*</i;

/** { origin, url } of the server named "Vidbolt", or null. */
function vidboltFromTitle(html) {
    const url = serverUrl(html, /^vidbolt$/i);
    if (url && originOf(url)) return { origin: originOf(url), url };
    const m = VIDBOLT_BUTTON_RE.exec(String(html || ''));
    return m ? { origin: m[1], url: null } : null;
}

/** { origin, url } of the server named "Vidrift", or null. Name match only. */
function vidriftFromTitle(html) {
    const url = serverUrl(html, /^vidrift$/i);
    return url && originOf(url) ? { origin: originOf(url), url } : null;
}

function parse(html) {
    return { vidbolt: vidboltFromTitle(html), vidrift: vidriftFromTitle(html) };
}

// ---- shared memo and offers ----

let memo = null; // { vidbolt, vidrift, site, at }
const offers = new Map(); // provider -> Set(host)

function fresh(now = Date.now()) { return memo && now - memo.at < MEMO_MS ? memo : null; }

/**
 * Fetch (or reuse) the title page. ctx.fetch is a counted fetch; ctx.site the
 * MultiMovies site to start from. Returns { site, html, vidbolt, vidrift,
 * memo:bool } or null when the chain broke ({ failedAt }).
 */
async function read(ctx, site) {
    const m = fresh();
    if (m && m.html) {
        console.warn(`[heal] titlepage memo-hit site=${m.site}`);
        return { ...m, memo: true };
    }
    const get = async (url, referer) => {
        const res = await ctx.fetch(url, { headers: { 'user-agent': UA, ...(referer ? { referer } : {}) } });
        if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status} from ${url}`);
        return res.text();
    };
    const origin = String(site).replace(/\/+$/, '');
    let landing;
    try { landing = await get(`${origin}/`); } catch (e) {
        console.warn(`[heal] titlepage landing-failed ${origin}: ${e.message}`);
        return { failedAt: 'landing' };
    }
    const current = currentSite(landing) || origin;
    let search;
    try { search = await get(`${current}/search?q=${PROBE_QUERY}`, `${current}/`); } catch (e) {
        console.warn(`[heal] titlepage search-failed ${current}: ${e.message}`);
        return { failedAt: 'search' };
    }
    const p = titlePath(search);
    if (!p) {
        console.warn(`[heal] titlepage no-title-path ${current}`);
        return { failedAt: 'search' };
    }
    let html;
    try { html = await get(`${current}${p}`, `${current}/`); } catch (e) {
        console.warn(`[heal] titlepage title-failed ${current}${p}: ${e.message}`);
        return { failedAt: 'title' };
    }
    const parsed = parse(html);
    memo = { ...parsed, site: current, html, at: Date.now() };
    console.warn(`[heal] titlepage read site=${current} vidbolt=${(parsed.vidbolt && parsed.vidbolt.origin) || '-'} vidrift=${(parsed.vidrift && parsed.vidrift.origin) || '-'}`);
    return { ...memo, memo: false };
}

/** Offer `host` to `provider`'s next heal run as a titlepage candidate. */
function offer(provider, host) {
    if (!host) return;
    if (!offers.has(provider)) offers.set(provider, new Set());
    offers.get(provider).add(host);
    console.warn(`[heal] titlepage offer ${provider} ${host}`);
}

function takeOffers(provider) {
    const s = offers.get(provider);
    offers.delete(provider);
    return s ? [...s] : [];
}

function _reset() { memo = null; offers.clear(); }

module.exports = {
    currentSite, titlePath, watchConfig, serverUrl, pathFromUrl,
    vidboltFromTitle, vidriftFromTitle, parse, originOf,
    read, offer, takeOffers, fresh, _reset, MEMO_MS, PROBE_TMDB, UA,
};
