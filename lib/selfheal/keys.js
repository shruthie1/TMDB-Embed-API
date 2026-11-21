'use strict';
// Key and token extractors, and the key heal run (provider self-heal Task 6).
//
//   extractVidrockKey   GET <base>/movie/27205, its /assets/index-*.js, try
//                       each 64-hex literal on one fresh ciphertext with the
//                       GCM tag. 2 GETs.
//   extractOnetouchKey  GET <front>/main.dart.js, try each 32-char literal
//                       (IV = its first 16) on one fresh ciphertext; JSON out
//                       means a pass. Also returns api host literals. 1 GET.
//   parseVaConfig       vaplayer player page `const CONFIG = {...}`.
//
// Key heal: 3 key failures in a row on one provider start one run (30-min
// cooldown, single-flight). A found key is tried as a TRIAL (withTrial: only
// inside that async context), and it is saved (upstreamBase.setField) only
// after the provider's own resolve of its validation title passed with the
// title proof (the registry passes that verify). Never on shape alone.
// Logs: `[heal] <name> key start|none|same|reject|adopt`, and on none/same
// `[heal] <name> key none|same -> host rediscover|skip|applied|none`.
//
// Spec: docs/superpowers/specs/2026-11-21-provider-selfheal-design.md section 4.

const { AsyncLocalStorage } = require('async_hooks');
const { createDecipheriv } = require('crypto');

const KEY_STREAK = 3;

// ---- trial values (a key under test, never seen by other requests) ----

const trialStore = new AsyncLocalStorage();
function withTrial(name, fields, fn) { return trialStore.run({ name, fields: { ...fields } }, fn); }
function trial(name, field) {
    const s = trialStore.getStore();
    return s && s.name === name && s.fields[field] !== undefined ? s.fields[field] : undefined;
}

// ---- extractors ----

