'use strict';
// Find where a provider moved, when it moves, without a code edit.
//
// Ported (the pattern, not the files) from ott/apps/resolver/src/discover.js
// and tierprobe.js. Both of ott's 2026-09-10 outages were domain rotations that
// left a trail a machine can follow:
//   mapple   mapple.uk answered 301 `Location: https://mapple.rip/`.
//   showsst  api.shows.st went 403, but its player (player.vidlove.cc) was up
//            and its JS bundle named api.vidlove.cc.
// A DNS-dead host answers nothing at all, so a third trail asks vidstreams.net,
// which still tracks where an embed slug points.
//
// A candidate is APPLIED only after `verify` carries a real mainstream title
// through the provider's own resolve on that host. Discovery alone is not
// evidence: in ott a single 301 from a dead host installed
// `totally-not-a-squatter.example` as the live base before verify existed.
//
// State: in memory, mirrored to data/provider-bases.json so a heal survives a
// restart. The file is optional. Missing file or dir = seeds only. The VM
// deploy (scripts/deploy-vm.sh) stages a copy of the live dir, so the file
// carries over; a fresh Docker image starts with seeds and heals again.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// ott tierprobe BROKEN_STREAK. A streak, never one empty: an empty answer is
// usually a real catalogue gap.
const FAIL_STREAK = Number(process.env.UPSTREAM_FAIL_STREAK) || 5;
// A healed base nobody has confirmed (a success or an apply) for this long
// falls back to the seed. It stays a candidate, so a still-good heal is
// re-verified and re-applied on the next rediscover.
const TTL_MS = Number(process.env.UPSTREAM_BASE_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
// One rediscover per provider per window. A laptop that lost its network
// fails every provider; it must not loop discovery.
const COOLDOWN_MS = Number(process.env.UPSTREAM_REDISCOVER_COOLDOWN_MS) || 30 * 60 * 1000;
// ott VERIFY_BUDGET_MS: a candidate that cannot answer inside a minute is not
// one we want as the live origin.
const VERIFY_BUDGET_MS = Number(process.env.UPSTREAM_VERIFY_BUDGET_MS) || 60000;
// Persist a success-refresh of checkedAt at most this often.
const CHECK_PERSIST_MS = 60 * 60 * 1000;

function filePath() {
    return process.env.UPSTREAM_BASES_FILE
        || path.join(__dirname, '..', 'data', 'provider-bases.json');
}

const strip = (u) => String(u || '').replace(/\/+$/, '');
const override = new AsyncLocalStorage();

let entries = null; // name -> { base, previous, how, seed, updatedAt, checkedAt }
const streak = new Map();
const lastSeed = new Map();
const running = new Map();
const lastRun = new Map();
const persistedCheck = new Map();
let defaultDeps = {}; // test seam: fetch, budgetMs, timeoutMs

function load() {
    if (entries) return entries;
    entries = {};
    try {
        const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
        if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw)) {
                if (v && typeof v.base === 'string' && /^https?:\/\//.test(v.base)) entries[k] = v;
            }
        }
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[upstream] ignoring ${filePath()}: ${e.message}`);
    }
    return entries;
}

function save() {
    const file = filePath();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        // In memory still holds the heal for this process.
        console.warn(`[upstream] could not write ${file}: ${e.message}`);
        return false;
    }
}

function isFresh(e, now = Date.now()) {
    return now - Number(e.checkedAt || e.updatedAt || 0) < TTL_MS;
}

/**
 * The base a provider should use for THIS call. Cheap; read it per call.
 *
 * Inside withBase() (a verify run) the candidate wins. Otherwise a healed
 * base wins while fresh and while the seed it replaced is still the seed: a
 * code or env change to the seed means a person chose a host, so theirs wins.
 */
function getBase(name, seed) {
    const s = strip(seed);
    lastSeed.set(name, s);
    const o = override.getStore();
    if (o && o.name === name) return o.base;
    const e = load()[name];
    if (e && e.base && (!e.seed || e.seed === s) && isFresh(e)) return strip(e.base);
    return s;
}

/** True when getBase(name) is currently serving a healed value. */
function isHealed(name, seed) {
    return getBase(name, seed) !== strip(seed);
}

/** Run fn with getBase(name) pinned to base. Used by verify only. */
function withBase(name, base, fn) {
    return override.run({ name, base: strip(base) }, fn);
}

function noteOk(name) {
    streak.set(name, 0);
    const e = load()[name];
    if (!e) return;
    const now = Date.now();
    e.checkedAt = now;
    if (now - (persistedCheck.get(name) || 0) > CHECK_PERSIST_MS) {
        persistedCheck.set(name, now);
        save();
    }
}

/** Returns the new streak. Crossing FAIL_STREAK is the caller's trigger. */
function noteFail(name) {
    const n = (streak.get(name) || 0) + 1;
    streak.set(name, n);
    return n;
}

function failStreak(name) { return streak.get(name) || 0; }

// ---- trails (ported from ott discover.js, CommonJS + node-fetch) ----

function fetchImpl(deps) {
    return deps.fetch || require('node-fetch');
}

/**
 * Where did this host redirect us to? Only a 3xx whose Location is on a
 * DIFFERENT host counts; a same-host redirect says nothing about a move.
 */
async function followRedirect(origin, deps = {}) {
    const f = fetchImpl(deps);
    const timeout = deps.timeoutMs || 10000;
    const once = async (method) => {
        const res = await f(origin, { method, redirect: 'manual', timeout, headers: { 'user-agent': UA } });
        if (method === 'GET') res.body?.resume?.();
        return res;
    };
    try {
        let res = await once('HEAD');
        // Some fronts reject HEAD; a GET still shows the redirect.
        if (res.status >= 400) res = await once('GET');
        const loc = res.headers.get('location');
        if (!loc || res.status < 300 || res.status >= 400) return null;
        const to = new URL(String(loc), origin);
        if (to.host === new URL(origin).host) return null;
        return `${to.protocol}//${to.host}`;
    } catch { return null; }
}

