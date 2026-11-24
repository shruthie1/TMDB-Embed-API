'use strict';
// Learned ranking per MultiMovies server (Part B item 7).
//
// Playback reports (POST /api/playback-report -> store source_stats) are
// counted per provider across every title: rows whose last report played vs
// rows with failures. For the MultiMovies server extractors only, that gives
// a score in [-0.5, 0.5] (Laplace-smoothed ok rate - 0.5) that apiServer's
// learnedFacts adds to a row's score. A canary-degraded server (state.js) is
// ranked below healthy rows of the same language group, never across it.

const state = require('./state');

const MM_PROVIDERS = new Set(['multimovies', 'vidrift', 'insertunit', 'vidout']);
const CACHE_MS = 10 * 60 * 1000;
let cache = null; // { at, map }

function stats(opts) {
    const now = Date.now();
    if (!opts.store && cache && now - cache.at < CACHE_MS) return cache.map;
    const s = opts.store || require('../../utils/store').getStore();
    const map = new Map();
    try { for (const r of s.playStatsByProvider()) map.set(String(r.provider).toLowerCase(), r); } catch { /* no store */ }
    if (!opts.store) cache = { at: now, map };
    return map;
}

function serverScore(provider, opts = {}) {
    const p = String(provider || '').toLowerCase();
    if (!MM_PROVIDERS.has(p)) return 0;
    const r = stats(opts).get(p);
    if (!r) return 0;
    const ok = Number(r.ok) || 0;
    const fail = Number(r.fail) || 0;
    return (ok + 1) / (ok + fail + 2) - 0.5;
}

function isDegraded(provider) {
    return state.degradedProviders().has(String(provider || '').toLowerCase());
}

function _reset() { cache = null; }

module.exports = { serverScore, isDegraded, MM_PROVIDERS, _reset };
