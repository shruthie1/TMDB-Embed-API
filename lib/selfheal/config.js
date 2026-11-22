'use strict';
// Provider config in three layers, merged per read:
//
//   built-in  routes/resolve-config.json (repo)
//     < remote  RESOLVE_CONFIG_URL (fetched; last good kept in data/)
//     < heals   data/provider-heals.json (machine-written, verified only)
//
// Providers read through cfg(provider, field, fallback) at call time, so a
// refresh needs no restart. Today's constants are the `fallback`: with no
// remote and no heal every provider behaves exactly as before.
//
// A heal records the remote value it replaced (`over`). When the remote value
// of that field changes, the heal is dropped: a human edit wins over an old
// heal. A value of the wrong type (compared to the fallback) falls to the
// layer below, the same rule ResolveConfig.kt uses.
//
// No timer here; the caller schedules refresh(). Spec:
// docs/superpowers/specs/2026-11-21-provider-selfheal-design.md section 1.

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 4000;
const DEFAULT_TTL_SEC = 21600;
// The provider field a healed base (utils/upstreamBase.js) goes in front of.
const BASE_FIELD = { vaplayer: 'wrapperBases' };
// Review I4: /api/resolve-config serves a heal only for a provider the APK
// resolves on the device, and only its host list. Never mapple (owner rule:
// no server-side heal for mapple). Keys and paths stay on the server.
const SERVED_HOST_HEALS = new Set(['castletv', 'multimovies', 'onetouchtv', 'vaplayer', 'vidrift']);
// Review M5: remote host lists are https only and short. netmirror.domains
// may not grow past the built-in count (CLAUDE.md #5: no newtv sweeps).
const MAX_LIST = 10;
const GROW_CAPPED = { netmirror: ['domains'] };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function kindOf(v) {
    if (v === null || v === undefined) return 'none';
    if (Array.isArray(v)) {
        if (v.length && v.every((x) => typeof x === 'string')) return 'string[]';
        return 'array';
    }
    return typeof v; // string | number | boolean | object
}