/**
 * Which api host does this front-end point at? Reads the page and up to 4
 * same-origin scripts (a hashed bundle is where api.vidlove.cc was found) and
 * returns `api.`/`api-` origins other than the player's own host.
 */
async function apiHostsFromPlayer(playerUrl, deps = {}) {
    const f = fetchImpl(deps);
    const timeout = deps.timeoutMs || 12000;
    const get = async (u) => {
        const res = await f(u, { timeout, headers: { 'user-agent': UA } });
        if (res.status !== 200) { res.body?.resume?.(); return ''; }
        return res.text();
    };
    try {
        const base = new URL(playerUrl);
        const html = await get(playerUrl);
        let text = html;
        const srcs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]).slice(0, 4);
        for (const src of srcs) {
            const u = new URL(src, base);
            if (u.host !== base.host) continue;
            text += await get(u.href).catch(() => '');
        }
        const found = new Set();
        for (const m of text.matchAll(/https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi)) {
            const host = new URL(m[0]).host;
            if (host === base.host) continue;
            if (/^api[.-]/i.test(host)) found.add(`https://${host}`);
        }
        return [...found];
    } catch { return []; }
}

/**
 * Where a DNS-dead provider moved, via vidstreams.net, which serves
 * `<iframe src>` for whichever host an embed slug currently points at.
 */
async function slugHostFromAggregator(slug, tmdbId, deps = {}) {
    const f = fetchImpl(deps);
    try {
        const res = await f(`https://vidstreams.net/external/asset/${slug}${tmdbId}/`,
            { timeout: deps.timeoutMs || 12000, headers: { 'user-agent': UA } });
        if (res.status !== 200) { res.body?.resume?.(); return null; }
        const m = (await res.text()).match(/<iframe[^>]+src="([^"]+)"/i);
        if (!m) return null;
        const u = new URL(m[1], 'https://vidstreams.net');
        return `${u.protocol}//${u.host}`;
    } catch { return null; }
}

// Races verify against a wall clock. A distinct sentinel, because false/null
// is also the ordinary "no stream here" answer (ott tierprobe verifyCandidate).
async function verifyCapped(verify, url, budgetMs) {
    const TIMED_OUT = Symbol('verify-timeout');
    let timer;
    const capped = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
        timer.unref?.();
    });
    const run = Promise.resolve().then(() => verify(url));
    run.catch(() => {});
    try {
        const r = await Promise.race([run, capped]);
        if (r === TIMED_OUT) return { ok: false, timedOut: true };
        return { ok: Boolean(r) };
    } catch {
        // A verifier that throws is a failure, never an accidental pass.
        return { ok: false };
    } finally { clearTimeout(timer); }
}

/**
 * Collect candidates from the trails, verify each in order, persist the first
 * that carries a real title. Returns { applied, previous, candidates }.
 *
 * opts.origin         host to read a redirect from (default: current base)
 * opts.player         front-end page to scan for an api host
 * opts.aggregatorSlug vidstreams.net slug, the last-resort trail
 * opts.verify(url)    REQUIRED to apply; truthy only on a real stream
 */
