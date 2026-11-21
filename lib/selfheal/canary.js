'use strict';
// Provider canary (provider self-heal Task 7). Owner rules 2026-11-21: the
// canary drives auto-heal only. No alerts, no admin page, no notifications.
//
// The API process calls tick() every 10 min (timer unref'd). Each tick runs at
// most ONE provider: the enabled, non-excluded one whose next_due_at is the
// oldest and already due. Due rule:
//   pass                      +6 h
//   fail host|key|token|down  +30 min
//   fail blocked|drift        +6 h (requests will not fix it)
// So one failing provider costs at most 48 runs a day, a healthy one 4.
//
// A run: the provider's own resolve (the same registry path as a user
// request, so the same tagging) on its validation title: UPSTREAM.verifyTitle
// when it names one (RRR 579974 for vidrift, vidrock, onetouchtv: measured
// 0 rows on Inception, ledger I3), else Inception 27205. castletv,
// multimovies and vidrock also run Krack 784572. telugu_ok records whether a
// Telugu-tagged row came back on a Telugu title (579974, 784572); null when no
// Telugu title ran.
// Fail: classify, call heal(name, kind) once for host|key|token, and re-run
// the validation title once if a heal was applied.
//
// Never run: netmirror (CLAUDE.md #5: zero canary requests) and mapple
// (APK-only, the VM is Cloudflare-blocked). vaplayer is APK-only on the VM
// too: it runs on the 6 h cadence with no heal, so the VM never hammers it.
// Its failure keeps its own class; only a Cloudflare or rateLimited answer
// (classify `blocked`) is recorded `blocked` (spec section 4, review I2),
// because `blocked` turns the server path off for APK callers (serveSkip).
//
// Logs (greppable): `[canary] run|pass|fail|heal|rerun|telugu|skip|idle|error`.

const HEALTHY_MS = 6 * 60 * 60 * 1000;
const FAILING_MS = 30 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const EXCLUDED = new Set(['netmirror', 'mapple']);
const APK_ONLY_ON_VM = new Set(['vaplayer']);
const TELUGU_EXTRA = new Set(['castletv', 'multimovies', 'vidrock']);
const KRACK = '784572';
const INCEPTION = '27205';
const TELUGU_TITLES = new Set(['579974', KRACK]);
const HEAL_KINDS = new Set(['host', 'key', 'token']);
const FAST_KINDS = new Set(['host', 'key', 'token', 'down']);

function isTelugu(row) {
    let canon;
    try { canon = require('../../utils/streamSchema').canonicalLanguage; } catch { canon = (v) => v; }
    const te = (v) => v && canon(String(v)) === 'Telugu';
    return Boolean(row) && ((Array.isArray(row.languages) && row.languages.some(te))
        || (Array.isArray(row.audio) && row.audio.some((a) => a && (te(a.language) || te(a.name)))));
}

/**
 * providers(): [{ name, enabled, verifyTitle?, resolve(tmdbId) -> rows }]
 * store: utils/store.js (canaryGet/canaryAll/canaryPut)
 * classify(input) -> kind; explain-style input { message, status }
 * heal(name, kind) -> { applied, how }
 * recordOutcome(name, 'hit')
 */
