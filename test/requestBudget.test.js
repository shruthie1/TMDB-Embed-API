'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

// RRR 579974, 2026-11-21: /api/streams had no whole-request budget. The castle
// gate, NetMirror (gated behind it) and the breaker-retry pass ran in series,
// each up to the 20 s registry deadline. These tests run the route with small
// budgets (set below, before apiServer loads) against fake providers.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const plan = {};
const stream = (provider, lang, n = 1) => ({ provider, name: provider, title: `${provider} ${lang} ${n}`, quality: '1080p',
    url: `https://cdn.example/${provider}/${lang}/${n}.mp4`, container: 'mp4', languages: [lang] });
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
process.env.PRIMARY_PROVIDERS = 'castletv,netmirror';
process.env.PREFERRED_AUDIO_LANGUAGE = 'Telugu';
process.env.REQUEST_BUDGET_MS = '1500';
process.env.CASTLE_GATE_MAX_MS = '400';
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return realFetch(url, opts);
    outbound.push(u);
    return Promise.reject(new Error(`outbound fetch blocked in test: ${u}`));
};
stub('lib/media/segmentVerify.js', { ...require('../lib/media/segmentVerify'), verifyTopStreams: async (s) => s, prewarmTopStreams: () => [] });
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
    return { ms: Date.now() - t0, cc: r.headers.get('cache-control'), d: await r.json() };
}

test('request budget: a primary still running at the budget goes out late; ?full=1 collects it', async () => {
    plan[4001] = {
        castletv: async () => [],
        onetouchtv: async () => { await sleep(100); return [stream('OneTouchTV', 'Hindi')]; },
        netmirror: async () => { await sleep(3000); return [stream('NetMirror', 'Telugu')]; },
    };
    const first = await get(4001);
    console.log(`[measure] budget first answer ${first.ms}ms`);
    assert.ok(first.ms >= 1400 && first.ms < 2000, `first answer took ${first.ms}ms (budget 1500)`);
    assert.deepEqual(first.d.streams.map((s) => s.provider), ['OneTouchTV']);
    assert.equal(first.d.partial, true);
    assert.equal(first.cc, 'no-store');
    assert.equal(first.d.providerTimings.netmirror, null);
    const full = await get(4001, '?full=1');
    assert.ok(full.d.streams.some((s) => s.provider === 'NetMirror'), '?full=1 has no budget and waits');
    assert.equal(calls['netmirror:4001'], 1, 'the in-flight NetMirror call is joined, not repeated');
});

test('castle gate is capped: NetMirror starts once the cap passes instead of after Castle', async () => {
    plan[4002] = {
        castletv: async () => { await sleep(1000); return [stream('CastleTV', 'Telugu')]; },
        netmirror: async () => { await sleep(800); return [stream('NetMirror', 'Hindi')]; },
    };
    // In series this is 1000 + 800 = 1800 ms, past the 1500 ms budget, so
    // NetMirror would be cut. Capped at 400 ms, both are done by ~1200 ms.
    const first = await get(4002);
    console.log(`[measure] castle-cap first answer ${first.ms}ms`);
    assert.ok(first.ms < 1500, `first answer took ${first.ms}ms`);
    const providers = first.d.streams.map((s) => s.provider).sort();
    assert.ok(providers.includes('CastleTV'), `castle rows kept: ${providers}`);
    assert.ok(providers.includes('NetMirror'), `netmirror rows kept: ${providers}`);
    assert.equal(calls['castletv:4002'], 1);
});

test('breaker-retry pass is skipped once the budget is spent', async () => {
    plan[4003] = {
        castletv: async () => [],
        onetouchtv: async () => { await sleep(2500); return []; },
        netmirror: async () => [stream('NetMirror', 'Telugu')],
    };
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome('netmirror', 'error', 1, 0);
    assert.ok(metrics.providerHealth.netmirror.trippedUntil, 'precondition: netmirror breaker open');
    try {
        const first = await get(4003, '?refresh=1');
        console.log(`[measure] budget-spent retry-skip answer ${first.ms}ms`);
        assert.ok(first.ms < 2000, `answer took ${first.ms}ms`);
        assert.equal(calls['netmirror:4003'], undefined, 'netmirror is not retried after the budget');
        assert.ok(first.d.providerErrors.includes('netmirror'));
        assert.equal(first.cc, 'no-store');
    } finally {
        metrics.providerHealth.netmirror.trippedUntil = null;
        metrics.providerHealth.netmirror.consecutiveMisses = 0;
    }
});

function rawGet(urlPath, headers) {
    return new Promise((resolve, reject) => {
        http.get(`${base}${urlPath}`, { headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('/api/streams JSON is gzipped when the client accepts it', async () => {
    plan[4004] = {
        castletv: async () => Array.from({ length: 12 }, (_, i) => stream('CastleTV', 'Telugu', i)),
    };
    const r = await rawGet('/api/streams/movie/4004', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    const raw = zlib.gunzipSync(r.body);
    console.log(`[measure] gzip ${r.body.length}B vs raw ${raw.length}B`);
    assert.ok(r.body.length < raw.length);
    assert.equal(JSON.parse(raw).success, true);
    const plain = await rawGet('/api/streams/movie/4004', {});
    assert.equal(plain.headers['content-encoding'], undefined, 'no gzip without Accept-Encoding');
});

test('makes no outbound network call', () => {
    assert.deepStrictEqual(outbound, []);
});
