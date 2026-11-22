'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Owner 2026-11-22: mapple and VaPlayer are APK-only and always resolved on
// the device (lib/routing/providerRoutes.js PROVIDER_SURFACES apk:on-device).
// The VM no longer runs them in /api/streams for ANY caller: the web never
// did, and the APK gets them itself. On the VM mapple is Cloudflare-blocked,
// so its error or late answer kept APK answers out of the memo.
// The single-provider route still runs them (debugging), except for web.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const row = (provider) => ({ provider, name: provider, title: `${provider} Telugu`, quality: '1080p',
    url: `https://cdn.example/${provider}/t.mp4`, container: 'mp4', languages: ['Telugu'] });
const NAMES = ['castletv', 'mapple', 'vaplayer', 'onetouchtv'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        calls[`${name}:${ctx.tmdbId}`] = (calls[`${name}:${ctx.tmdbId}`] || 0) + 1;
        await sleep(30);
        if (name === 'mapple') throw new Error('mapple upstream 403');
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
    return { status: r.status, cc: r.headers.get('cache-control'), d: await r.json() };
}
const providers = (d) => (d.streams || []).map((s) => String(s.provider).toLowerCase()).sort();

test('APK caller: /api/streams never runs mapple or vaplayer; the answer is complete and memoized', async () => {
    const first = await get('/api/streams/movie/9001');
    assert.equal(calls['mapple:9001'], undefined);
    assert.equal(calls['vaplayer:9001'], undefined);
    assert.deepEqual(providers(first.d), ['castletv', 'onetouchtv']);
    assert.equal(first.d.providerErrors, undefined, 'no providerErrors: old APKs see no reason to re-ask');
    assert.equal(first.d.partial, undefined);
    assert.equal('mapple' in first.d.providerTimings, false);
    assert.match(first.cc, /max-age=/);
    const second = await get('/api/streams/movie/9001');
    assert.equal(second.d.cached, true);
});

test('web caller: same (it never ran them)', async () => {
    const w = await get('/api/streams/movie/9002?client=web');
    assert.equal(calls['mapple:9002'], undefined);
    assert.equal(calls['vaplayer:9002'], undefined);
    assert.deepEqual(providers(w.d), ['castletv', 'onetouchtv']);
});

test('full=1 follow-up does not run them either', async () => {
    await get('/api/streams/movie/9003?full=1');
    assert.equal(calls['mapple:9003'], undefined);
    assert.equal(calls['vaplayer:9003'], undefined);
});

test('single-provider route still runs vaplayer for a non-web caller (debugging)', async () => {
    const r = await get('/api/streams/vaplayer/movie/9004');
    assert.equal(r.status, 200);
    assert.equal(calls['vaplayer:9004'], 1);
    assert.deepEqual(providers(r.d), ['vaplayer']);
});

test('single-provider route still refuses mapple for web', async () => {
    const r = await get('/api/streams/mapple/movie/9005?client=web');
    assert.equal(r.status, 404);
    assert.equal(calls['mapple:9005'], undefined);
});