async function rediscover(name, opts = {}, callDeps = {}) {
    const deps = { ...defaultDeps, ...callDeps };
    const seed = lastSeed.get(name) || strip(opts.seed);
    const current = opts.origin ? strip(opts.origin) : getBase(name, seed);
    const e = load()[name];
    const seen = new Set([current]);
    const candidates = [];
    const add = (url, how, from) => {
        const u = strip(url);
        if (!u || seen.has(u)) return;
        seen.add(u);
        candidates.push({ url: u, how, from });
    };

    for (const origin of [current, seed]) {
        if (!origin) continue;
        const via = await followRedirect(origin, deps);
        if (via) add(via, 'redirect', origin);
    }
    const players = [];
    if (opts.player) {
        players.push(strip(opts.player));
        // The player itself may have moved too.
        const moved = await followRedirect(opts.player, deps);
        if (moved) players.push(moved);
    }
    for (const p of players) {
        for (const url of await apiHostsFromPlayer(p, deps)) add(url, 'player-bundle', p);
    }
    if (opts.aggregatorSlug) {
        const via = await slugHostFromAggregator(opts.aggregatorSlug, opts.probeTmdbId || 27205, deps);
        if (via) add(via, 'aggregator', 'vidstreams.net');
    }
    // A stale heal and the seed are candidates too: either may be the live one.
    if (e && e.base) add(e.base, 'previous-heal', 'data');
    if (seed && seed !== current) add(seed, 'seed', 'code');

    if (!candidates.length) {
        console.warn(`[upstream] ${name}: no candidate host found from ${current}`);
        return { applied: null, previous: current, candidates };
    }
    console.warn(`[upstream] ${name}: candidates ${candidates.map((c) => `${c.url} (${c.how})`).join(', ')}`);
    if (typeof opts.verify !== 'function') return { applied: null, previous: current, candidates };

    const budget = deps.budgetMs || VERIFY_BUDGET_MS;
    for (const c of candidates) {
        const r = await verifyCapped(opts.verify, c.url, budget);
        if (!r.ok) {
            console.warn(`[upstream] ${name}: rejected ${c.url} (${c.how}${r.timedOut ? ', verify timed out' : ''})`);
            continue;
        }
        const now = Date.now();
        if (c.url === seed) {
            delete load()[name];
        } else {
            load()[name] = { base: c.url, previous: current, how: c.how, seed, updatedAt: now, checkedAt: now };
        }
        save();
        streak.set(name, 0);
        // `previous` is logged so a bad apply can be undone from the log alone.
        console.warn(`[upstream] ${name}: applied ${c.url} (previous ${current}, via ${c.how})`);
        return { applied: c.url, previous: current, candidates };
    }
    console.warn(`[upstream] ${name}: no candidate passed verification`);
    return { applied: null, previous: current, candidates };
}

/**
 * Fire-and-forget entry for the request path. Single-flight and rate-limited
 * per provider; never throws, never blocks the caller.
 */
function triggerRediscover(name, opts, deps) {
    if (running.has(name)) return running.get(name);
    const now = Date.now();
    if (now - (lastRun.get(name) || 0) < COOLDOWN_MS) return null;
    lastRun.set(name, now);
    const p = rediscover(name, opts, deps)
        .catch((err) => { console.warn(`[upstream] ${name}: rediscover failed: ${err.message}`); return null; })
        .finally(() => running.delete(name));
    running.set(name, p);
    return p;
}

/** The in-flight rediscover for name, or null. */
function pending(name) { return running.get(name) || null; }

/** Test seam: default deps for background rediscovers (fetch, budgetMs). */
function _setDeps(deps) { defaultDeps = deps || {}; }

/** Test seam: drop all in-memory state; the file is re-read on next use. */
function _reset() {
    entries = null; defaultDeps = {};
    streak.clear(); lastSeed.clear(); running.clear(); lastRun.clear(); persistedCheck.clear();
}

module.exports = {
    getBase, isHealed, withBase, noteOk, noteFail, failStreak,
    rediscover, triggerRediscover, pending, verifyCapped,
    followRedirect, apiHostsFromPlayer, slugHostFromAggregator,
    FAIL_STREAK, TTL_MS, COOLDOWN_MS, VERIFY_BUDGET_MS, _reset, _setDeps,
};
