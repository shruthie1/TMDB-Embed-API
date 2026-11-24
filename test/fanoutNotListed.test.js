'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Prod 2026-11-24 15:07 UTC: vidout answered "not in catalogue" (GitHub 404)
// for five distinct titles in a row. Each counted as a breaker miss, the
// breaker tripped, and Pushpa 2 (vidout's tagged Telugu master) was skipped
// for 10 minutes. A provider's own "not listed" answer must not count.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const row = (provider) => ({ provider, name: provider, title: `${provider} 1`, quality: '1080p',
    url: `https://cdn.example/${provider}/1.m3u8`, container: 'hls', languages: ['Telugu'] });
const plan = {}; // plan[tmdbId] = () => result
const fake = {
    vidout: { name: 'vidout', enabled: true, fetch: async (ctx) => (plan[ctx.tmdbId] ? plan[ctx.tmdbId]() : []) },
};
stub('providers/registry.js', {
    listProviders: () => [{ name: 'vidout', enabled: true }],
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });

const { BREAKER_THRESHOLD, breakerOpen, metrics } = require('../lib/runtime/metrics');
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const get = async (id) => (await fetch(`${base}/api/streams/movie/${id}?refresh=1`)).json();

test('notListed empties across distinct titles do not trip the breaker', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD + 2; i++) {
        const id = 7100 + i;
        plan[id] = () => Object.assign([], { notListed: true });
        await get(id);
    }
    assert.equal(breakerOpen('vidout'), false);
    assert.equal(metrics.providerHealth.vidout.consecutiveMisses || 0, 0);
    plan[7199] = () => [row('vidout')];
    const d = await get(7199);
    assert.equal(d.streams.filter((s) => s.provider === 'vidout').length, 1);
});

test('plain empties across distinct titles still trip it', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
        const id = 7200 + i;
        plan[id] = () => [];
        await get(id);
    }
    assert.equal(breakerOpen('vidout'), true);
});
