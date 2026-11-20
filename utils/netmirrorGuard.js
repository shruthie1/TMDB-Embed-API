'use strict';

// NetMirror throttle guard (N7): one place that decides whether NetMirror may
// be asked at all, and remembers every good answer while it stays valid.
//
// Why: newtv throttles per IP. Measured 2026-11-20 on the Mac (residential):
// after about 7 anonymous newtv calls player.php answered "status":"otp" and the master
// served the shared throttle clip (files/220884). On the VM newtv refuses the
// datacenter IP outright (403 "Page Not Found"), and every lookup still sent
// three refused searches. Each NetMirror call we skip is one the limiter never
// counts.
//
// Guard state, all persisted to one JSON file under data/ (git-ignored, kept
// by deploy-vm.sh), so a pm2 restart or a deploy does not re-hammer NetMirror:
//
//   cool-down   a throttle clip, "otp" or HTTP 429 stops ALL NetMirror calls
//               for 10 min, doubling per re-open up to 2h, reset by the first
//               real master.
//   newtv block a 403 "Page Not Found" stops every newtv call for 6h; after
//               that one lookup re-probes, and a refusal blocks again.
//   bucket      6 newtv calls per 5 min (one token back every 50s). The
//               throttle showed after ~7 calls, so 6 stays under it with one
//               call of margin. The embed-tmdb path is exempt: it has never
//               shown the clip and has its own 429 signal. Authenticated
//               requests have a separate configurable local allowance (24/5min),
//               not a claim about the upstream service limit.
//   cache       keyed answers with their own TTL (search/post 7d, player
//               until the link expires, rows until their urls expire).

const fs = require('fs');
const path = require('path');

const MIN = 60 * 1000;
const COOL_BASE_MS = 10 * MIN;
const COOL_MAX_MS = 120 * MIN;
const NEWTV_BLOCK_MS = Number(process.env.NETMIRROR_NEWTV_BLOCK_MS) || 6 * 60 * MIN;
const BUCKET_CAP = Number(process.env.NETMIRROR_BUDGET_CALLS) || 6;
const AUTH_BUCKET_CAP = Number(process.env.NETMIRROR_AUTH_BUDGET_CALLS) || 24;
const BUCKET_WINDOW_MS = Number(process.env.NETMIRROR_BUDGET_WINDOW_MS) || 5 * MIN;
const CACHE_MAX = 1500;
const WRITE_DELAY_MS = 500;

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'netmirror-state.json');

function freshState(now) {
    return {
        v: 1,
        throttle: { until: 0, nextMs: COOL_BASE_MS, reason: null },
        newtv: { blockedUntil: 0, reason: null },
        bucket: { tokens: BUCKET_CAP, at: now },
        authBucket: { tokens: AUTH_BUCKET_CAP, at: now },
        cache: {},
    };
}

