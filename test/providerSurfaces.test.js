'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Owner rule 2026-11-21: mapple and VaPlayer are APK-only (the APK resolves
// them on device). A web caller (?client=web) must not run them in the fan-out,
// so the browser never waits on their timeouts and never sees their rows. Any
// other caller (the APK, old clients) gets them exactly as before.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const row = (provider) => ({ provider, name: provider, title: `${provider} Telugu`, quality: '1080p',
    url: `https://cdn.example/${provider}/t.mp4`, container: 'mp4', languages: ['Telugu'] });
const NAMES = ['castletv', 'mapple', 'vaplayer'];
const SLOW = { mapple: 1500, vaplayer: 1500, castletv: 50 };
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        calls[`${name}:${ctx.tmdbId}`] = (calls[`${name}:${ctx.tmdbId}`] || 0) + 1;
        await sleep(SLOW[name]);
        return [row(name === 'vaplayer' ? 'VaPlayer' : name === 'castletv' ? 'CastleTV' : 'mapple')];
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
stub('lib/media/segmentVerify.js', { ...require('../lib/media/segmentVerify'), verifyTopStreams: async (s) => s });
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });
const { surfaceAllows, PROVIDER_SURFACES } = require('../lib/routing/providerRoutes');
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function get(p) {
    const t0 = Date.now();
    const r = await fetch(`${base}${p}`);
    return { ms: Date.now() - t0, status: r.status, d: await r.json() };
}
const providers = (d) => (d.streams || []).map((s) => String(s.provider).toLowerCase()).sort();

test('config: mapple and vaplayer are none on web, on-device on apk; others serve both', () => {
    assert.deepEqual(PROVIDER_SURFACES.mapple, { web: 'none', apk: 'on-device' });
    assert.deepEqual(PROVIDER_SURFACES.vaplayer, { web: 'none', apk: 'on-device' });
    assert.equal(surfaceAllows('mapple', 'web'), false);
    assert.equal(surfaceAllows('VaPlayer', 'web'), false);
    assert.equal(surfaceAllows('mapple', 'apk'), true);
    assert.equal(surfaceAllows('mapple', undefined), true, 'an unknown caller keeps today\'s list');
    assert.equal(surfaceAllows('castletv', 'web'), true);
});

test('a web caller never runs mapple/vaplayer and does not wait on them', async () => {
    const w = await get('/api/streams/movie/4001?client=web');
    console.log(`[measure] web answer ${w.ms}ms (mapple/vaplayer stubs take ${SLOW.mapple}ms)`);
    assert.deepEqual(providers(w.d), ['castletv']);
    assert.equal(calls['mapple:4001'], undefined);
    assert.equal(calls['vaplayer:4001'], undefined);
    assert.ok(w.ms < 1000, `web answer took ${w.ms}ms`);
});

test('the APK (no client param) still gets mapple and vaplayer, even after a web call for the same title', async () => {
    const a = await get('/api/streams/movie/4001');
    assert.deepEqual(providers(a.d), ['castletv', 'mapple', 'vaplayer']);
    assert.equal(calls['mapple:4001'], 1);
    assert.equal(calls['vaplayer:4001'], 1);
    const w = await get('/api/streams/movie/4001?client=web');
    assert.deepEqual(providers(w.d), ['castletv'], 'the APK answer in the memo is not served to the web');
});

test('the single-provider route refuses mapple/vaplayer for web, serves them for the APK', async () => {
    const w = await get('/api/streams/mapple/movie/4002?client=web');
    assert.equal(w.status, 404);
    assert.equal(w.d.error, 'PROVIDER_NOT_FOR_WEB');
    assert.equal(calls['mapple:4002'], undefined);
    const a = await get('/api/streams/mapple/movie/4002');
    assert.equal(a.status, 200);
    assert.equal(calls['mapple:4002'], 1);
});
