'use strict';
// A dns.lookup that falls back to dns.resolve4 when the system resolver says
// a name does not exist.
//
// WHY (measured on VM1, 2026-11-24): interkh.com is a DNAME to showvid.ws.
// systemd-resolved's stub (127.0.0.53) answers `ghzbfjzbazc.interkh.com` with
// the DNAME and the target A record but no synthesised CNAME, and glibc's
// getaddrinfo then fails:
//   dns.lookup   ghzbfjzbazc.interkh.com -> ENOTFOUND
//   dns.resolve4 ghzbfjzbazc.interkh.com -> 67.159.10.2   (same stub)
//   curl         "Could not resolve host"
// Insertunit's masters list their renditions on such hosts, so the VM proxy
// could not fetch them. The phone and the Mac resolve them normally.
//
// Only a failed lookup changes path: a name the system resolves is untouched,
// and IPv6-only requests keep the original error.

const dns = require('node:dns');

const FALLBACK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);
const logged = new Set();

function lookupWithFallback(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    dns.lookup(hostname, opts, (err, address, family) => {
        if (!err || !FALLBACK_CODES.has(err.code) || opts.family === 6) return callback(err, address, family);
        (lookupWithFallback._resolve4 || dns.resolve4)(hostname, (e4, ips) => {
            if (e4 || !Array.isArray(ips) || !ips.length) return callback(err);
            if (!logged.has(hostname)) {
                logged.add(hostname);
                console.log(`[dns] ${hostname} lookup ${err.code}, resolve4 -> ${ips[0]}`);
            }
            if (opts.all) return callback(null, ips.map((a) => ({ address: a, family: 4 })));
            return callback(null, ips[0], 4);
        });
    });
}

// Agents for the fallback fetch (keepAlive off: a verify is one-off and must
// not hold the process open).
let agents = null;
function fallbackAgents() {
    if (!agents) {
        const http = require('node:http');
        const https = require('node:https');
        agents = { http: new http.Agent({ lookup: lookupWithFallback }), https: new https.Agent({ lookup: lookupWithFallback }) };
    }
    return agents;
}

function lookupFailed(err) {
    const c = err && (err.cause || err);
    return Boolean(c && FALLBACK_CODES.has(c.code));
}

/**
 * globalThis.fetch, and when it fails because the name did not resolve,
 * the same request once more through node-fetch with [lookupWithFallback].
 * Any other error is thrown as is. (segmentVerify byte checks on VM1.)
 */
async function fetchWithFallback(url, opts = {}) {
    const primary = fetchWithFallback._primary || globalThis.fetch;
    try {
        return await primary(url, opts);
    } catch (err) {
        if (!lookupFailed(err)) throw err;
        const nodeFetch = require('node-fetch');
        const a = fallbackAgents();
        return nodeFetch(url, { ...opts, agent: (u) => (u.protocol === 'http:' ? a.http : a.https) });
    }
}

module.exports = { lookupWithFallback, fetchWithFallback };
