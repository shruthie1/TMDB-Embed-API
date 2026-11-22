'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// mapple is APK-only and the VM is Cloudflare-blocked for it, yet the server
// still runs it for APK callers (lib/routing/providerRoutes.js: an unknown
// caller keeps today's list). It errors on almost every title, and an answer
// with a provider error was never memoized, so every repeat play paid the
// whole fan-out and the early-answer floor again (apk-playback.md 2026-11-22).
// An error from a provider the APK resolves ON DEVICE no longer blocks the
// cache for that (non-web) answer: the APK gets that provider's rows itself.
// providerErrors still names it. Any other provider error still blocks.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const plan = {};
const row = (provider) => ({ provider, name: provider, title: `${provider} Telugu`, quality: '1080p',
    url: `https://cdn.example/${provider}/t.mp4`, container: 'mp4', languages: ['Telugu'] });
const NAMES = ['castletv', 'mapple', 'onetouchtv'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        calls[`${name}:${ctx.tmdbId}`] = (calls[`${name}:${ctx.tmdbId}`] || 0) + 1;
        await sleep(30);
        const f = plan[ctx.tmdbId] && plan[ctx.tmdbId][name];
        if (f === 'throw') throw new Error(`${name} upstream 403`);
        return [row(name)];
    },
}]));
stub('providers/registry.js', {
    listProviders: () => NAMES.map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
delete process.env.PRIMARY_PROVIDERS;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return realFetch(url, opts);
    return Promise.reject(new Error(`outbound fetch blocked in test: ${u}`));
};
stub('lib/media/segmentVerify.js', { ...require('../lib/media/segmentVerify'), verifyTopStreams: async (s) => s, prewarmTopStreams: () => [] });
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function get(p) {
    const r = await fetch(`${base}${p}`);
    return { cc: r.headers.get('cache-control'), d: await r.json() };
}
const providers = (d) => (d.streams || []).map((s) => String(s.provider).toLowerCase()).sort();

// Since 2026-11-22 the aggregate never runs mapple (test/onDeviceSkip.test.js),
// so a mapple error can no longer reach the answer.
test('APK caller: mapple is not run, so its error cannot block the memo; the other rows are cached', async () => {
    plan[6001] = { mapple: 'throw' };
    const first = await get('/api/streams/movie/6001');
    assert.equal(first.d.providerErrors, undefined);
    assert.deepEqual(providers(first.d), ['castletv', 'onetouchtv']);
    assert.match(first.cc, /max-age=/);
    const second = await get('/api/streams/movie/6001');
    assert.equal(second.d.cached, true, 'served from the memo');
    assert.deepEqual(providers(second.d), ['castletv', 'onetouchtv'], 'same rows');
    assert.equal(calls['mapple:6001'], undefined);
    assert.equal(calls['castletv:6001'], 1);
});

test('APK caller: an error from a server-side provider still blocks the memo', async () => {
    plan[6002] = { onetouchtv: 'throw' };
    const first = await get('/api/streams/movie/6002');
    assert.deepEqual(first.d.providerErrors, ['onetouchtv']);
    assert.equal(first.cc, 'no-store');
    const second = await get('/api/streams/movie/6002');
    assert.equal(second.d.cached, undefined, 'rebuilt, not served from the memo');
    assert.equal(calls['onetouchtv:6002'], 2);
});

test('APK caller: mapple planned to throw AND a server-side provider error: still not cached', async () => {
    plan[6003] = { mapple: 'throw', onetouchtv: 'throw' };
    const first = await get('/api/streams/movie/6003');
    assert.deepEqual(first.d.providerErrors, ['onetouchtv'], 'mapple is not run');
    assert.equal(first.cc, 'no-store');
    const second = await get('/api/streams/movie/6003');
    assert.equal(second.d.cached, undefined);
});

test('web caller never runs mapple, so it never errors there', async () => {
    plan[6004] = { mapple: 'throw' };
    const w = await get('/api/streams/movie/6004?client=web');
    assert.equal(w.d.providerErrors, undefined);
    assert.equal(calls['mapple:6004'], undefined);
    assert.deepEqual(providers(w.d), ['castletv', 'onetouchtv']);
});
