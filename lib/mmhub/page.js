'use strict';
// MultiMovies hub: which servers MultiMovies lists for one title.
//
// Measured 2026-11-24 (multimovies-servers.md): the title page carries
// `const watchConfig = {"initialServers":[{name,url},...]}` as static JSON;
// RRR and Pushpa 2 list 6 servers (Cineverse, GD mirror, Nexus, Vidrift,
// VIDOUT, Vidbolt). Every server URL embeds the TMDB or IMDb id, so a search
// hit is accepted only when its page's server URLs name OUR id. No page that
// proves the id = unknown (null), never a near-title guess.
//
// The site host is a FIXED configured value (resolve-config mmhub.site).
// Owner scope 2026-11-24: no domain following. Redirects are not followed; a
// 3xx, 403/429/5xx or network error marks the host down on /api/health and
// logs `[mm] site down <host> <reason>`.
//
// Patterns (watchConfig locators, server-list paths, search-link regexes,
// server -> extractor map) are read from resolve-config `mmhub` at call time,
// with the code DEFAULTS below as the fallback, tried in order. When no
// pattern parses a page, a redacted sample is written under data/mm-samples/
// and `[mm] parse failed <what> sample=<file>` is logged.
//
// Cache: TMDB id -> title path 7 d; server list 6 h (both in memory).

const fs = require('fs');
const path = require('path');
const state = require('./state');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const STEP_TIMEOUT_MS = 8000;
// "Not listed" is kept 30 min, like the other negative caches. 6 h hid a
// title for 6 h after one spelling or id-proof miss (audit 2026-11-25 #11).
const NEG_TTL_MS = 30 * 60 * 1000;
const SAMPLE_EVERY_MS = 3600 * 1000;
const MAX_SAMPLES = 20;

const DEFAULTS = {
    site: 'https://m1.multimovies.courses',
    searchPath: '/search?q={q}',
  jsonSearchPath: '/api/search?q={q}&limit=20',
    episodePath: '/season/{s}/episode/{e}',
    titleLinkPatterns: [
        'href="(/(?:movie|series)/[a-z0-9][a-z0-9-]*-\\d+)"',
        "href='(/(?:movie|series)/[a-z0-9][a-z0-9-]*-\\d+)'",
    ],
    watchConfigPatterns: [
        'const\\s+watchConfig\\s*=\\s*\\{',
        '(?:var|let|window\\.)\\s*watchConfig\\s*=\\s*\\{',
        'watchConfig\\s*[=:]\\s*\\{',
    ],
    serverListPaths: ['initialServers', 'servers', 'sources'],
    servers: [
        { name: '^vidbolt$', hosts: ['vidbolt.xyz', 'vidbolt.pro'], extractor: 'multimovies' },
        { name: '^vidrift$', hosts: ['embed.vidrift.net', 'embed.vidrift.in'], extractor: 'vidrift' },
        { name: '^vidout$', hosts: ['vidout.pages.dev'], extractor: 'vidout' },
        { name: '^gd mirror$', hosts: ['streams.iqsmartgames.com'], extractor: 'gdmirror' },
        { name: '^cineverse$', hosts: ['rozgarlelo.modiplay.xyz'], extractor: 'cineverse' },
        { name: '^nexus$', hosts: ['www.moviesnexus.fun', 'moviesnexus.fun'], extractor: 'nexus' },
    ],
    titleTtlSec: 7 * 24 * 3600,
    serversTtlSec: 6 * 3600,
    maxCandidates: 3,
};

function liveCfg() {
    let sh = null;
    try { sh = require('../selfheal/config'); } catch { /* tests without config */ }
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = sh ? sh.cfg('mmhub', k, DEFAULTS[k]) : DEFAULTS[k];
    return out;
}

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };
const strip = (u) => String(u || '').replace(/\/+$/, '');
function safeRe(src, flags = '') { try { return new RegExp(src, flags); } catch { return null; } }

