'use strict';
// Per-server canary for the MultiMovies hub (Part B item 4).
//
// Every 6 h, each MultiMovies server that has an extractor resolves the canary
// titles (resolve-config mmhub.canaryTitles: RRR, Pushpa 2, one series). A
// server passes when:
//   - it has rows on at least one canary title;
//   - every title it had Telugu on before still has a Telugu-tagged row
//     (else `[mm-canary] <server> telugu missing <title>`);
//   - the top row of each movie title runs >= 0.82 x TMDB runtime;
//   - a row's first segment is real media (lib/media/segmentVerify.js): up
//     to SEGMENT_TRIES rows, Telugu first. One flaky row is not a dead server:
//     prod 2026-11-24 VidBolt's proxy.vidbolt.xyz row on RRR verified ok,
//     timeout, ok in three runs (canary had said "segment html") while its two
//     /mm/hls/ rows passed every time.
// A resolve error on one title is title-level (Vidrift has no orionStreams
// for Pushpa 2 on either host, while RRR and Kalki resolve and play): it
// fails the server only when no canary title had rows, or when that title
// had Telugu before (then it counts as "telugu missing").
// A failure marks the server degraded (ranked lower, lib/mmhub/ranking.js)
// and retries after 30 min, doubling to the 6 h cap. A pass clears it.
// State persists in the store's provider_canary table under `mm:<extractor>`
// (and `mm:<extractor>:<tmdbId>` for the Telugu memory).

const state = require('./state');

const HEALTHY_MS = 6 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const RUNTIME_MIN_RATIO = 0.82;
// A Telugu baseline that stays missing this many runs in a row is dropped
// (logged), so a title the upstream really de-listed stops degrading a
// server forever.
const TELUGU_RESET_AFTER = 4;
const SEGMENT_TRIES = 3;

const DEFAULT_TITLES = [
    { tmdbId: '579974', type: 'movie', label: 'RRR' },
    { tmdbId: '857598', type: 'movie', label: 'Pushpa 2' },
    { tmdbId: '200946', type: 'series', season: 1, episode: 1, label: 'Dhootha S1E1' },
];

function backoffMs(fails) { return Math.min(HEALTHY_MS, RETRY_MS * 2 ** Math.max(0, fails - 1)); }

function createMmCanary({ store, servers, titles, resolve, verify, rowSeconds, runtimeMinutes,
    isTelugu = require('./lastKnownGood').isTelugu, now = Date.now, log = (l) => console.warn(l) }) {
    let running = false;

    function hydrate() {
        for (const srv of servers()) {
            let r = null;
            try { r = store.canaryGet(`mm:${srv.extractor}`); } catch { /* no store */ }
            if (r && r.state) {
                state.setCanary(srv.name, { state: r.state, reason: r.last_error, at: r.last_run_at,
                    nextAt: r.next_due_at, extractor: srv.extractor });
            }
        }
    }

    async function checkServer(srv) {
        const reasons = [];
        const titleErrors = [];
        let anyRows = false;
        for (const t of titles()) {
            const label = t.label || t.tmdbId;
            const key = t.type === 'movie' ? `mm:${srv.extractor}:${t.tmdbId}` : `mm:${srv.extractor}:tv:${t.tmdbId}:${t.season || 0}:${t.episode || 0}`;
            const prev = store.canaryGet(key) || {};
            let rows = [];
            try { rows = (await resolve(srv.extractor, t)) || []; } catch (e) {
                const why = `error ${label}: ${String(e.message).slice(0, 60)}`;
                log(`[mm-canary] ${srv.name} title error ${label}: ${String(e.message).slice(0, 120)}`);
                // No Telugu baseline: title-level, judged after the loop.
                if (prev.telugu_ok !== 1) { titleErrors.push(why); continue; }
                rows = [];
            }
            const hasTe = rows.some(isTelugu);
            if (hasTe) store.canaryPut(key, { telugu_ok: 1, fails: 0, last_ok_at: now() });
            else if (prev.telugu_ok === 1) {
                const misses = (prev.fails || 0) + 1;
                log(`[mm-canary] ${srv.name} telugu missing ${label}`);
                if (misses >= TELUGU_RESET_AFTER) {
                    store.canaryPut(key, { telugu_ok: 0, fails: 0 });
                    log(`[mm-canary] ${srv.name} telugu baseline reset ${label} after ${misses} runs`);
                } else store.canaryPut(key, { fails: misses });
                reasons.push(`telugu missing ${label}`);
            }
            if (!rows.length) continue;
            anyRows = true;
            const top = rows.find(isTelugu) || rows[0];
            if (t.type === 'movie' && rowSeconds && runtimeMinutes) {
                try {
                    const [sec, min] = await Promise.all([rowSeconds(top), runtimeMinutes(t.tmdbId)]);
                    if (sec > 0 && min > 0 && sec / 60 < min * RUNTIME_MIN_RATIO) {
                        reasons.push(`runtime ${label} ${Math.round(sec / 60)}m < ${RUNTIME_MIN_RATIO}x${min}m`);
                    }
                } catch { /* unknown runtime is not a failure */ }
            }
            if (verify) {
                const tries = [top, ...rows.filter((r) => r !== top && isTelugu(r)), ...rows.filter((r) => r !== top && !isTelugu(r))]
                    .slice(0, SEGMENT_TRIES);
                let v = null;
                for (const row of tries) {
                    try { v = await verify(row); } catch (e) { v = { ok: false, reason: e.message }; }
                    if (v && v.ok) break;
                }
                if (!v || !v.ok) reasons.push(`segment ${label} (${tries.length} rows): ${String((v && v.reason) || 'failed').slice(0, 60)}`);
            }
        }
        if (!anyRows) reasons.unshift('rows=0 on every canary title', ...titleErrors);
        return reasons;
    }

    async function runOne(srv) {
        const key = `mm:${srv.extractor}`;
        const prev = store.canaryGet(key) || { runs: 0, fails: 0 };
        const reasons = await checkServer(srv);
        const at = now();
        if (!reasons.length) {
            const nextAt = at + HEALTHY_MS;
            store.canaryPut(key, { state: 'ok', kind: null, last_run_at: at, last_ok_at: at, next_due_at: nextAt,
                last_error: null, runs: (prev.runs || 0) + 1, fails: 0 });
            state.setCanary(srv.name, { state: 'ok', at, nextAt, extractor: srv.extractor });
            log(`[mm-canary] ${srv.name} ok next=${new Date(nextAt).toISOString()}`);
            return;
        }
        // `fails` here counts consecutive failed runs (reset on a pass).
        const fails = (prev.state === 'degraded' ? (prev.fails || 0) : 0) + 1;
        const nextAt = at + backoffMs(fails);
        const reason = reasons.join('; ').slice(0, 300);
        store.canaryPut(key, { state: 'degraded', kind: 'mm', last_run_at: at, next_due_at: nextAt,
            last_error: reason, runs: (prev.runs || 0) + 1, fails });
        state.setCanary(srv.name, { state: 'degraded', reason, at, nextAt, extractor: srv.extractor });
        log(`[mm-canary] ${srv.name} degraded fails=${fails} next=${new Date(nextAt).toISOString()} reason=${reason}`);
    }

    async function runDue() {
        if (running) return;
        running = true;
        try {
            for (const srv of servers()) {
                const r = store.canaryGet(`mm:${srv.extractor}`);
                if (r && r.next_due_at && now() < r.next_due_at) continue;
                try { await runOne(srv); } catch (e) { log(`[mm-canary] ${srv.name} run failed: ${e.message}`); }
            }
        } finally { running = false; }
    }

    return { runDue, runOne, hydrate };
}