function createGuard({ file = DEFAULT_FILE, now = () => Date.now(), log = (...a) => console.log(...a) } = {}) {
    let clock = now;
    let state = null;
    let timer = null;

    function load() {
        if (state) return state;
        state = freshState(clock());
        if (!file) return state;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (raw && raw.v === 1) {
                state = { ...state, ...raw };
                state.cache = raw.cache || {};
            }
        } catch (e) {
            if (e.code !== 'ENOENT') log(`[netmirror] state read failed (${e.message}) - starting fresh`);
        }
        return state;
    }

    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!file || !state) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state));
            fs.renameSync(tmp, file);
        } catch (e) {
            log(`[netmirror] state write failed: ${e.message}`);
        }
    }

    function save() {
        if (!file || timer) return;
        timer = setTimeout(flush, WRITE_DELAY_MS);
        if (timer.unref) timer.unref();
    }

    // ---- cool-down ------------------------------------------------------

    function coolingMs() {
        const s = load();
        const t = clock();
        if (s.throttle.until > t) return s.throttle.until - t;
        if (s.throttle.until) {
            log(`[netmirror] throttle-close reason=expired next=${Math.round(s.throttle.nextMs / 1000)}s`);
            s.throttle.until = 0;
            save();
        }
        return 0;
    }

    function throttleOpen(reason) {
        const s = load();
        const t = clock();
        if (s.throttle.until > t) return; // already open: one episode, one doubling
        const dur = Math.min(s.throttle.nextMs || COOL_BASE_MS, COOL_MAX_MS);
        s.throttle = { until: t + dur, nextMs: Math.min(dur * 2, COOL_MAX_MS), reason: String(reason) };
        log(`[netmirror] throttle-open reason=${reason} for=${Math.round(dur / 1000)}s`);
        flush();
    }

    function throttleClose(reason) {
        const s = load();
        const wasOpen = s.throttle.until > clock() || s.throttle.nextMs !== COOL_BASE_MS;
        if (!wasOpen) return;
        s.throttle = { until: 0, nextMs: COOL_BASE_MS, reason: null };
        log(`[netmirror] throttle-close reason=${reason}`);
        flush();
    }

    // ---- newtv block ----------------------------------------------------

    function newtvBlockedMs() {
        const s = load();
        const t = clock();
        if (s.newtv.blockedUntil > t) return s.newtv.blockedUntil - t;
        if (s.newtv.blockedUntil) {
            log('[netmirror] newtv-block-expired - next lookup re-probes once');
            s.newtv.blockedUntil = 0;
            save();
        }
        return 0;
    }

    function newtvBlock(reason) {
        const s = load();
        if (s.newtv.blockedUntil > clock()) return;
        s.newtv = { blockedUntil: clock() + NEWTV_BLOCK_MS, reason: String(reason) };
        log(`[netmirror] newtv-block reason=${reason} for=${Math.round(NEWTV_BLOCK_MS / 1000)}s`);
        flush();
    }

    // ---- bucket ---------------------------------------------------------

    // Independent local allowances; neither bucket stores credentials. Shared
    // IP-refusal and throttle state still gates both modes before a token.
    function refill(authenticated = false) {
        const s = load();
        const b = authenticated ? s.authBucket : s.bucket;
        const cap = authenticated ? AUTH_BUCKET_CAP : BUCKET_CAP;
        b.tokens = Math.min(cap, b.tokens);
        const t = clock();
        const gained = ((t - b.at) * cap) / BUCKET_WINDOW_MS;
        if (gained > 0) {
            b.tokens = Math.min(cap, b.tokens + gained);
            b.at = t;
        }
        return b;
    }

    function tokens(authenticated = false) { return Math.floor(refill(authenticated).tokens + 1e-9); }

    function take(authenticated = false) {
        const b = refill(authenticated);
        if (b.tokens + 1e-9 < 1) return false;
        b.tokens -= 1;
        save();
        return true;
    }

    // ---- cache ----------------------------------------------------------

    function cacheGet(key) {
        const s = load();
        const e = s.cache[key];
        if (!e) return undefined;
        if (e.exp <= clock()) { delete s.cache[key]; save(); return undefined; }
        return e.v;
    }

    function cacheSet(key, value, ttlMs) {
        if (!(ttlMs > 0)) return;
        const s = load();
        s.cache[key] = { v: value, exp: clock() + ttlMs };
        const keys = Object.keys(s.cache);
        if (keys.length > CACHE_MAX) {
            keys.sort((a, b) => s.cache[a].exp - s.cache[b].exp)
                .slice(0, keys.length - CACHE_MAX)
                .forEach((k) => { delete s.cache[k]; });
        }
        save();
    }

    function cacheDelete(key) {
        const s = load();
        if (s.cache[key]) { delete s.cache[key]; save(); }
    }

    function reset() {
        state = freshState(clock());
        flush();
    }

    return {
        coolingMs, throttleOpen, throttleClose,
        newtvBlockedMs, newtvBlock,
        tokens, take,
        cacheGet, cacheSet, cacheDelete,
        flush, reset,
        now: () => clock(),
        _setNow(fn) { clock = fn; },
    };
}

// The process-wide guard. Tests run in memory unless they name a file, so a
// test run never writes to (or reads stale state from) the real data/ file.
const guardFile = process.env.NETMIRROR_STATE_FILE
    || (process.env.NODE_TEST_CONTEXT ? null : DEFAULT_FILE);
const guard = createGuard({ file: guardFile });
process.on('exit', () => guard.flush());

module.exports = { createGuard, guard, COOL_BASE_MS, COOL_MAX_MS, NEWTV_BLOCK_MS };