// The JSON object starting at `start` (a '{'), by brace matching with strings
// respected. JSON only; never evaluated.
function objectAt(s, start) {
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

function pick(obj, dotted) {
    return String(dotted).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** { servers:[{name,url}], pattern } from the first pattern that parses, or null. */
function parseServers(html, cfg = DEFAULTS) {
    const s = String(html || '');
    const pats = Array.isArray(cfg.watchConfigPatterns) ? cfg.watchConfigPatterns : DEFAULTS.watchConfigPatterns;
    const paths = Array.isArray(cfg.serverListPaths) ? cfg.serverListPaths : DEFAULTS.serverListPaths;
    for (let i = 0; i < pats.length; i++) {
        const re = safeRe(pats[i]);
        if (!re) continue;
        const m = re.exec(s);
        if (!m) continue;
        const brace = s.indexOf('{', m.index + m[0].length - 1);
        if (brace < 0) continue;
        const obj = objectAt(s, brace);
        if (!obj) continue;
        for (const p of paths) {
            const list = pick(obj, p);
            if (!Array.isArray(list)) continue;
            const servers = list.filter((x) => x && typeof x.name === 'string' && typeof x.url === 'string')
                .map((x) => ({ name: x.name.trim(), url: x.url }));
            if (servers.length) return { servers, pattern: i, config: obj };
        }
    }
    return null;
}

/** { name, url, host, known, extractor } for one listed server. */
function classifyServer(srv, cfg = DEFAULTS) {
    const host = hostOf(srv.url);
    const list = Array.isArray(cfg.servers) ? cfg.servers : DEFAULTS.servers;
    const byHost = list.find((e) => e && Array.isArray(e.hosts) && e.hosts.map((h) => String(h).toLowerCase()).includes(host));
    let hit = byHost;
    if (!hit) hit = list.find((e) => e && e.name && (safeRe(e.name, 'i') || { test: () => false }).test(srv.name));
    return { name: srv.name, url: srv.url, host, known: Boolean(byHost), extractor: hit ? (hit.extractor || null) : null };
}

function slugify(t) {
    return String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Title paths from a search page, best candidates first. */
function searchCandidates(html, title, type, cfg = DEFAULTS) {
    const want = type === 'movie' ? '/movie/' : '/series/';
    const pats = Array.isArray(cfg.titleLinkPatterns) ? cfg.titleLinkPatterns : DEFAULTS.titleLinkPatterns;
    const seen = new Set();
    for (const src of pats) {
        const re = safeRe(src, 'gi');
        if (!re) continue;
        for (const m of String(html || '').matchAll(re)) if (m[1] && m[1].startsWith(want)) seen.add(m[1]);
        if (seen.size) break;
    }
    const slug = slugify(title);
    const slugOf = (p) => p.split('/')[2].replace(/-\d+$/, '');
    const rank = (p) => (slugOf(p) === slug ? 0 : slugOf(p).startsWith(`${slug}-`) ? 1 : 2);
    return [...seen].sort((a, b) => rank(a) - rank(b));
}

/** True when a server URL names this TMDB id (path segment or id= value) or IMDb id. */
function provesId(servers, tmdbId, imdbId) {
    const id = String(tmdbId);
    return servers.some((s) => {
        let u;
        try { u = new URL(s.url); } catch { return false; }
        if (u.pathname.split('/').includes(id)) return true;
        for (const v of u.searchParams.values()) if (v === id) return true;
        return Boolean(imdbId) && u.pathname.split('/').includes(String(imdbId));
    });
}

// ---- redacted samples ----

/** Query strings and long token-like runs removed. */
function redact(text) {
    return String(text || '')
        .replace(/(https?:\\?\/\\?\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, '$1?REDACTED')
        .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, 'REDACTED');
}

const lastSample = new Map();
function saveSample(what, text, deps) {
    const now = Date.now();
    if (now - (lastSample.get(what) || 0) < SAMPLE_EVERY_MS) return null;
    lastSample.set(what, now);
    // Under `node --test` a caller without its own dir writes to the OS temp
    // dir, never to the repo's data/ (utils/store.js has the same rule).
    const dir = deps.sampleDir || (process.env.NODE_TEST_CONTEXT
        ? path.join(require('os').tmpdir(), 'mm-samples-test')
        : path.join(__dirname, '..', '..', 'data', 'mm-samples'));
    try {
        fs.mkdirSync(dir, { recursive: true });
        const name = `${what.replace(/[^a-z0-9_-]/gi, '_')}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.html`;
        fs.writeFileSync(path.join(dir, name), redact(text).slice(0, 200000));
        const files = fs.readdirSync(dir).sort();
        for (const f of files.slice(0, Math.max(0, files.length - MAX_SAMPLES))) fs.unlinkSync(path.join(dir, f));
        return name;
    } catch (e) {
        console.warn(`[mm] sample write failed: ${e.message}`);
        return null;
    }
}

/** Callers outside this module (extractors) report a total parse failure here. */
function parseFailed(what, text, deps = {}) {
    const log = deps.log || ((l) => console.warn(l));
    const file = saveSample(what, text, deps);
    log(`[mm] parse failed ${what} sample=${file || 'skipped'}`);
    return file;
}

// ---- caches and the read ----

const titleCache = new Map(); // `${type}:${tmdbId}` -> { path|null, at }
const serverCache = new Map();
const inflight = new Map();
function abortError(signal) { return signal?.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' }); }
function ensureActive(signal) { if (signal?.aborted) throw abortError(signal); }
function cappedSet(map, key, value) {
  map.delete(key); map.set(key, value);
  if (map.size > 1000) map.delete(map.keys().next().value);
}
function namespace(cfg, site) { return JSON.stringify([site, cfg.searchPath, cfg.jsonSearchPath, cfg.episodePath, cfg.titleLinkPatterns, cfg.watchConfigPatterns, cfg.serverListPaths, cfg.servers]); }
function jsonCandidates(text, type) {
  let json; try { json = JSON.parse(text); } catch { return null; }
  const values = Array.isArray(json) ? json : Array.isArray(json?.results) ? json.results : null;
  if (!values) return null;
  const prefix = type === 'movie' ? '/movie/' : '/series/';
  return [...new Set(values.map(row => row && row.url).filter(url => typeof url === 'string' && url.startsWith(prefix) && /^\/(?:movie|series)\/[a-z0-9][a-z0-9-]*-\d+$/i.test(url)))];
} // `${type}:${tmdbId}:${s}:${e}` -> { result, at }

// The site answered and no page proved the id: the title is not listed.
// Distinct from null (site down / no TMDB name), which stays "unknown".
function notListed(site) { return { site, path: null, pattern: null, servers: [], notListed: true }; }

// MultiMovies search matches on word prefixes of its own title, so a full
// TMDB title with a subtitle ("Pushpa 2 - The Rule") can return 0 rows while
// the part before the separator ("Pushpa 2") finds it. Full title first.
function searchQueries(name) {
    const clean = (t) => t.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const out = [clean(name)];
    const head = clean(String(name).split(/\s+[-\u2013\u2014|]\s+|:\s*/)[0] || '');
    if (head && head !== out[0]) out.push(head);
    return out.filter(Boolean);
}

function _reset() { titleCache.clear(); serverCache.clear(); lastSample.clear(); }

class SiteError extends Error {}

async function get(deps, url) {
    const f = deps.fetch || globalThis.fetch;
    let res;
    try {
        res = await f(url, { redirect: 'manual', headers: { 'user-agent': UA },
            signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)]) : AbortSignal.timeout(STEP_TIMEOUT_MS) });
    } catch (e) {
        throw new SiteError(String(e && e.message || e).slice(0, 80));
    }
    ensureActive(deps.signal);
  if (res.status >= 200 && res.status < 300) {
    const text = await res.text();
    ensureActive(deps.signal);
    return text;
  }
    if (res.status === 404 || res.status === 410) return null;
    throw new SiteError(`HTTP ${res.status}`);
}

/**
 * The servers MultiMovies lists for one title, or null (unknown).
 * title: { tmdbId, type: 'movie'|'series'|'tv', season, episode, imdbId? }
 * deps (tests): fetch, now(), site, details(type, id) -> {title,year}, log, sampleDir, cfg
 */
async function readOnce(title, deps = {}) {
    const cfg = deps.cfg || liveCfg();
    const now = deps.now || Date.now;
    const log = deps.log || ((l) => console.warn(l));
    const site = strip(deps.site || cfg.site);
    const host = hostOf(site);
    if (deps.observe !== false) state.setHost(host);
    const type = title.type === 'movie' ? 'movie' : 'series';
    const s = type === 'series' ? Number(title.season) || 1 : 0;
    const e = type === 'series' ? Number(title.episode) || 1 : 0;
    const tk = `${namespace(cfg, site)}|${type}:${title.tmdbId}:${title.imdbId || ''}`;
    const sk = `${tk}:${s}:${e}`;
    const sc = serverCache.get(sk);
    // A notListed (or no-title) answer lives NEG_TTL_MS, not the 6 h server-list TTL.
    const scTtl = Number(cfg.serversTtlSec) * 1000;
    if (sc && now() - sc.at < (sc.result && !sc.result.notListed ? scTtl : Math.min(scTtl, NEG_TTL_MS))) return sc.result;

    const pagePath = (p) => (type === 'series'
        ? p + String(cfg.episodePath).replace('{s}', s).replace('{e}', e) : p);
    const finish = (result) => {
        ensureActive(deps.signal);
    cappedSet(serverCache, sk, { result, at: now() });
        if (result) {
            for (const srv of result.servers) {
                if (deps.observe !== false && !srv.known && state.unknownServer(srv.host)) log(`[mm] unknown server ${srv.host}`);
            }
        }
        return result;
    };
    const accept = (p, parsed) => {
        if (deps.observe !== false) state.siteOk(host, now());
        return finish({ site, path: pagePath(p), pattern: parsed.pattern,
            servers: parsed.servers.map((x) => classifyServer(x, cfg)) });
    };

    try {
        // Cached mapping: one title-page GET.
        const tc = titleCache.get(tk);
        if (tc && now() - tc.at < (tc.path ? Number(cfg.titleTtlSec) * 1000 : NEG_TTL_MS)) {
            if (!tc.path) return finish(notListed(site));
            const html = await get(deps, site + pagePath(tc.path));
            const parsed = html ? parseServers(html, cfg) : null;
            if (parsed && provesId(parsed.servers, title.tmdbId, title.imdbId)) return accept(tc.path, parsed);
            if (html && !parsed) parseFailed('watchConfig', html, { ...deps, log });
            titleCache.delete(tk);
        }
        const details = deps.details || (async (t, id) => require('../../utils/tmdb').getDetails(t, id));
        const d = await details(type === 'movie' ? 'movie' : 'tv', title.tmdbId);
        const name = d && (d.title || d.name);
        if (!name) return finish(null);
        ensureActive(deps.signal);
        const tried = new Set();
        for (const query of searchQueries(name)) {
            ensureActive(deps.signal);
            const q = encodeURIComponent(query);
            let candidates = null;
            if (cfg.jsonSearchPath) {
                const reply = await get(deps, site + String(cfg.jsonSearchPath).replace('{q}', q));
                if (reply) candidates = jsonCandidates(reply, type);
            }
            if (candidates == null) {
                const search = await get(deps, site + String(cfg.searchPath).replace('{q}', q));
                candidates = searchCandidates(search || '', name, type, cfg);
            }
            const cands = candidates.filter((p) => !tried.has(p)).slice(0, Number(cfg.maxCandidates) || 3);
            for (const p of cands) {
                tried.add(p);
                const html = await get(deps, site + pagePath(p));
                if (!html) continue;
                const parsed = parseServers(html, cfg);
                if (!parsed) { parseFailed('watchConfig', html, { ...deps, log }); continue; }
                if (!provesId(parsed.servers, title.tmdbId, title.imdbId)) continue;
                cappedSet(titleCache, tk, { path: p, at: now() });
                return accept(p, parsed);
            }
        }
        cappedSet(titleCache, tk, { path: null, at: now() });
        return finish(notListed(site));
    } catch (err) {
        if (err instanceof SiteError) {
            if (deps.observe !== false) state.siteDown(host, err.message, now());
            log(`[mm] site down ${host} ${err.message}`);
            return null; // not cached: the next call tries again
        }
        throw err;
    }
}

async function read(title, deps = {}) {
  ensureActive(deps.signal);
  const cfg = structuredClone(deps.cfg || liveCfg());
  const site = strip(deps.site || cfg.site);
  const key = JSON.stringify([namespace(cfg, site), title, deps.observe !== false]);
  let job = inflight.get(key);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    job = { controller, users: 0, promise: null };
    const own = job;
    job.promise = Promise.resolve().then(() => readOnce(title, { ...deps, cfg, site, signal: controller.signal }))
      .finally(() => { if (inflight.get(key) === own) inflight.delete(key); });
    inflight.set(key, job);
  }
  job.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return; settled = true;
      deps.signal?.removeEventListener('abort', cancel);
      job.users--;
      if (!job.users) job.controller.abort();
      fn(value);
    };
    const cancel = () => done(reject, abortError(deps.signal));
    deps.signal?.addEventListener('abort', cancel, { once: true });
    job.promise.then(value => done(resolve, value), error => done(reject, error));
    if (deps.signal?.aborted) cancel();
  });
}

module.exports = {
    read, jsonCandidates, searchQueries, parseServers, classifyServer, searchCandidates, provesId, redact, parseFailed, slugify,
    liveCfg, DEFAULTS, _reset,
};
