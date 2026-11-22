'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Gap 11.8 (scenario-matrix.md): a client reports a row failed. The VM must
// stop serving that provider's kept row for the title to every client: the
// next /api/streams asks that provider again. Other providers stay cached.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const calls = {};
let gen = 0;
const stream = (provider, lang) => ({ provider, name: provider, title: provider, quality: '1080p',
    url: `https://cdn.example/${provider}-${lang}-${gen}.mp4`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'onetouchtv'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        const k = `${name}:${ctx.tmdbId}:${ctx.season || 0}:${ctx.episode || 0}`;
        calls[k] = (calls[k] || 0) + 1;
        return [stream(name === 'castletv' ? 'CastleTV' : 'OneTouchTV', name === 'castletv' ? 'Telugu' : 'Hindi')];
    },
}]));
stub('providers/registry.js', {
    listProviders: () => NAMES.map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
stub('lib/media/segmentVerify.js', { verifyTopStreams: async (s) => s });
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
const get = async (p) => (await fetch(`${base}${p}`)).json();
const report = (body) => fetch(`${base}/api/playback-report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a failed report drops the cached row: the next /api/streams asks that provider again', async () => {
    await get('/api/streams/movie/8801');
    const hit = await get('/api/streams/movie/8801');
    assert.equal(hit.cached, true, 'second request is a memo hit');
    assert.equal(calls['castletv:8801:0:0'], 1);
    gen = 1;
    assert.equal((await report({ tmdbId: 8801, type: 'movie', provider: 'CastleTV', playedOk: false, reason: 'HTTP 403' })).status, 200);
    const next = await get('/api/streams/movie/8801');
    assert.notEqual(next.cached, true, 'memo dropped');
    assert.equal(calls['castletv:8801:0:0'], 2, 'the failed provider was asked again');
    assert.equal(calls['onetouchtv:8801:0:0'], 1, 'other providers come from their kept rows');
    assert.ok(next.streams.some((s) => s.url.endsWith('CastleTV-Telugu-1.mp4')), 'the new row is served');
    assert.ok(next.streams.some((s) => (s.languages || []).includes('Telugu')), 'Telugu row still listed');
});

test('a success report evicts nothing; another title or episode is untouched', async () => {
    await get('/api/streams/series/8802?season=1&episode=2');
    await get('/api/streams/series/8802?season=1&episode=3');
    await report({ tmdbId: 8802, type: 'tv', season: 1, episode: 2, provider: 'castletv', playedOk: true, startupMs: 900 });
    assert.equal((await get('/api/streams/series/8802?season=1&episode=2')).cached, true);
    await report({ tmdbId: 8802, type: 'tv', season: 1, episode: 2, provider: 'castletv', playedOk: false, reason: 'switch: no response in 8s' });
    assert.equal((await get('/api/streams/series/8802?season=1&episode=3')).cached, true, 'episode 3 kept');
    await get('/api/streams/series/8802?season=1&episode=2');
    assert.equal(calls['castletv:8802:1:2'], 2);
    assert.equal(calls['castletv:8802:1:3'], 1);
});
