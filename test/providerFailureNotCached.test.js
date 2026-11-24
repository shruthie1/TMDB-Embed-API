'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// A provider that timed out, was skipped by its breaker, or lost part of its
// answer to an upstream failure has an UNKNOWN result for the title. The
// response built without it must not be memoized or kept by the browser, and
// its partial rows must not sit in providerHitCache for 10 minutes: that is how
// one short upstream blip hid a provider's Telugu row for the whole TTL.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const calls = {};
const plan = {};
const stream = (provider, lang = 'English') => ({ provider, name: provider, title: provider, quality: '1080p',
    url: `https://cdn.example/${provider}-${lang}.mp4`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'onetouchtv'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        calls[`${name}:${ctx.tmdbId}`] = (calls[`${name}:${ctx.tmdbId}`] || 0) + 1;
        const f = plan[ctx.tmdbId] && plan[ctx.tmdbId][name];
        return f ? f(ctx) : [];
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
const getRes = async (p) => {
    const r = await fetch(`${base}${p}`);
    return { r, d: await r.json() };
};

test('a timed-out provider: response not memoized, no-store, provider asked again', async () => {
    let up = false;
    plan[4001] = {
        castletv: async () => [stream('CastleTV')],
        onetouchtv: async () => (up ? [stream('OneTouchTV', 'Telugu')] : Object.assign([], { timedOut: true })),
    };
    const first = await getRes('/api/streams/movie/4001');
    assert.equal(first.r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(first.d.providerErrors, ['onetouchtv']);
    assert.equal(metrics.providerHealth.onetouchtv.timeout >= 1, true);

    up = true;
    const second = await getRes('/api/streams/movie/4001');
    assert.equal(second.d.cached, undefined, 'second answer was rebuilt, not served from the memo');
    assert.equal(calls['onetouchtv:4001'], 2, 'timeout was not cached as an empty');
    assert.ok(second.d.streams.some((s) => s.provider === 'OneTouchTV'));
    assert.match(second.r.headers.get('cache-control'), /^private, max-age=\d+$/);
});

test('a partial provider answer (upstreamError) is served, cached 5 min as partial, never memoized', async () => {
    let up = false;
    plan[4002] = {
        castletv: async () => [stream('CastleTV')],
        onetouchtv: async () => (up
            ? [stream('OneTouchTV', 'Hindi'), stream('OneTouchTV', 'Telugu')]
            : Object.assign([stream('OneTouchTV', 'Hindi')], { upstreamError: 'telugu track: HTTP 503' })),
    };
    const first = await getRes('/api/streams/movie/4002');
    assert.equal(first.r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(first.d.providerErrors, ['onetouchtv']);
    assert.ok(first.d.streams.some((s) => s.provider === 'OneTouchTV'), 'the rows it did get are still served');

    up = true;
    // Within the 5-min partial TTL the cached partial rows are served, still
    // reported as partial and kept out of the memo and the browser cache.
    const second = await getRes('/api/streams/movie/4002');
    assert.equal(calls['onetouchtv:4002'], 1, 'partial rows came from providerHitCache');
    assert.deepEqual(second.d.providerErrors, ['onetouchtv']);
    assert.equal(second.d.cached, undefined, 'partial answer was not memoized');
    assert.equal(second.r.headers.get('cache-control'), 'no-store');
    // ?refresh=1 skips the cache and picks up the recovered Telugu row.
    const third = await getRes('/api/streams/movie/4002?refresh=1');
    assert.equal(calls['onetouchtv:4002'], 2);
    assert.ok(third.d.streams.some((s) => (s.languages || []).includes('Telugu')), 'Telugu row arrives once upstream recovers');
    assert.equal(third.d.providerErrors, undefined);
});

test('per-provider route reports a timeout and a partial answer as providerError', async () => {
    plan[4003] = { onetouchtv: async () => Object.assign([], { timedOut: true }) };
    const a = await getRes('/api/streams/onetouchtv/movie/4003');
    assert.equal(a.r.status, 200);
    assert.match(a.d.providerError || '', /timeout/);

    plan[4004] = { onetouchtv: async () => Object.assign([stream('OneTouchTV')], { upstreamError: 'HTTP 503' }) };
    const b = await getRes('/api/streams/onetouchtv/movie/4004');
    assert.equal(b.d.count, 1);
    assert.match(b.d.providerError || '', /503/);
});

// 2026-11-21 vidrift live: every host 403, the provider threw, and the route
// answered 200 count 0. That is the contract, but the error must be in
// providerError, reach the breaker, and not be cached as "no streams".
test('per-provider route: a provider that throws is providerError, a breaker miss, not cached', async () => {
    const before = (metrics.providerHealth.onetouchtv && metrics.providerHealth.onetouchtv.consecutiveMisses) || 0;
    plan[4007] = { onetouchtv: async () => { throw new Error('vidrift-like: every host failed: HTTP 403'); } };
    const a = await getRes('/api/streams/onetouchtv/movie/4007');
    assert.equal(a.r.status, 200);
    assert.equal(a.d.count, 0);
    assert.match(a.d.providerError || '', /every host failed: HTTP 403/);
    assert.equal(metrics.providerHealth.onetouchtv.consecutiveMisses, before + 1);
    await getRes('/api/streams/onetouchtv/movie/4007');
    assert.equal(calls['onetouchtv:4007'], 2, 'the failure was not cached as empty');
    metrics.providerHealth.onetouchtv.consecutiveMisses = 0;
    metrics.providerHealth.onetouchtv.trippedUntil = null;
});

test('a breaker-skipped provider: response not memoized, no-store', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome('onetouchtv', 'error', 1, 0, true, `trip:${i}`);
    assert.ok(metrics.providerHealth.onetouchtv.trippedUntil, 'breaker open');
    plan[4005] = {
        castletv: async () => [stream('CastleTV')],
        onetouchtv: async () => [stream('OneTouchTV', 'Telugu')],
    };
    const first = await getRes('/api/streams/movie/4005');
    assert.equal(calls['onetouchtv:4005'], undefined, 'skipped by the breaker');
    assert.equal(first.r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(first.d.providerErrors, ['onetouchtv']);
    const second = await getRes('/api/streams/movie/4005');
    assert.equal(second.d.cached, undefined, 'not served from the memo');
    metrics.providerHealth.onetouchtv.trippedUntil = null;
    metrics.providerHealth.onetouchtv.consecutiveMisses = 0;
});

test('season and episode must be positive integers', async () => {
    for (const q of ['season=0&episode=1', 'season=1&episode=0', 'season=1.5&episode=1', 'season=abc&episode=1', 'season=-1&episode=1']) {
        const a = await getRes(`/api/streams/series/4006?${q}`);
        assert.equal(a.r.status, 400, q);
        const b = await getRes(`/api/streams/onetouchtv/series/4006?${q}`);
        assert.equal(b.r.status, 400, `per-provider ${q}`);
    }
    plan[4006] = { castletv: async (ctx) => [stream(`CastleTV-S${ctx.season}E${ctx.episode}`)] };
    const ok = await getRes('/api/streams/series/4006?season=2&episode=3');
    assert.equal(ok.r.status, 200);
    assert.ok(ok.d.streams.some((s) => s.provider === 'CastleTV-S2E3'));
});
