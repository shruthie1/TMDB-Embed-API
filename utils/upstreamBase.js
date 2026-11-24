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
// State: in memory, mirrored to data/provider-heals.json (hosts and, since
// 2026-11-21, key/token/path fields; legacy data/provider-bases.json is read
// once when absent) so a heal survives a
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
        || path.join(__dirname, '..', 'data', 'provider-heals.json');
}
// Before 2026-11-21 only hosts were healed, in provider-bases.json. Read once
// when the heals file is absent.
function legacyPath() {
    return path.join(path.dirname(filePath()), 'provider-bases.json');
}

const strip = (u) => String(u || '').replace(/\/+$/, '');
const override = new AsyncLocalStorage();

let entries = null; // name -> { base, previous, how, seed, updatedAt, checkedAt }
let fieldHeals = {}; // name -> { field: { value, how, over, verifiedAt } }
const streak = new Map();
const lastSeed = new Map();
const running = new Map();
const lastRun = new Map();
const persistedCheck = new Map();
let defaultDeps = {}; // test seam: fetch, budgetMs, timeoutMs

const isBaseEntry = (v) => v && typeof v.base === 'string' && /^https?:\/\//.test(v.base);

function readFile(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw && typeof raw === 'object' ? raw : null;
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[upstream] ignoring ${file}: ${e.message}`);
        return null;
    }
}

function load() {
    if (entries) return entries;
    entries = {};
    fieldHeals = {};
    let raw = readFile(filePath());
    if (!raw && legacyPath() !== filePath()) {
        raw = readFile(legacyPath());
        // Review I4: a legacy host is held back (legacy: true) until it passes
        // the provider's validation on first use (verifyLegacy). Never served
        // before that, never sent to the APK.
        if (raw) {
            console.warn(`[upstream] heals legacy-import ${Object.keys(raw).length} from ${legacyPath()} (held until verified)`);
            for (const v of Object.values(raw)) if (isBaseEntry(v)) v.legacy = true;
        }
    }
    for (const [k, v] of Object.entries(raw || {})) {
        if (!v || typeof v !== 'object') continue;
        // Legacy shape: the entry itself carries `base`.
        if (isBaseEntry(v)) { entries[k] = v; continue; }
        if (isBaseEntry(v.base)) entries[k] = v.base;
        if (v.fields && typeof v.fields === 'object') fieldHeals[k] = { ...v.fields };
    }
    publish();
    return entries;
}

// The on-disk / config shape: { name: { base?, fields? } }.
function serialise() {
    const out = {};
    for (const [k, v] of Object.entries(entries || {})) out[k] = { base: v };
    for (const [k, f] of Object.entries(fieldHeals)) {
        if (!Object.keys(f).length) continue;
        out[k] = { ...(out[k] || {}), fields: f };
    }
    return out;
}

let warnedWrite = false;
function save() {
    const file = filePath();
    publish();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(serialise(), null, 2));
        fs.renameSync(tmp, file);
        warnedWrite = false;
        return true;
    } catch (e) {
        // In memory still holds the heal for this process. Warn once per streak.
        if (!warnedWrite) console.warn(`[upstream] could not write ${file}: ${e.message}`);
        warnedWrite = true;
        return false;
    }
}

// Every heal the config layer should see (lib/selfheal/config.js). A base is
// listed only while getBase() would serve it.
function allFields() {
    load();
    const out = {};
    for (const [k, e] of Object.entries(entries)) {
        const seed = lastSeed.get(k);
        if (e.legacy || !isFresh(e) || (e.seed && seed && e.seed !== seed)) continue;
        out[k] = { base: { ...e } };
    }
    for (const [k, f] of Object.entries(fieldHeals)) {
        const live = {};
        for (const [field, h] of Object.entries(f)) {
            if (fieldFresh(h)) live[field] = { ...JSON.parse(JSON.stringify(h)), expiresAt: Number(h.verifiedAt) + TTL_MS };
        }
        if (Object.keys(live).length) out[k] = { ...(out[k] || {}), fields: live };
    }
    return out;
}

function publish() {
    try { require('../lib/selfheal/config').setHeals(allFields()); } catch (e) {
        console.warn(`[upstream] heals publish failed: ${e.message}`);
    }
}

function currentRemote(name, field) {
    try {
        const v = require('../lib/selfheal/config').shared.remoteField(name, field);
        return v === undefined ? null : v;
    } catch { return null; }
}

/**
 * Record a verified non-host heal (key, token, path, list). `over` is the
 * remote value it replaces; it defaults to the current remote value, so a
 * later remote edit of the field drops this heal (lib/selfheal/config.js).
 * Returns true when written to disk; the value is live in memory either way.
 */
function setField(name, field, value, how, over) {
    load();
    fieldHeals[name] = fieldHeals[name] || {};
    fieldHeals[name][field] = {
        value, how: how || 'unknown',
        over: over === undefined ? currentRemote(name, field) : over,
        verifiedAt: Date.now(),
    };
    console.warn(`[upstream] heal-set ${name}.${field} via ${how || 'unknown'}`);
    return save();
}

// Review I2: a field heal lives TTL_MS (7 days) from its verification, the
// same TTL as a host heal. After that the remote or built-in value is used and
// a later heal run may verify the field again.
function fieldFresh(h, now = Date.now()) {
    return Boolean(h) && now - Number(h.verifiedAt || 0) < TTL_MS;
}

function getField(name, field) {
    load();
    const f = fieldHeals[name] && fieldHeals[name][field];
    return fieldFresh(f) ? { ...f } : null;
}

function dropField(name, field) {
    load();
    if (!fieldHeals[name] || !fieldHeals[name][field]) return false;
    delete fieldHeals[name][field];
    if (!Object.keys(fieldHeals[name]).length) delete fieldHeals[name];
    console.warn(`[upstream] heal-drop ${name}.${field}`);
    return save();
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
    if (e && e.base && !e.legacy && (!e.seed || e.seed === s) && isFresh(e)) return strip(e.base);
    return s;
}

/** True when name holds a legacy-imported host that is not yet verified. */
function legacyPending(name) {
    const e = load()[name];
    return Boolean(e && e.legacy);
}

/**
 * Review I4: check a legacy-imported host once with the provider's own
 * verify. Pass: the host becomes a normal heal. Fail: it is dropped.
 * Single-flight per provider; never throws.
 */
const legacyRuns = new Map();
function verifyLegacy(name, verify, budgetMs) {
    if (legacyRuns.has(name)) return legacyRuns.get(name);
    const e = load()[name];
    if (!e || !e.legacy) return Promise.resolve(null);
    const base = strip(e.base);
    const p = verifyCapped(verify, base, budgetMs || VERIFY_BUDGET_MS, { fetch: fetchImpl(defaultDeps), name })
        .then((r) => {
            const cur = load()[name];
            if (cur !== e) return null;
            if (r.ok) {
                delete e.legacy;
                e.checkedAt = Date.now();
                console.warn(`[upstream] heals legacy-adopt ${name} ${base}`);
                notifyHostApplied(name, base, lastSeed.get(name));
            } else {
                delete load()[name];
                console.warn(`[upstream] heals legacy-drop ${name} ${base}${r.timedOut ? ' (verify timed out)' : ''}`);
            }
            save();
            return r.ok;
        })
        .finally(() => legacyRuns.delete(name));
    legacyRuns.set(name, p);
    return p;
}

/** The base withBase() pinned for name in this async context, or null. */
function pinned(name) {
    const o = override.getStore();
    return o && o.name === name ? o.base : null;
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

// Listeners told when a provider's host changes (rediscover apply or a
// legacy host passing its verify). apiServer drops cached rows on the old
// host there: VM 2026-11-22 served 25 dead embed.vidrift.net rows after the
// heal had moved vidrift to .in.
const hostListeners = new Set();
/** fn(name, applied, previous). Returns an unsubscribe function. */
function onHostApplied(fn) {
    hostListeners.add(fn);
    return () => hostListeners.delete(fn);
}
function notifyHostApplied(name, applied, previous) {
    if (!previous || strip(previous) === strip(applied)) return;
    for (const fn of hostListeners) {
        try { fn(name, strip(applied), strip(previous)); } catch (err) { console.warn(`[heal] ${name} host listener failed: ${err.message}`); }
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
async function verifyCapped(verify, url, budgetMs, ctx) {
    const TIMED_OUT = Symbol('verify-timeout');
    let timer;
    const capped = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
        timer.unref?.();
    });
    const run = Promise.resolve().then(() => verify(url, ctx));
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
 * opts.extra          [url] config-listed hosts (how 'config'), after the seed
 * opts.trails         [async (ctx) => [{ url, how, from }]] run in order,
 *                     lazily: each only after every earlier candidate failed
 *                     verify. ctx = { fetch, name }.
 * opts.verify(url, ctx) REQUIRED to apply; truthy only on a real stream
 * opts.budget         lib/selfheal/proof.js createBudget(): when given, every
 *                     GET of this run (redirects, player scans, trails) spends
 *                     from it (review M6). ctx.fetch is the charged fetch.
 * opts.onApplied(url) called after a host is adopted (pending path heals
 *                     are saved there, only after the host passed; review I2)
 */
async function rediscover(name, opts = {}, callDeps = {}) {
    const deps = { ...defaultDeps, ...callDeps };
    if (opts.budget) {
        const charged = opts.budget.wrap(fetchImpl(deps));
        charged.charged = true;
        deps.fetch = charged;
    }
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
    for (const url of opts.extra || []) add(url, 'config', 'config');

    const trails = Array.isArray(opts.trails) ? opts.trails : [];
    if (!candidates.length && !trails.length) {
        console.warn(`[upstream] ${name}: no candidate host found from ${current}`);
        return { applied: null, previous: current, candidates };
    }
    if (candidates.length) console.warn(`[upstream] ${name}: candidates ${candidates.map((c) => `${c.url} (${c.how})`).join(', ')}`);
    if (typeof opts.verify !== 'function') return { applied: null, previous: current, candidates };

    const budget = deps.budgetMs || VERIFY_BUDGET_MS;
    const ctx = { fetch: fetchImpl(deps), name };
    const tryList = async (list) => {
        for (const c of list) {
            console.warn(`[heal] ${name} candidate ${c.url} via ${c.how}`);
            const r = await verifyCapped(opts.verify, c.url, budget, ctx);
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
            console.warn(`[heal] ${name} adopt ${c.url} via ${c.how}`);
            notifyHostApplied(name, c.url, current);
            if (typeof opts.onApplied === 'function') {
                try { await opts.onApplied(c.url); } catch (err) { console.warn(`[heal] ${name} onApplied failed: ${err.message}`); }
            }
            return c.url;
        }
        return null;
    };
    let applied = await tryList(candidates);
    for (let i = 0; !applied && i < trails.length; i++) {
        let found = [];
        try { found = (await trails[i](ctx)) || []; } catch (err) {
            console.warn(`[heal] ${name} trail ${i} failed: ${err.message}`);
        }
        const before = candidates.length;
        for (const c of found) add(c.url, c.how, c.from);
        applied = await tryList(candidates.slice(before));
    }
    if (!applied) {
        if (!candidates.length) console.warn(`[upstream] ${name}: no candidate host found from ${current}`);
        else console.warn(`[upstream] ${name}: no candidate passed verification`);
    }
    return { applied, previous: current, candidates };
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
    entries = null; fieldHeals = {}; defaultDeps = {}; warnedWrite = false;
    streak.clear(); lastSeed.clear(); running.clear(); lastRun.clear(); persistedCheck.clear(); legacyRuns.clear();
}

module.exports = {
    getBase, isHealed, withBase, pinned, noteOk, noteFail, failStreak, legacyPending, verifyLegacy,
    setField, getField, dropField, allFields,
    rediscover, triggerRediscover, pending, verifyCapped, onHostApplied,
    followRedirect, apiHostsFromPlayer, slugHostFromAggregator,
    FAIL_STREAK, TTL_MS, COOLDOWN_MS, VERIFY_BUDGET_MS, _reset, _setDeps,
};
