'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Audit 11-24: vidrift "orionStreams null" is thrown marked titleEmpty, but
// the fan-out catch recorded it as a breaker miss: 99 such errors over 21
// titles made both vidrift trips. A titleEmpty error must not count; a plain
// error still must.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const plan = {};
const fake = {
    vidrift: { name: 'vidrift', enabled: true, fetch: async (ctx) => plan[ctx.tmdbId]() },
};
stub('providers/registry.js', {
    listProviders: () => [{ name: 'vidrift', enabled: true }],
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

test('titleEmpty errors across distinct titles do not trip the breaker', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD + 2; i++) {
        const id = 9100 + i;
        plan[id] = () => { throw Object.assign(new Error('orionStreams null'), { titleEmpty: true }); };
        await get(id);
    }
    assert.equal(breakerOpen('vidrift'), false);
    assert.equal(metrics.providerHealth.vidrift.consecutiveMisses || 0, 0);
    assert.equal(metrics.providerHealth.vidrift.error, BREAKER_THRESHOLD + 2, 'still recorded as errors');
});

test('plain errors across distinct titles still trip it', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) {
        const id = 9200 + i;
        plan[id] = () => { throw new Error('HTTP 502'); };
        await get(id);
    }
    assert.equal(breakerOpen('vidrift'), true);
});
