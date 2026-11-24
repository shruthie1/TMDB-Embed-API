'use strict';
// In-memory status of the MultiMovies hub for /api/health:
//   multimovies: { host, hostState, hostLastOk, hostLastErr,
//                  servers: { <name>: { lastOk, lastErr, teluguCount, state } },
//                  unknownServers: [host] }
// `state` per server: 'unknown' until observed, 'ok', 'degraded' (canary
// failed; ranked lower), 'down' (last request errored).
// The canary (lib/mmhub/canary.js) persists its own verdicts in the store and
// hydrates them here on start.

const MAX_UNKNOWN = 20;

let st;
function _reset() {
    st = { host: null, hostState: 'unknown', hostLastOk: null, hostLastErr: null, hostErrAt: null,
        servers: new Map(), unknown: new Set() };
}
_reset();

const iso = (t) => (t ? new Date(t).toISOString() : null);

function setHost(host) { st.host = host; }
function siteOk(host, at = Date.now()) {
    if (host) st.host = host;
    st.hostState = 'ok';
    st.hostLastOk = at;
}
function siteDown(host, reason, at = Date.now()) {
    if (host) st.host = host;
    st.hostState = 'down';
    st.hostLastErr = String(reason || 'error').slice(0, 120);
    st.hostErrAt = at;
}

/** True the first time `host` is seen (the caller logs it once). */
function unknownServer(host) {
    if (!host || st.unknown.has(host)) return false;
    if (st.unknown.size >= MAX_UNKNOWN) return false;
    st.unknown.add(host);
    return true;
}

function server(name) {
    const key = String(name);
    if (!st.servers.has(key)) {
        st.servers.set(key, { lastOk: null, lastErr: null, lastErrAt: null, teluguCount: 0, rows: 0,
            state: 'unknown', extractor: null, canary: null });
    }
    return st.servers.get(key);
}

/** One observed answer for one server on one title. */
function serverResult(name, { rows = 0, telugu = 0, err = null, extractor = null, at = Date.now() } = {}) {
    const s = server(name);
    if (extractor) s.extractor = extractor;
    if (err) {
        s.lastErr = String(err).slice(0, 120);
        s.lastErrAt = at;
        if (s.state !== 'degraded') s.state = 'down';
        return s;
    }
    s.rows = rows;
    if (rows > 0) {
        s.lastOk = at;
        if (s.state !== 'degraded') s.state = 'ok';
    }
    if (telugu > 0) s.teluguCount += telugu;
    return s;
}

/** Canary verdict: 'ok' or 'degraded', with the reason and next run. */
function setCanary(name, { state, reason = null, at = Date.now(), nextAt = null, extractor = null } = {}) {
    const s = server(name);
    if (extractor) s.extractor = extractor;
    s.canary = { state, reason, at, nextAt };
    if (state === 'degraded') s.state = 'degraded';
    else if (state === 'ok' && (s.state === 'degraded' || s.state === 'unknown')) s.state = 'ok';
    if (state === 'ok') s.lastOk = Math.max(s.lastOk || 0, at);
    if (state === 'degraded' && reason) { s.lastErr = String(reason).slice(0, 120); s.lastErrAt = at; }
}

/** Extractor (provider) names the canary currently marks degraded. */
function degradedProviders() {
    const out = new Set();
    for (const s of st.servers.values()) if (s.state === 'degraded' && s.extractor) out.add(s.extractor);
    return out;
}

function snapshot() {
    const servers = {};
    for (const [name, s] of st.servers) {
        servers[name] = { lastOk: iso(s.lastOk), lastErr: s.lastErr, teluguCount: s.teluguCount, state: s.state,
            ...(s.extractor ? { extractor: s.extractor } : {}),
            ...(s.canary ? { canary: { state: s.canary.state, reason: s.canary.reason, at: iso(s.canary.at), next: iso(s.canary.nextAt) } } : {}) };
    }
    return { host: st.host, hostState: st.hostState, hostLastOk: iso(st.hostLastOk), hostLastErr: st.hostLastErr,
        servers, unknownServers: [...st.unknown] };
}

module.exports = { setHost, siteOk, siteDown, unknownServer, serverResult, setCanary, degradedProviders, snapshot, _reset };