// True when v may stand in for fallback. A fallback list of strings needs a
// non-empty list of strings; an empty fallback list takes any array.
function typeOk(v, fallback) {
    if (v === null || v === undefined) return false;
    if (fallback === undefined || fallback === null) return true;
    const fk = kindOf(fallback);
    const vk = kindOf(v);
    if (fk === 'string[]') return vk === 'string[]';
    if (fk === 'array') return Array.isArray(v);
    if (fk === 'object') return isObj(v);
    return fk === vk;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[selfheal-config] unreadable ${file}: ${e.message}`);
        return null;
    }
}

function writeAtomic(file, obj) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        console.warn(`[selfheal-config] could not write ${file}: ${e.message}`);
        return false;
    }
}

const looksUrl = (x) => typeof x === 'string' && /^[a-z]+:\/\//i.test(x);
const httpsOnly = (x) => {
    if (looksUrl(x)) return /^https:\/\//i.test(x);
    if (isObj(x)) return Object.values(x).every((v) => !looksUrl(v) || /^https:\/\//i.test(v));
    return true;
};
const hasUrl = (x) => looksUrl(x) || (isObj(x) && Object.values(x).some(looksUrl));

/**
 * Trim every host list in a remote doc: https entries only, at most MAX_LIST
 * (GROW_CAPPED lists: at most the built-in count). Logs `remote trim`.
 */
function sanitizeRemote(d, builtin) {
    for (const [provider, sec] of Object.entries(d)) {
        if (!isObj(sec)) continue;
        for (const [field, list] of Object.entries(sec)) {
            if (!Array.isArray(list) || !list.some(hasUrl)) continue;
            const b = isObj(builtin) && isObj(builtin[provider]) ? builtin[provider][field] : null;
            const cap = (GROW_CAPPED[provider] || []).includes(field)
                ? (Array.isArray(b) ? b.length : MAX_LIST)
                : MAX_LIST;
            const kept = list.filter(httpsOnly).slice(0, cap);
            if (kept.length !== list.length) {
                console.warn(`[selfheal-config] remote trim ${provider}.${field} ${list.length}->${kept.length} (https only, cap ${cap})`);
                sec[field] = kept;
            }
        }
    }
    return d;
}

/**
 * builtin  object, or a path read on each snapshot/cfg (mtime-cached)
 * url      remote JSON; null/empty = no fetch
 * fetch    fetch(url, { signal }) -> { ok, status, text() }
 * file     last good remote copy on disk
 * onDropHeal(provider, field)  called when a remote edit drops a heal
 */
function createConfig({ builtin, url = null, fetch: fetchFn, file = null, onDropHeal = null, timeoutMs = TIMEOUT_MS } = {}) {
    let remote = null; // last good remote doc
    let fileTried = false;
    let heals = {};
    const warnedType = new Set();
    let builtinCache = { mtimeMs: -1, doc: {} };

    // cfg() falls back to the code constants on a broken built-in file;
    // snapshot() throws so /api/resolve-config answers 500 (review M3).
    function builtinDoc(strict = false) {
        if (isObj(builtin)) return builtin;
        if (typeof builtin !== 'string') return {};
        try {
            const st = fs.statSync(builtin);
            if (st.mtimeMs !== builtinCache.mtimeMs) {
                const doc = readJson(builtin);
                builtinCache = { mtimeMs: st.mtimeMs, doc: isObj(doc) ? doc : {}, bad: !isObj(doc) };
                if (!isObj(doc)) console.warn(`[selfheal-config] built-in unreadable ${builtin}`);
            }
        } catch (e) {
            if (builtinCache.mtimeMs === -1) console.warn(`[selfheal-config] built-in missing ${builtin}: ${e.message}`);
            builtinCache = { mtimeMs: -2, doc: {}, bad: true };
        }
        if (strict && builtinCache.bad) throw new Error(`built-in config unreadable: ${builtin}`);
        return builtinCache.doc;
    }

    // Review M1: the last good copy counts only while a remote URL is set. A
    // stale file in data/ never changes a "no remote" deploy.
    function loadLastGood() {
        if (fileTried || !file || !url) return;
        fileTried = true;
        const d = readJson(file);
        if (isObj(d) && !remote) {
            remote = sanitizeRemote(d, builtinDoc());
            console.log(`[selfheal-config] last-good loaded version ${d.version} from ${file}`);
        }
    }

    async function refresh() {
        loadLastGood();
        if (!url) return { ok: false, why: 'no-url' };
        const f = fetchFn || globalThis.fetch;
        let res;
        try {
            res = await f(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
        } catch (e) {
            console.warn(`[selfheal-config] remote keep-last-good fetch ${e.message}`);
            return { ok: false, why: 'fetch' };
        }
        if (!res.ok) {
            console.warn(`[selfheal-config] remote keep-last-good http ${res.status}`);
            return { ok: false, why: 'http' };
        }
        let d;
        try { d = JSON.parse(await res.text()); } catch (e) {
            console.warn(`[selfheal-config] remote keep-last-good parse ${e.message}`);
            return { ok: false, why: 'parse' };
        }
        if (!isObj(d)) {
            console.warn('[selfheal-config] remote keep-last-good parse not an object');
            return { ok: false, why: 'parse' };
        }
        const v = Number(d.version) || 0;
        const last = remote ? Number(remote.version) || 0 : 0;
        if (remote && v < last) {
            console.warn(`[selfheal-config] remote keep-last-good older version ${v} < ${last}`);
            return { ok: false, why: 'older' };
        }
        remote = sanitizeRemote(d, builtinDoc());
        if (file) writeAtomic(file, remote);
        console.log(`[selfheal-config] remote ok version ${v}`);
        return { ok: true };
    }

    function remoteField(provider, field) {
        return remote && isObj(remote[provider]) ? remote[provider][field] : undefined;
    }

    // The heal for provider.field, or undefined. Drops it when the remote
    // value it replaced has changed since.
    function healField(provider, field) {
        const h = heals[provider] && heals[provider].fields && heals[provider].fields[field];
        if (!h) return undefined;
        // Review I2: a field heal expires with its TTL (upstreamBase TTL_MS).
        if (h.expiresAt && Date.now() >= Number(h.expiresAt)) return undefined;
        // Review M2: only a loaded remote doc can drop a heal. A missing or
        // failed remote keeps it.
        if (remote !== null && !same(h.over, remoteField(provider, field))) {
            delete heals[provider].fields[field];
            console.warn(`[selfheal-config] drop-heal ${provider}.${field} (remote changed)`);
            if (onDropHeal) { try { onDropHeal(provider, field); } catch { /* store logs its own */ } }
            return undefined;
        }
        return h;
    }

    function pick(layer, provider, field, v, fallback) {
        if (v === undefined || v === null) return undefined;
        if (typeOk(v, fallback)) return v;
        const k = `${layer}:${provider}.${field}`;
        if (!warnedType.has(k)) {
            warnedType.add(k);
            console.warn(`[selfheal-config] skip-type ${layer} ${provider}.${field} (${kindOf(v)}, want ${kindOf(fallback)})`);
        }
        return undefined;
    }

    function cfg(provider, field, fallback) {
        loadLastGood();
        const h = healField(provider, field);
        let v = pick('heal', provider, field, h && h.value, fallback);
        if (v !== undefined) return v;
        v = pick('remote', provider, field, remoteField(provider, field), fallback);
        if (v !== undefined) return v;
        const b = builtinDoc();
        v = pick('builtin', provider, field, isObj(b[provider]) ? b[provider][field] : undefined, fallback);
        if (v !== undefined) return v;
        return fallback;
    }

    function snapshot() {
        loadLastGood();
        const b = builtinDoc(true);
        const out = JSON.parse(JSON.stringify(b || {}));
        for (const [k, v] of Object.entries(remote || {})) {
            if (isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
            else out[k] = JSON.parse(JSON.stringify(v));
        }
        for (const provider of Object.keys(heals)) {
            if (!SERVED_HOST_HEALS.has(provider)) continue;
            const entry = heals[provider] || {};
            const hostField = BASE_FIELD[provider] || 'bases';
            const h = healField(provider, hostField);
            if (h) {
                out[provider] = isObj(out[provider]) ? out[provider] : {};
                out[provider][hostField] = h.value;
            }
            const base = entry.base && !entry.base.legacy && entry.base.base;
            if (typeof base === 'string' && base) {
                const f = BASE_FIELD[provider] || 'bases';
                out[provider] = isObj(out[provider]) ? out[provider] : {};
                const list = Array.isArray(out[provider][f]) ? out[provider][f] : [];
                if (list.every((x) => typeof x === 'string')) {
                    out[provider][f] = [base, ...list.filter((x) => x.replace(/\/+$/, '') !== base)];
                }
            }
        }
        // prewarm.md: `<provider>.prewarm` (details-page on-device resolve in the APK)
        // passes through from built-in/remote as a boolean only; anything else is
        // dropped, which the APK reads as false. Heals never set it.
        for (const sec of Object.values(out)) {
            if (isObj(sec) && 'prewarm' in sec && typeof sec.prewarm !== 'boolean') delete sec.prewarm;
        }
        return out;
    }

    function setHeals(map) { heals = isObj(map) ? JSON.parse(JSON.stringify(map)) : {}; }

    function ttlMs() {
        const t = Number((remote && remote.ttlSec) || builtinDoc().ttlSec) || DEFAULT_TTL_SEC;
        return Math.max(60, t) * 1000;
    }

    // Test seam: install a remote doc as if fetched (null clears it).
    function _setRemote(d) { remote = isObj(d) ? d : null; fileTried = true; }

    return { cfg, snapshot, refresh, setHeals, ttlMs, remoteField, _setRemote };
}

// Module default instance: the repo built-in file, RESOLVE_CONFIG_URL, and
// the last good copy in data/.
const DEFAULT_BUILTIN = path.join(__dirname, '..', '..', 'routes', 'resolve-config.json');
const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'resolve-config.remote.json');
const shared = createConfig({
    builtin: DEFAULT_BUILTIN,
    url: process.env.RESOLVE_CONFIG_URL || null,
    file: process.env.RESOLVE_CONFIG_FILE || DEFAULT_FILE,
    onDropHeal: (p, f) => { try { require('../../utils/upstreamBase').dropField(p, f); } catch { /* not wired */ } },
});

let timer = null;
// Fetch now and every ttlSec. unref'd: never holds the process open.
function start() {
    if (timer) return;
    const tick = () => {
        shared.refresh().catch((e) => console.warn(`[selfheal-config] refresh failed ${e.message}`))
            .finally(() => { timer = setTimeout(tick, shared.ttlMs()); timer.unref?.(); });
    };
    tick();
}

module.exports = {
    createConfig, typeOk, start, sanitizeRemote, SERVED_HOST_HEALS, MAX_LIST,
    cfg: shared.cfg, snapshot: shared.snapshot, refresh: shared.refresh,
    setHeals: shared.setHeals, ttlMs: shared.ttlMs, shared,
};