function b64urlBuf(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

/** AES-256-GCM, 12-byte IV, 16-byte tag (vidrock). Throws on a bad tag. */
function gcmDecrypt(keyBuf, encoded) {
    const buf = b64urlBuf(encoded);
    if (buf.length <= 28) throw new Error('ciphertext too short');
    const d = createDecipheriv('aes-256-gcm', keyBuf, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
}

function uniq(list) { return [...new Set(list)]; }

async function getText(fetchFn, url, headers) {
    const r = await fetchFn(url, { headers: headers || {}, signal: AbortSignal.timeout(10000) });
    if (!r || r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r && r.status} for ${url}`);
    return r.text();
}

async function extractVidrockKey({ fetch: fetchFn, base, sample, headers }) {
    const b = String(base).replace(/\/+$/, '');
    const page = await getText(fetchFn, `${b}/movie/27205`, headers);
    const m = /["'(]([^"'()]*\/assets\/index-[\w-]+\.js)["')]/.exec(page);
    if (!m) { console.warn(`[heal] vidrock key none: no /assets/index-*.js on ${b}/movie/27205`); return null; }
    const bundle = await getText(fetchFn, new URL(m[1], `${b}/`).href, headers);
    const literals = uniq([...bundle.matchAll(/["']([0-9a-f]{64})["']/gi)].map((x) => x[1].toLowerCase()));
    for (const hex of literals) {
        try {
            const out = gcmDecrypt(Buffer.from(hex, 'hex'), sample);
            if (/^https?:\/\//i.test(out)) return { key: hex, tried: literals.length };
        } catch { /* wrong key: tag fails */ }
    }
    console.warn(`[heal] vidrock key none: ${literals.length} literal(s), none passed the GCM tag`);
    return null;
}

function cbcJson(key, iv, encoded) {
    let s = String(encoded).replace(/-_\./g, '/').replace(/@/g, '+').replace(/\s+/g, '');
    if (s.length % 4) s += '='.repeat(4 - (s.length % 4));
    const d = createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s, 'base64')), d.final()]).toString('utf8'));
}

/** API host literals in a bundle: ="https://api[0-9]*.<host>". */
function apiHostsFromBundle(text) {
    return uniq([...String(text).matchAll(/="(https:\/\/api[0-9]*\.[a-z0-9.-]+\.[a-z]{2,})[^"]*"/gi)]
        .map((x) => x[1].toLowerCase()));
}

async function extractOnetouchKey({ fetch: fetchFn, front, sample, headers }) {
    const f = String(front).replace(/\/+$/, '');
    const bundle = await getText(fetchFn, `${f}/main.dart.js`, headers);
    const hosts = apiHostsFromBundle(bundle);
    const literals = uniq([...bundle.matchAll(/"([A-Za-z0-9]{32})"/g)].map((x) => x[1]));
    if (sample) {
        for (const key of literals) {
            try {
                cbcJson(key, key.slice(0, 16), sample);
                return { key, iv: key.slice(0, 16), hosts, tried: literals.length };
            } catch { /* bad padding or not JSON */ }
        }
    }
    console.warn(`[heal] onetouchtv key none: ${literals.length} literal(s), none decrypted to JSON`);
    return { key: null, iv: null, hosts, tried: literals.length };
}

/** Body of `<const|let|var> CONFIG = {...}` as an object, or null. */
function parseVaConfig(html) {
    const text = String(html || '');
    const m = /\b(?:const|let|var)\s+CONFIG\s*=\s*\{/.exec(text);
    if (!m) return null;
    let i = m.index + m[0].length - 1;
    let depth = 0; let quote = null; let end = -1;
    for (; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return null;
    const src = text.slice(m.index + m[0].length - 1, end + 1);
    try { return JSON.parse(src); } catch { /* JS literal, below */ }
    // A plain object literal: quote bare keys, single-quoted strings to JSON,
    // drop trailing commas. No code is run.
    try {
        // Strings are kept as tokens so a ':' or ',' inside one is not touched.
        const json = src.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"']+/g).map((t) => {
            if (t[0] === '"') return t;
            if (t[0] === "'") return JSON.stringify(t.slice(1, -1).replace(/\\'/g, "'"));
            return t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/,(\s*[}\]])/g, '$1');
        }).join('');
        return JSON.parse(json);
    } catch { return null; }
}

// The classifier calls this `blocked` (lib/selfheal/classify.js BLOCKED_RE).
function vaRateLimitedMessage() { return 'vaplayer: player page says rateLimited:true (IP gate)'; }

// ---- the key heal run ----

const streak = new Map();
const lastRun = new Map();
const running = new Map();

function cooldownMs() { return require('../../utils/upstreamBase').COOLDOWN_MS; }
function keyStreak(name) { return streak.get(name) || 0; }
function noteKeyOk(name) { streak.set(name, 0); }

/**
 * opts (or a function returning it, called when a run starts):
 *   { extract(): {field:value}|null, verify(fields): bool, current?(): {field:value} }
 * Returns the run's promise when this failure started one, else null.
 */
function noteKeyFail(name, opts) {
    const n = keyStreak(name) + 1;
    streak.set(name, n);
    console.warn(`[heal] ${name} key-fail ${n}/${KEY_STREAK}`);
    if (n < KEY_STREAK) return null;
    return start(name, opts);
}

/** The canary's entry: one run now (no streak), same cooldown. Resolves to true when applied. */
async function healNow(name, opts) {
    const p = start(name, opts);
    return p ? p : false;
}

function start(name, opts) {
    if (running.has(name)) { console.warn(`[heal] ${name} key skip (running)`); return null; }
    const now = Date.now();
    if (now - (lastRun.get(name) || 0) < cooldownMs()) {
        console.warn(`[heal] ${name} key skip (cooldown)`);
        return null;
    }
    lastRun.set(name, now);
    streak.set(name, 0);
    const p = runKeyHeal(name, opts)
        .catch((e) => { console.warn(`[heal] ${name} key failed: ${e.message}`); return false; })
        .finally(() => running.delete(name));
    running.set(name, p);
    return p;
}

async function runKeyHeal(name, optsOrFactory) {
    // A factory is built only when a run starts (the registry passes one).
    const opts = typeof optsOrFactory === 'function' ? optsOrFactory() : optsOrFactory;
    console.warn(`[heal] ${name} key start (${KEY_STREAK} key failures in a row)`);
    const found = await opts.extract();
    const fields = found && Object.fromEntries(Object.entries(found).filter(([k, v]) => ['key', 'iv'].includes(k) && v));
    if (!fields || !fields.key) { console.warn(`[heal] ${name} key none`); return hostFallback(name, opts, 'none'); }
    const cur = typeof opts.current === 'function' ? opts.current() : null;
    if (cur && Object.keys(fields).every((k) => cur[k] === fields[k])) {
        console.warn(`[heal] ${name} key same (the bundle key is the one in use)`);
        return hostFallback(name, opts, 'same');
    }
    const ok = await withTrial(name, fields, () => opts.verify(fields));
    if (!ok) { console.warn(`[heal] ${name} key reject (own resolve or title proof failed)`); return false; }
    const upstream = require('../../utils/upstreamBase');
    for (const [field, value] of Object.entries(fields)) upstream.setField(name, field, value, 'bundle');
    console.warn(`[heal] ${name} key adopt via bundle (${Object.keys(fields).join('+')})`);
    return true;
}

// Review I1: no new key in the bundle (or the same one) means the key is not
// the fault; the host may have moved (a dead host's answers fail to decrypt).
// opts.fallback() starts one host rediscover (registry startRediscover,
// under its own 30-min cooldown). Resolves to 'host' when a host was applied.
async function hostFallback(name, opts, why) {
    if (typeof opts.fallback !== 'function') return false;
    console.warn(`[heal] ${name} key ${why} -> host rediscover`);
    const r = await opts.fallback();
    if (!r) { console.warn(`[heal] ${name} key ${why} -> host skip (cooldown or running)`); return false; }
    console.warn(`[heal] ${name} key ${why} -> host ${r.applied ? 'applied' : 'none'}`);
    return r.applied ? 'host' : false;
}

function _reset() { streak.clear(); lastRun.clear(); running.clear(); }

module.exports = {
    extractVidrockKey, extractOnetouchKey, parseVaConfig, apiHostsFromBundle, gcmDecrypt, cbcJson,
    vaRateLimitedMessage, withTrial, trial,
    noteKeyFail, noteKeyOk, keyStreak, healNow, runKeyHeal, KEY_STREAK, _reset,
};
