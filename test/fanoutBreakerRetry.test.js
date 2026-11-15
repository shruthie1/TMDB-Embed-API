'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Stub the provider registry and TMDB lookup BEFORE apiServer loads, so the
// fan-out route runs against fake providers with no network. Each fake's
// behaviour is chosen per tmdbId through `plan`.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const plan = {}; // plan[tmdbId][provider] = async () => streams
const stream = (provider, n = 1) => ({ provider, name: provider, title: `${provider} ${n}`, quality: '1080p',
    url: `https://cdn.example/${provider}/${n}.mp4`, container: 'mp4', languages: ['English'] });
const NAMES = ['castletv', 'netmirror', 'onetouchtv'];
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
// The early answer is opt-in; these tests exercise it.
process.env.PRIMARY_PROVIDERS = 'castletv,netmirror';
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });

const { recordProviderOutcome, BREAKER_THRESHOLD, metrics } = require('../lib/runtime/metrics');
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function get(id, q = '') {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/streams/movie/${id}${q}`);
    return { status: r.status, ms: Date.now() - t0, d: await r.json() };
}

// Prod 2026-11-15 19:01 UTC: Castle lacks The Paradise and NetMirror's breaker
// was open after one flaky probe. The fan-out skipped NetMirror and returned
// count:0 instantly, so the web player had nothing to play, while the
// per-provider route returned 1 NetMirror stream for the same title.
test('fan-out retries breaker-skipped providers when nothing else returned streams', async () => {
    plan[1376856] = { netmirror: async () => [stream('NetMirror')] };
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome('netmirror', 'error', 1, 0);
    assert.ok(metrics.providerHealth.netmirror.trippedUntil, 'precondition: netmirror breaker open');
    const { status, d } = await get(1376856, '?refresh=1');
    assert.equal(status, 200);
    assert.equal(calls['netmirror:1376856'], 1, 'netmirror must be retried despite its open breaker');
    assert.equal(d.count, 1);
    assert.equal(d.streams[0].provider, 'NetMirror');
    metrics.providerHealth.netmirror.trippedUntil = null;
    metrics.providerHealth.netmirror.consecutiveMisses = 0;
});

test('a slow secondary provider does not hold the response; its result serves the next request', async () => {
    plan[2001] = {
        castletv: async () => [stream('CastleTV')],
        onetouchtv: async () => { await sleep(2500); return [stream('OneTouchTV')]; },
    };
    const first = await get(2001);
    assert.ok(first.ms < 2300, `first response took ${first.ms}ms`);
    assert.deepEqual(first.d.streams.map((s) => s.provider), ['CastleTV']);
    await sleep(2700); // let onetouchtv finish in the background
    const second = await get(2001);
    assert.ok(second.ms < 500, `second response took ${second.ms}ms`);
    assert.deepEqual(second.d.streams.map((s) => s.provider).sort(), ['CastleTV', 'OneTouchTV']);
    assert.equal(calls['onetouchtv:2001'], 1, 'second request reuses the cached onetouchtv result');
    assert.equal(calls['castletv:2001'], 1);
});

test('a secondary is waited for when the primaries found nothing', async () => {
    plan[2002] = { onetouchtv: async () => { await sleep(2000); return [stream('OneTouchTV')]; } };
    const r = await get(2002);
    assert.equal(r.d.count, 1);
    assert.equal(r.d.streams[0].provider, 'OneTouchTV');
});

test('an empty provider is not asked again for the same title within the negative TTL', async () => {
    plan[2003] = { castletv: async () => [stream('CastleTV')] };
    await get(2003);
    const before = calls['netmirror:2003'];
    // ?capabilities=1 is a different memo key, so this runs a fresh fan-out
    // (without ?refresh) and must reach the per-provider caches.
    await fetch(`${base}/api/streams/movie/2003?capabilities=1`).then((r) => r.json());
    assert.equal(before, 1);
    assert.equal(calls['netmirror:2003'], 1, 'netmirror empty result is cached per title');
});

test('a provider deadline is recorded as a timeout, not an empty', async () => {
    plan[2004] = { castletv: async () => [stream('CastleTV')], netmirror: async () => { const a = []; a.timedOut = true; return a; } };
    const before = (metrics.providerHealth.netmirror && metrics.providerHealth.netmirror.timeout) || 0;
    await get(2004);
    assert.equal(metrics.providerHealth.netmirror.timeout, before + 1);
});
