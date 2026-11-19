'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// A provider that throws is an 'error': counted as one, never cached as an
// empty, so the next request asks it again. Prod 2026-11-19 08:28 UTC: a 40s
// OneTouchTV upstream 404 was cached as empty and hid it for 3 minutes.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const calls = {};
const plan = {};
const stream = (provider) => ({ provider, name: provider, title: provider, quality: '1080p',
    url: `https://cdn.example/${provider}.mp4`, container: 'mp4', languages: ['English'] });
const NAMES = ['castletv', 'onetouchtv'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        calls[`${name}:${ctx.tmdbId}`] = (calls[`${name}:${ctx.tmdbId}`] || 0) + 1;
        const f = plan[ctx.tmdbId] && plan[ctx.tmdbId][name];
        return f ? f() : [];
    },
}]));
stub('providers/registry.js', {
    listProviders: () => NAMES.map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });

const { metrics, recordProviderOutcome, BREAKER_THRESHOLD } = require('../lib/runtime/metrics');
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const get = async (p) => (await fetch(`${base}${p}`)).json();

test('a thrown provider error is recorded as error and not cached as empty', async () => {
    let up = false;
    plan[3001] = {
        castletv: async () => [stream('CastleTV')],
        onetouchtv: async () => { if (!up) throw new Error('HTTP 404 from episode'); return [stream('OneTouchTV')]; },
    };
    const errBefore = (metrics.providerHealth.onetouchtv || {}).error || 0;
    const emptyBefore = (metrics.providerHealth.onetouchtv || {}).empty || 0;
    const first = await get('/api/streams/movie/3001');
    assert.deepEqual(first.streams.map((s) => s.provider), ['CastleTV']);
    assert.equal(metrics.providerHealth.onetouchtv.error, errBefore + 1);
    assert.equal(metrics.providerHealth.onetouchtv.empty || 0, emptyBefore, 'not counted as empty');

    // Upstream recovers. Without ?refresh the next request must still ask
    // OneTouchTV, because the error was not cached as an empty.
    up = true;
    const second = await get('/api/streams/movie/3001');
    assert.equal(calls['onetouchtv:3001'], 2);
    assert.ok(second.streams.some((s) => s.provider === 'OneTouchTV'));
});

test('a real empty is still cached as empty', async () => {
    plan[3002] = { castletv: async () => [stream('CastleTV')], onetouchtv: async () => [] };
    await get('/api/streams/movie/3002');
    await get('/api/streams/movie/3002?capabilities=1'); // new memo key, same provider cache key
    assert.equal(calls['onetouchtv:3002'], 1, 'empty result reused from providerEmptyCache');
});

test('per-provider route keeps 200 and reports providerError', async () => {
    plan[3003] = { onetouchtv: async () => { throw new Error('HTTP 503 from search'); } };
    const r = await fetch(`${base}/api/streams/onetouchtv/movie/3003`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.count, 0);
    assert.match(d.providerError, /503/);
});

test('breaker: repeated errors for one title count once', () => {
    const name = 'errsame';
    for (let i = 0; i < BREAKER_THRESHOLD + 3; i++) recordProviderOutcome(name, 'error', 1, 0, true, 'movie:1::');
    const h = metrics.providerHealth[name];
    assert.equal(h.error, BREAKER_THRESHOLD + 3, 'every error still counted in metrics');
    assert.equal(h.consecutiveMisses, 1);
    assert.equal(h.trippedUntil, null);
});

test('breaker: errors across different titles still trip', () => {
    const name = 'errmany';
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome(name, 'error', 1, 0, true, `movie:${i}::`);
    assert.ok(metrics.providerHealth[name].trippedUntil);
});

test('breaker: errors with no titleKey still trip (old callers)', () => {
    const name = 'errplain';
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome(name, 'error', 1, 0);
    assert.ok(metrics.providerHealth[name].trippedUntil);
});

test('breaker: errors for an unresolvable title do not count', () => {
    const name = 'errunres';
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome(name, 'error', 1, 0, false, `movie:${i}::`);
    assert.equal(metrics.providerHealth[name].trippedUntil, null);
    assert.equal(metrics.providerHealth[name].error, BREAKER_THRESHOLD);
});
