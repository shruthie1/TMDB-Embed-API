'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// One upstream call per provider+title at a time, shared by the aggregate
// route, the per-provider route and a ?full=1 follow-up to a partial answer.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const plan = {};
const stream = (provider, lang) => ({ provider, name: provider, title: `${provider} ${lang}`, quality: '1080p',
    url: `https://cdn.example/${provider}/${lang}.mp4`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'netmirror', 'mapple'];
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
    const t0 = Date.now();
    const r = await fetch(`${base}${p}`);
    return { ms: Date.now() - t0, d: await r.json(), cc: r.headers.get('cache-control') };
}

test('two concurrent requests for one title call each provider once', async () => {
    plan[4001] = {
        castletv: async () => { await sleep(200); return [stream('CastleTV', 'Hindi')]; },
        netmirror: async () => { await sleep(400); return [stream('NetMirror', 'Telugu')]; },
        mapple: async () => { await sleep(300); return [stream('Mapple', 'English')]; },
    };
    const [a, b] = await Promise.all([get('/api/streams/movie/4001'), get('/api/streams/movie/4001')]);
    assert.equal(a.d.count, b.d.count);
    assert.equal(calls['castletv:4001'], 1);
    assert.equal(calls['netmirror:4001'], 1);
    assert.equal(calls['mapple:4001'], 1);
});

test('the per-provider route reuses the aggregate result instead of fetching again', async () => {
    plan[4002] = {
        castletv: async () => [stream('CastleTV', 'Hindi')],
        netmirror: async () => { await sleep(100); return [stream('NetMirror', 'Telugu')]; },
    };
    await get('/api/streams/movie/4002');
    const one = await get('/api/streams/netmirror/movie/4002');
    assert.equal(one.d.count, 1);
    assert.equal(calls['netmirror:4002'], 1, 'served from the provider cache');
});

test('the per-provider route joins a NetMirror fetch the aggregate already started', async () => {
    plan[4003] = {
        castletv: async () => [stream('CastleTV', 'Hindi')],
        netmirror: async () => { await sleep(600); return [stream('NetMirror', 'Telugu')]; },
    };
    const agg = get('/api/streams/movie/4003');
    await sleep(150);
    const one = await get('/api/streams/netmirror/movie/4003');
    await agg;
    assert.equal(one.d.count, 1);
    assert.equal(calls['netmirror:4003'], 1);
});

test('a partial answer is no-store, and ?full=1 joins the late provider instead of restarting it', async () => {
    plan[4004] = {
        castletv: async () => [stream('CastleTV', 'Telugu')],
        mapple: async () => { await sleep(3500); return [stream('Mapple', 'English')]; },
    };
    const first = await get('/api/streams/movie/4004');
    assert.equal(first.d.partial, true);
    assert.equal(first.cc, 'no-store', 'a partial answer must not sit in an HTTP cache');
    const full = await get('/api/streams/movie/4004?full=1');
    console.log(`[measure] partial first ${first.ms}ms, full follow-up ${full.ms}ms`);
    assert.equal(full.d.partial, undefined);
    assert.deepEqual(full.d.streams.map((s) => s.provider).sort(), ['CastleTV', 'Mapple']);
    assert.equal(calls['mapple:4004'], 1, 'the running mapple call was joined');
    assert.match(full.cc, /max-age/);
});

test('a provider error on the per-provider route still reports providerError', async () => {
    plan[4005] = { netmirror: async () => { throw new Error('upstream reset'); } };
    const one = await get('/api/streams/netmirror/movie/4005');
    assert.equal(one.d.count, 0);
    assert.equal(one.d.providerError, 'upstream reset');
});

test('a provider that throws synchronously does not leave a stuck in-flight entry', async () => {
    let n = 0;
    fake.mapple.fetch = (ctx) => { n += 1; if (ctx.tmdbId === '4006') throw new Error('sync boom'); return Promise.resolve([]); };
    const a = await get('/api/streams/mapple/movie/4006');
    const b = await get('/api/streams/mapple/movie/4006');
    assert.equal(a.d.providerError, 'sync boom');
    assert.equal(b.d.providerError, 'sync boom');
    assert.equal(n, 2, 'an error is not cached, so the second ask calls again');
});
