'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// The first /api/streams answer used to wait for every primary (castletv and
// netmirror) plus a 1.5s grace for the rest, and Castle ran ALONE before any
// other provider started. Prod p50 was 2.7s. It now:
//   - starts every provider that Castle does not gate at the same time as
//     Castle, and
//   - answers once a stream in the preferred language (Telugu) is in hand,
//     after a short FIRST_ANSWER_GRACE_MS, while the rest keep running and
//     fill the cache for the next request.
// It must still WAIT when no Telugu stream exists yet: an early answer
// without the preferred language would hide it (CLAUDE.md rule 1).
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const plan = {};
const stream = (provider, lang) => ({ provider, name: provider, title: `${provider} ${lang}`, quality: '1080p',
    url: `https://cdn.example/${provider}/${lang}.mp4`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'netmirror', 'onetouchtv'];
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
// No outbound network. The test only calls its own loopback server; every
// other fetch (e.g. a byte-check of the fake cdn.example urls) is recorded
// and refused, and the last test asserts none happened.
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return realFetch(url, opts);
    outbound.push(u);
    return Promise.reject(new Error(`outbound fetch blocked in test: ${u}`));
};
// The byte-check is covered by test/segmentVerify.test.js. Here it is a
// pass-through so the fake cdn.example urls are never fetched.
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
async function get(id) {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/streams/movie/${id}`);
    return { ms: Date.now() - t0, d: await r.json() };
}

test('answers once a Telugu stream exists, without waiting for a slow NetMirror', async () => {
    plan[3001] = {
        castletv: async () => { await sleep(300); return [stream('CastleTV', 'Telugu')]; },
        netmirror: async () => { await sleep(3000); return [stream('NetMirror', 'Hindi')]; },
    };
    const first = await get(3001);
    console.log(`[measure] telugu-early first answer ${first.ms}ms`);
    // EARLY_ANSWER_FLOOR_MS (2500) from request start; NetMirror ends ~3300.
    assert.ok(first.ms < 3000, `first answer took ${first.ms}ms`);
    assert.deepEqual(first.d.streams.map((s) => s.provider), ['CastleTV']);
    assert.equal(first.d.partial, true, 'an early answer is flagged so clients do not cache it');
    await sleep(3000);
    const second = await get(3001);
    assert.equal(second.d.partial, undefined);
    assert.deepEqual(second.d.streams.map((s) => s.provider).sort(), ['CastleTV', 'NetMirror']);
    assert.equal(calls['netmirror:3001'], 1, 'the background NetMirror result is reused, not re-fetched');
});

test('providers Castle does not gate start alongside Castle, not after it', async () => {
    plan[3002] = {
        castletv: async () => { await sleep(800); return [stream('CastleTV', 'Hindi')]; },
        onetouchtv: async () => { await sleep(800); return [stream('OneTouchTV', 'Telugu')]; },
        netmirror: async () => { await sleep(3000); return []; },
    };
    const first = await get(3002);
    console.log(`[measure] concurrent-gate first answer ${first.ms}ms`);
    assert.ok(first.ms < 3000, `first answer took ${first.ms}ms`);
    assert.ok(first.d.streams.some((s) => s.provider === 'OneTouchTV'));
});

test('with no Telugu stream yet it still waits for the primaries (no silent language loss)', async () => {
    plan[3003] = {
        castletv: async () => { await sleep(200); return [stream('CastleTV', 'Hindi')]; },
        netmirror: async () => { await sleep(1800); return [stream('NetMirror', 'Telugu')]; },
    };
    const first = await get(3003);
    console.log(`[measure] no-telugu first answer ${first.ms}ms`);
    assert.ok(first.d.streams.some((s) => s.provider === 'NetMirror' && s.languages.includes('Telugu')),
        'the Telugu NetMirror row must be in the first answer');
});

// RRR 579974, 2026-11-21: the 400 ms grace started after the castle gate, so
// multimovies (2 s settle cap) missed the first answer on every request. The
// grace now runs from request start with a 2500 ms floor.
test('early-answer grace has a 2500 ms floor from request start, so a 2 s provider makes the first answer', async () => {
    plan[3004] = {
        castletv: async () => { await sleep(400); return [stream('CastleTV', 'Telugu')]; },
        onetouchtv: async () => { await sleep(2000); return [stream('OneTouchTV', 'Hindi')]; },
        netmirror: async () => { await sleep(5000); return []; },
    };
    const first = await get(3004);
    console.log(`[measure] grace-floor first answer ${first.ms}ms`);
    assert.ok(first.ms >= 2400 && first.ms < 3200, `first answer took ${first.ms}ms`);
    assert.ok(first.d.streams.some((s) => s.provider === 'OneTouchTV'), 'the 2 s provider is in the first answer');
    assert.equal(first.d.partial, true, 'NetMirror is still running, so the answer is partial');
});

test('makes no outbound network call', () => {
    assert.deepStrictEqual(outbound, []);
});