function createCanary({ providers, store, classify, explain, heal, recordOutcome, now = Date.now, log = (l) => console.warn(l) }) {
    let inFlight = false;
    const saidOnce = new Set();
    const once = (line) => { if (!saidOnce.has(line)) { saidOnce.add(line); log(line); } };
    const why = explain || ((input) => ({ kind: classify(input), rule: 'classify' }));

    function titlesFor(p) {
        const primary = String((p.verifyTitle && p.verifyTitle.tmdbId) || INCEPTION);
        return { primary, extra: TELUGU_EXTRA.has(p.name) && primary !== KRACK ? [KRACK] : [] };
    }

    function pick() {
        const t = now();
        const due = [];
        for (const p of providers()) {
            if (EXCLUDED.has(p.name)) { once(`[canary] skip ${p.name} (excluded)`); continue; }
            if (!p.enabled) { once(`[canary] skip ${p.name} (disabled)`); continue; }
            const row = store.canaryGet(p.name);
            const at = row && row.next_due_at != null ? Number(row.next_due_at) : -Infinity;
            if (at <= t) due.push({ p, at });
        }
        due.sort((a, b) => a.at - b.at || a.p.name.localeCompare(b.p.name));
        return due.length ? due[0].p : null;
    }

    async function attempt(p, tmdbId) {
        try {
            const rows = await p.resolve(tmdbId);
            const list = Array.isArray(rows) ? rows : [];
            if (list.length) return { ok: true, rows: list };
            // Review M1: the registry deadline answers [] with timedOut.
            if (rows && rows.timedOut) return { ok: false, kind: 'down', rule: 'timeout', message: `provider deadline for ${tmdbId}` };
            return { ok: false, kind: 'drift', rule: 'empty', message: `0 rows for ${tmdbId}` };
        } catch (e) {
            const r = why({ message: e && e.message, status: e && e.status });
            return { ok: false, kind: r.kind, rule: r.rule, message: String((e && e.message) || e).slice(0, 300) };
        }
    }

    async function runOne(p) {
        const { primary, extra } = titlesFor(p);
        const prev = store.canaryGet(p.name) || { runs: 0, fails: 0 };
        const startedAt = now();
        log(`[canary] run ${p.name} titles=${[primary, ...extra].join(',')}`);
        let res = await attempt(p, primary);
        let healHow = prev.heal_how || null;
        let healAt = prev.heal_at || null;
        let kind = res.ok ? null : res.kind;
        const apkOnly = APK_ONLY_ON_VM.has(p.name);
        if (!res.ok) {
            log(`[canary] fail ${p.name} kind=${res.kind} rule=${res.rule} title=${primary}${apkOnly ? ' (apk-only, no heal)' : ''} msg=${res.message}`);
            if (!apkOnly && HEAL_KINDS.has(res.kind)) {
                let h = { applied: false };
                try { h = (await heal(p.name, res.kind)) || { applied: false }; } catch (e) {
                    log(`[canary] heal ${p.name} ${res.kind} error ${e.message}`);
                }
                log(`[canary] heal ${p.name} ${res.kind} applied=${Boolean(h.applied)}${h.how ? ` how=${h.how}` : ''}`);
                if (h.applied) {
                    healHow = h.how || res.kind;
                    healAt = now();
                    res = await attempt(p, primary);
                    log(`[canary] rerun ${p.name} ${res.ok ? 'pass' : `fail kind=${res.kind} rule=${res.rule}`}`);
                    if (!res.ok) kind = res.kind;
                }
            }
        }
        const rowsByTitle = new Map();
        if (res.ok) {
            rowsByTitle.set(primary, res.rows);
            for (const id of extra) {
                const r = await attempt(p, id);
                rowsByTitle.set(id, r.ok ? r.rows : []);
                if (!r.ok) log(`[canary] telugu ${p.name} ${id} no rows (${r.kind} ${r.rule})`);
            }
        }
        const teluguRan = [...rowsByTitle.keys()].filter((id) => TELUGU_TITLES.has(id));
        const teluguOk = teluguRan.length ? (teluguRan.some((id) => rowsByTitle.get(id).some(isTelugu)) ? 1 : 0) : null;
        const t = now();
        if (res.ok) {
            try { recordOutcome(p.name, 'hit'); } catch (e) { log(`[canary] error ${p.name} recordOutcome ${e.message}`); }
            store.canaryPut(p.name, {
                state: 'ok', kind: null, last_run_at: startedAt, last_ok_at: t, next_due_at: t + HEALTHY_MS,
                last_error: null, telugu_ok: teluguOk, heal_how: healHow, heal_at: healAt, runs: (prev.runs || 0) + 1,
                fails: prev.fails || 0,
            });
            log(`[canary] pass ${p.name} rows=${res.rows.length} telugu_ok=${teluguOk === null ? '-' : teluguOk} next=+6h`);
            return;
        }
        // Spec section 6: vaplayer with an empty apiToken on the VM is an IP gate -> blocked.
        if (apkOnly && kind === 'token') kind = 'blocked';
        const state = kind;
        const next = !apkOnly && FAST_KINDS.has(kind) ? FAILING_MS : HEALTHY_MS;
        store.canaryPut(p.name, {
            state, kind, last_run_at: startedAt, last_ok_at: prev.last_ok_at || null, next_due_at: t + next,
            last_error: res.message, telugu_ok: teluguOk === null ? (prev.telugu_ok ?? null) : teluguOk,
            heal_how: healHow, heal_at: healAt, runs: (prev.runs || 0) + 1, fails: (prev.fails || 0) + 1,
        });
        log(`[canary] next ${p.name} state=${state} in ${next === FAILING_MS ? '30m' : '6h'}`);
    }

    async function tick() {
        if (inFlight) { log('[canary] skip tick (a run is in flight)'); return null; }
        inFlight = true;
        try {
            const p = pick();
            if (!p) { log('[canary] idle (nothing due)'); return null; }
            await runOne(p);
            return p.name;
        } catch (e) {
            log(`[canary] error ${e && e.message}`);
            return null;
        } finally {
            inFlight = false;
        }
    }

    return { tick, _pick: pick };
}

