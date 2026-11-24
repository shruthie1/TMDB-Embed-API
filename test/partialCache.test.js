'use strict';
// A late partial provider answer is cached for 5 min. Prod 2026-11-24 811941:
// MultiMovies came back partial (VidBolt servers cut/paused) after the
// response grace; the log said it "will be cached for the next request", but
// partials were never cached, so the next request reran MM from scratch
// (~9.5 s, re-asking every VidBolt server).
process.env.PRIMARY_PROVIDERS = 'vidrock';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

const calls = { multimovies: 0, vidrock: 0 };
const row = (provider, lang, file) => ({ provider, name: provider, title: provider, quality: '1080p',
    url: `https://cdn-${provider}.example/${file}/master.m3u8`, container: 'hls', languages: [lang] });
let mmSettled;
const fake = {
    vidrock: { name: 'vidrock', enabled: true, fetch: async () => {
        calls.vidrock++;
        return [row('vidrock', 'Telugu', 'te')];
    } },
    multimovies: { name: 'multimovies', enabled: true, fetch: async () => {
        calls.multimovies++;
        // Past the 2.5 s early-answer floor: this answer is late.
        await new Promise((r) => setTimeout(r, 3500));
        const out = [row('multimovies', 'Telugu', `mm${calls.multimovies}`)];
        out.upstreamError = 'multimovies vidbolt server(s) not heard: quasar(cut)';
        setTimeout(() => mmSettled && mmSettled(), 50);
        return out;
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

test('a late partial answer is served from cache on the next request, incl. ?full=1; ?refresh=1 bypasses', async () => {
    const done = new Promise((r) => { mmSettled = r; });
    const first = await (await fetch(`${base}/api/streams/movie/811941?refresh=1`)).json();
    assert.strictEqual(calls.multimovies, 1);
    assert.ok(!first.streams.some((s) => s.provider === 'multimovies'), 'MM was late on the first answer');
    await done;

    const second = await (await fetch(`${base}/api/streams/movie/811941`)).json();
    assert.strictEqual(calls.multimovies, 1, 'second request made 0 new MM invocations');
    assert.ok(second.streams.some((s) => s.provider === 'multimovies'), 'cached partial MM rows served');
    assert.ok((second.providerErrors || []).includes('multimovies'), 'cached partial still reported as partial');

    const full = await (await fetch(`${base}/api/streams/movie/811941?full=1`)).json();
    assert.strictEqual(calls.multimovies, 1, '?full=1 made 0 new MM invocations');
    assert.ok(full.streams.some((s) => s.provider === 'multimovies'));

    const single = await (await fetch(`${base}/api/streams/multimovies/movie/811941`)).json();
    assert.strictEqual(calls.multimovies, 1, 'single-provider route reads the cached partial');
    assert.ok(single.providerError, 'single-provider route reports the partial');

    const again = new Promise((r) => { mmSettled = r; });
    await (await fetch(`${base}/api/streams/movie/811941?refresh=1&full=1`)).json();
    await again;
    assert.strictEqual(calls.multimovies, 2, '?refresh=1 asks MM again');
});
