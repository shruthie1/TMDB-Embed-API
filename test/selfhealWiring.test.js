'use strict';
// Provider self-heal Task 8: /api/status `heal` rows (read-only) and the
// server skipping an APK-on-device provider that the canary found blocked.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const calls = {};
const row = (provider) => ({ provider, name: provider, title: `${provider} Telugu`, quality: '1080p',
    url: `https://cdn.example/${provider}/t.mp4`, container: 'mp4', languages: ['Telugu'] });
const NAMES = ['castletv', 'vaplayer'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        calls[`${name}:${ctx.tmdbId}`] = (calls[`${name}:${ctx.tmdbId}`] || 0) + 1;
        return [row(name === 'vaplayer' ? 'VaPlayer' : 'CastleTV')];
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
const { getStore } = require('../utils/store');
const { createCanary } = require('../lib/selfheal/canary');
const app = require('../apiServer');

let base; let server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
async function get(p) {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, d: await r.json() };
}
const providers = (d) => (d.streams || []).map((s) => String(s.provider).toLowerCase()).sort();

test('(c) /api/status has a heal object for each provider with a canary row, null without one', async () => {
    getStore().canaryPut('castletv', { state: 'ok', kind: null, last_run_at: 1, last_ok_at: 2, next_due_at: 3, telugu_ok: 1, heal_how: 'host:redirect', runs: 1 });
    const { d } = await get('/api/status');
    const byName = Object.fromEntries(d.providers.map((p) => [p.name, p]));
    assert.deepEqual(byName.castletv.heal, { state: 'ok', kind: null, lastOkAt: 2, lastRunAt: 1, nextDueAt: 3, teluguOk: true, healHow: 'host:redirect', lastError: null });
    assert.equal(byName.vaplayer.heal, null);
});

test('(d) blocked vaplayer (apk on-device) is not run for a default caller; the web never ran it anyway', async () => {
    getStore().canaryPut('vaplayer', { state: 'blocked', kind: 'token', last_error: 'no apiToken on the player page' });
    const a = await get('/api/streams/movie/5001');
    assert.deepEqual(providers(a.d), ['castletv']);
    assert.equal(calls['vaplayer:5001'], undefined);
    // The single-provider route is an explicit ask: still served.
    const one = await get('/api/streams/vaplayer/movie/5002');
    assert.equal(one.status, 200);
    assert.equal(calls['vaplayer:5002'], 1);
});

// Owner 2026-11-22: the aggregate never runs an APK-on-device provider, so a
// canary pass changes the canary state only; the device keeps resolving it.
test('(e) a canary pass sets the state back to ok; the aggregate still leaves vaplayer to the device', async () => {
    let t = Date.now();
    const canary = createCanary({
        providers: () => [{ name: 'vaplayer', enabled: true, resolve: (id) => fake.vaplayer.fetch({ tmdbId: id }) }],
        store: getStore(),
        classify: () => 'blocked',
        heal: async () => ({ applied: false }),
        recordOutcome: () => {},
        now: () => t,
        log: () => {},
    });
    getStore().canaryPut('vaplayer', { next_due_at: t - 1 });
    assert.equal(await canary.tick(), 'vaplayer');
    assert.equal(getStore().canaryGet('vaplayer').state, 'ok');
    const a = await get('/api/streams/movie/5003');
    assert.deepEqual(providers(a.d), ['castletv']);
    assert.equal(calls['vaplayer:5003'], undefined);
});