// ---- wiring (Task 8) ----

/** The /api/status `heal` object for one provider, or null with no canary row. Read-only. */
function healStatus(store, name) {
    let r = null;
    try { r = store.canaryGet(name); } catch { return null; }
    if (!r) return null;
    return {
        state: r.state, kind: r.kind, lastOkAt: r.last_ok_at, lastRunAt: r.last_run_at, nextDueAt: r.next_due_at,
        teluguOk: r.telugu_ok === null || r.telugu_ok === undefined ? null : r.telugu_ok === 1, healHow: r.heal_how,
        lastError: r.last_error,
    };
}

/**
 * True when the server should not run `name` for this caller: not a web
 * caller (the APK or an unknown one), the provider resolves on the device for
 * the APK (onDevice(name)), and its last canary said `blocked`. A canary pass
 * clears it. Logs `[canary] serve-skip <name> (blocked, apk on-device)` once
 * each time the provider enters `blocked` (not per request).
 */
const skipLogged = new Set();
function serveSkip(name, surface, store, onDevice) {
    if (surface === 'web' || !onDevice(name)) return false;
    let r = null;
    try { r = store.canaryGet(name); } catch { return false; }
    if (!r || r.state !== 'blocked') { skipLogged.delete(name); return false; }
    // Review M3: one line per provider per blocked state change.
    if (!skipLogged.has(name)) {
        skipLogged.add(name);
        console.warn(`[canary] serve-skip ${name} (blocked, apk on-device)`);
    }
    return true;
}

/**
 * Start the 10-min canary timer (unref'd) in the API process. registry:
 * providers/registry.js; recordOutcome: lib/runtime/metrics
 * recordProviderOutcome. Returns the canary.
 */
function startCanary({ registry, store, recordOutcome, tickMs = TICK_MS }) {
    const { classify, explain } = require('./classify');
    const canary = createCanary({
        providers: () => registry.listProviders().map((p) => ({
            name: p.name,
            enabled: p.enabled,
            verifyTitle: typeof registry.verifyTitleOf === 'function' ? registry.verifyTitleOf(p.name) : null,
            resolve: (tmdbId) => registry.getProvider(p.name).fetch({ tmdbId: String(tmdbId), type: 'movie' }),
        })),
        store,
        classify,
        explain,
        heal: (name, kind) => (typeof registry.healNow === 'function' ? registry.healNow(name, kind) : { applied: false }),
        recordOutcome: (name, outcome) => recordOutcome(name, outcome, 0, 1),
    });
    const timer = setInterval(() => { canary.tick(); }, tickMs);
    timer.unref?.();
    console.warn(`[canary] start every ${Math.round(tickMs / 60000)}m (one provider per tick)`);
    return canary;
}

module.exports = { createCanary, startCanary, healStatus, serveSkip, isTelugu, HEALTHY_MS, FAILING_MS, TICK_MS, EXCLUDED, APK_ONLY_ON_VM };