// Production wiring: registry providers, segmentVerify, TMDB runtime.
function startMmCanary({ getProvider, store, tickMs = TICK_MS }) {
    const page = require('./page');
    const proof = require('../selfheal/proof');
    const cfgServers = () => {
        const list = page.liveCfg().servers;
        const seen = new Set();
        return (Array.isArray(list) ? list : []).filter((e) => e && e.extractor && !seen.has(e.extractor)
            && seen.add(e.extractor) && getProvider(e.extractor))
            .map((e) => ({ name: displayName(e), extractor: e.extractor }));
    };
    const c = createMmCanary({
        store,
        servers: cfgServers,
        titles: () => {
            let t = DEFAULT_TITLES;
            try { t = require('../selfheal/config').cfg('mmhub', 'canaryTitles', DEFAULT_TITLES); } catch { /* defaults */ }
            return t;
        },
        resolve: async (extractor, t) => {
            const prov = getProvider(extractor);
            if (!prov || !prov.enabled) return [];
            return prov.fetch({ tmdbId: String(t.tmdbId), type: t.type === 'movie' ? 'movie' : 'series',
                season: t.season || null, episode: t.episode || null, filters: {} });
        },
        verify: (row) => require('../media/segmentVerify').verifyOne(row, { attemptMs: 6000 }),
        rowSeconds: async (row) => proof.hlsRowSeconds([row], proof.proofFetch()),
        runtimeMinutes: (id) => proof.runtimeMinutes(id),
    });
    c.hydrate();
    const tick = () => { c.runDue().catch((e) => console.warn(`[mm-canary] tick failed: ${e.message}`)); };
    const first = setTimeout(tick, 60 * 1000);
    first.unref?.();
    const timer = setInterval(tick, tickMs);
    timer.unref?.();
    return { stop: () => { clearTimeout(first); clearInterval(timer); }, canary: c };
}

// The health key for a config entry: its name pattern without anchors, as
// MultiMovies spells it ("^gd mirror$" -> "GD mirror" is not recoverable, so
// a `label` field wins when present).
function displayName(e) {
    if (e.label) return e.label;
    const LABELS = { multimovies: 'Vidbolt', vidrift: 'Vidrift', vidout: 'VIDOUT', insertunit: 'GD mirror' };
    return LABELS[e.extractor] || String(e.name || e.extractor).replace(/^\^|\$$/g, '');
}

module.exports = { SEGMENT_TRIES, createMmCanary, startMmCanary, displayName, backoffMs, DEFAULT_TITLES, HEALTHY_MS, RETRY_MS };
