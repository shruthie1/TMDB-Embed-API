'use strict';
// One /api/streams request runs MultiMovies once. Prod 2026-11-24 [47d21642]
// 811941: the fan-out ran multimovies (partial, 3.2 s), then gdmirror's linked
// resolver asked for the VidBolt child after that run had ended. A partial is
// not cached and the in-flight entry was gone, so MM ran a second time and
// re-asked every VidBolt server (the quasar 429 the day before came from such
// a second run).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

const calls = { multimovies: 0, gdmirror: 0 };
const row = (provider, lang, file) => ({ provider, name: provider, title: provider, quality: '1080p',
    url: `https://cdn-${provider}.example/${file}/master.m3u8`, container: 'hls', languages: [lang] });
let mmDone;
const fake = {
    multimovies: { name: 'multimovies', enabled: true, fetch: async () => {
        calls.multimovies++;
        const out = [row('multimovies', 'Telugu', `te${calls.multimovies}`)];
        out.upstreamError = 'multimovies vidbolt server(s) not heard: quasar(paused 429)';
        setImmediate(() => mmDone && mmDone());
        return out;
    } },
    gdmirror: { name: 'gdmirror', enabled: true, fetch: async (ctx) => {
        calls.gdmirror++;
        // Ask for the VidBolt child only after the fan-out's own MM run ended.
        await new Promise((r) => { mmDone = r; });
        await new Promise((r) => setTimeout(r, 30));
        const rows = await require('../lib/mmhub/resolveContext').resolve('multimovies', ctx).catch(() => []);
        return rows.map((r) => ({ ...r, provider: 'gdmirror', url: r.url.replace('cdn-', 'gd-') }))
            .concat([row('gdmirror', 'Hindi', 'hi')]);
    } },
};
stub('providers/registry.js', {
    listProviders: () => Object.keys(fake).map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
stub('lib/media/segmentVerify.js', {
    verifyTopStreams: async (s) => s,
    verifyOne: async () => ({ ok: true, container: 'ts' }),
    cachedVerify: async () => ({ ok: true, container: 'ts' }),
});
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt8178634' });
require('../lib/mmhub/hub')._setReader(async () => ({ servers: [] }));
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('a linked provider asking for the VidBolt child after a partial MM run reuses that run', async () => {
    const res = await (await fetch(`${base}/api/streams/movie/811941?refresh=1`)).json();
    assert.strictEqual(calls.gdmirror, 1);
    assert.strictEqual(calls.multimovies, 1, 'multimovies ran once for one request');
    assert.ok(res.streams.some((s) => s.provider === 'multimovies'), 'MM rows still served');
});
