'use strict';
// Part B wiring in apiServer: last-known-good serve + evict (item 6), learned
// ranking per MM server (item 7), /api/health multimovies (item 8), observe
// after the fan-out (item 1).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

let teluguLive = true;
const row = (provider, lang, file) => ({ provider, name: provider, title: provider, quality: '1080p',
    url: `https://cdn-${provider.toLowerCase()}.example/${file}/master.m3u8`, container: 'hls', languages: [lang] });
const fake = {
    multimovies: { name: 'multimovies', enabled: true,
        fetch: async () => [teluguLive ? row('multimovies', 'Telugu', 'te') : row('multimovies', 'English', 'en')] },
    vidrock: { name: 'vidrock', enabled: true, fetch: async () => [row('vidrock', 'English', 'vr')] },
};
stub('providers/registry.js', {
    listProviders: () => Object.keys(fake).map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
let verifyOk = true;
stub('lib/media/segmentVerify.js', {
    verifyTopStreams: async (s) => s,
    verifyOne: async () => (verifyOk ? { ok: true, container: 'ts' } : { ok: false, reason: 'http 403' }),
});
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt8178634' });
const hub = require('../lib/mmhub/hub');
const mmState = require('../lib/mmhub/state');
const observed = [];
hub._setReader(async (t) => {
    observed.push(t.tmdbId);
    return { servers: [{ name: 'Vidbolt', host: 'vidbolt.xyz', known: true, extractor: 'multimovies' },
        { name: 'Zeta', host: 'new.example.org', known: false, extractor: null }] };
});
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const get = async (p) => (await fetch(`${base}${p}`)).json();
const report = (body) => fetch(`${base}/api/playback-report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); };

test('Telugu row seen once is served back as lastKnownGood when the live answer lacks Telugu', async () => {
    teluguLive = true;
    const first = await get('/api/streams/movie/579974?refresh=1');
    assert.ok(first.streams.some((s) => (s.languages || []).includes('Telugu')));
    assert.ok(!first.streams.some((s) => s.lastKnownGood));

    teluguLive = false;
    const second = await get('/api/streams/movie/579974?refresh=1');
    const kept = second.streams.filter((s) => s.lastKnownGood);
    assert.strictEqual(kept.length, 1);
    assert.deepStrictEqual(kept[0].languages, ['Telugu'], 'original tag kept');
    assert.strictEqual(kept[0].provider, 'multimovies');
    // Telugu-first ranking puts it on top.
    assert.ok(second.streams[0].lastKnownGood);
});

test('a failed playback report on the kept row evicts it', async () => {
    teluguLive = false;
    const r = await report({ tmdbId: 579974, type: 'movie', provider: 'multimovies', playedOk: false, reason: 'HTTP 403',
        mediaIdentity: 'cdn-multimovies.example/te/master.m3u8' });
    assert.strictEqual(r.status, 200);
    const next = await get('/api/streams/movie/579974?refresh=1');
    assert.ok(!next.streams.some((s) => s.lastKnownGood));
});

test('a kept row that fails its check is not served', async () => {
    teluguLive = true;
    await get('/api/streams/movie/857598?refresh=1');
    teluguLive = false;
    verifyOk = false;
    try {
        const out = await get('/api/streams/movie/857598?refresh=1');
        assert.ok(!out.streams.some((s) => s.lastKnownGood));
    } finally { verifyOk = true; }
});

test('a canary-degraded MM server ranks below a healthy row of the same language', async () => {
    teluguLive = false;
    mmState.setCanary('Vidbolt', { state: 'degraded', reason: 'test', extractor: 'multimovies' });
    try {
        const out = await get('/api/streams/movie/1111?refresh=1');
        const en = out.streams.filter((s) => !s.lastKnownGood).map((s) => s.provider);
        assert.deepStrictEqual(en, ['vidrock', 'multimovies']);
    } finally { mmState._reset(); }
});

test('/api/health carries multimovies host/servers/unknownServers, fed by observe', async () => {
    teluguLive = true;
    await get('/api/streams/movie/2222?refresh=1');
    await until(() => observed.includes('2222'));
    await until(() => mmState.snapshot().servers.Vidbolt);
    const h = await get('/api/health');
    assert.ok(h.multimovies, 'multimovies key');
    assert.ok('host' in h.multimovies);
    assert.ok(Array.isArray(h.multimovies.unknownServers));
    assert.strictEqual(h.multimovies.servers.Vidbolt.state, 'ok');
    assert.ok(h.multimovies.servers.Vidbolt.teluguCount >= 1);
});
