'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Krack 784572, laptop 2026-11-22: multimovies had a Telugu row at 2440 ms,
// but the answer waited for the Castle gate cap (3000 ms), then the 400 ms
// grace, and went out at 4.25 s. Castle was still late at that point, so the
// wait bought nothing for the first answer.
// Now: once a non-gated provider has a Telugu row, the answer no longer
// waits on the Castle gate. It goes out at EARLY_ANSWER_FLOOR_MS (2500) with
// whatever is ready; a Castle that lands before the floor is in it, with its
// demux. The gate still decides NetMirror exactly as before (Castle result
// or the 3000 ms cap), so NetMirror is never called more often.
// With no Telugu row elsewhere, nothing changes: the gate holds the answer.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const startedAt = {};
const plan = {};
const t0s = {};
const stream = (provider, lang) => ({ provider, name: provider, title: `${provider} ${lang}`, quality: '1080p',
    url: `https://cdn.example/${provider}/${lang}.mp4`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'netmirror', 'multimovies'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
        const k = `${name}:${ctx.tmdbId}`;
        calls[k] = (calls[k] || 0) + 1;
        if (!(k in startedAt)) startedAt[k] = Date.now() - (t0s[ctx.tmdbId] || Date.now());
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
delete process.env.CASTLE_GATE_MAX_MS;
delete process.env.EARLY_ANSWER_FLOOR_MS;
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return realFetch(url, opts);
    outbound.push(u);
    return Promise.reject(new Error(`outbound fetch blocked in test: ${u}`));
};
stub('lib/media/segmentVerify.js', { ...require('../lib/media/segmentVerify'), verifyTopStreams: async (s) => s, prewarmTopStreams: () => [] });
// Castle demux: a Telugu+Hindi audio menu when a Castle row says "demux".
const realRepublish = require('../lib/media/republish');
stub('lib/media/republish.js', { ...realRepublish,
    buildCastleDemuxEntry: async (rows) => (rows.some((r) => r.__demux)
        ? { name: 'CastleTV (Telugu, Hindi)', language: 'Telugu', quality: '1080p', provider: 'CastleTV',
            url: 'http://127.0.0.1/castle-demux/x/master.m3u8', languages: ['Telugu', 'Hindi'] }
        : null) });
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
async function get(id, q = '') {
    if (!(id in t0s)) t0s[id] = Date.now();
    const t0 = Date.now();
    const r = await fetch(`${base}/api/streams/movie/${id}${q}`);
    return { ms: Date.now() - t0, d: await r.json() };
}
const provs = (d) => d.streams.map((s) => s.provider);

test('Krack shape: Telugu elsewhere, Castle past the gate cap: answer at the floor, Castle on full=1', async () => {
    plan[8001] = {
        multimovies: async () => { await sleep(300); return [stream('MultiMovies', 'Telugu')]; },
        castletv: async () => { await sleep(3600); return [stream('CastleTV', 'Telugu')]; },
        netmirror: async () => { await sleep(500); return [stream('NetMirror', 'Hindi')]; },
    };
    const first = await get(8001);
    console.log(`[measure] castle-past-cap first answer ${first.ms}ms`);
    assert.ok(first.ms >= 2400 && first.ms < 2900, `first answer took ${first.ms}ms (floor 2500)`);
    assert.ok(provs(first.d).includes('MultiMovies'));
    assert.equal(first.d.partial, true, 'Castle still running: partial, so clients follow with full=1');
    const full = await get(8001, '?full=1');
    assert.ok(provs(full.d).includes('CastleTV'), 'Castle rows arrive on the follow-up');
    assert.equal(calls['castletv:8001'], 1, 'the follow-up joins the running Castle call');
    // NetMirror still waits for the gate decision: Castle not done at the cap.
    assert.equal(calls['netmirror:8001'], 1);
    assert.ok(startedAt['netmirror:8001'] >= 2900, `netmirror started at ${startedAt['netmirror:8001']}ms, expected the 3000 ms cap`);
});

test('Castle lands before the floor: it is in the first answer, with its demux', async () => {
    plan[8002] = {
        multimovies: async () => { await sleep(300); return [stream('MultiMovies', 'Telugu')]; },
        castletv: async () => { await sleep(1500); return [{ ...stream('CastleTV', 'Telugu'), __demux: true }]; },
        netmirror: async () => { await sleep(500); return [stream('NetMirror', 'Telugu')]; },
    };
    const first = await get(8002);
    console.log(`[measure] castle-before-floor first answer ${first.ms}ms`);
    assert.ok(first.ms < 2900, `first answer took ${first.ms}ms`);
    assert.ok(provs(first.d).includes('CastleTV'));
    assert.ok(first.d.streams.some((s) => /castle-demux/.test(s.url) || (s.languages || []).includes('Hindi')),
        'the demux audio menu row is present');
    // Demux covers Telugu: the gate skips NetMirror, exactly as before.
    assert.equal(calls['netmirror:8002'], undefined, 'NetMirror is not called when Castle demux has Telugu');
});

test('Castle without Telugu demux before the floor: NetMirror starts when Castle answers, not earlier', async () => {
    plan[8003] = {
        multimovies: async () => { await sleep(200); return [stream('MultiMovies', 'Telugu')]; },
        castletv: async () => { await sleep(1000); return [stream('CastleTV', 'Hindi')]; },
        netmirror: async () => { await sleep(300); return [stream('NetMirror', 'Telugu')]; },
    };
    await get(8003);
    assert.equal(calls['netmirror:8003'], 1);
    assert.ok(startedAt['netmirror:8003'] >= 900, `netmirror started at ${startedAt['netmirror:8003']}ms, expected after Castle (1000 ms)`);
});

test('no Telugu row anywhere but Castle: the gate still holds the answer (unchanged)', async () => {
    plan[8004] = {
        multimovies: async () => { await sleep(200); return [stream('MultiMovies', 'Hindi')]; },
        castletv: async () => { await sleep(2800); return [stream('CastleTV', 'Telugu')]; },
        netmirror: async () => { await sleep(300); return []; },
    };
    const first = await get(8004);
    console.log(`[measure] no-early-telugu first answer ${first.ms}ms`);
    assert.ok(provs(first.d).includes('CastleTV'), 'the only Telugu row is in the first answer');
    assert.ok(first.ms >= 2700, `first answer took ${first.ms}ms`);
});

test('makes no outbound network call', () => {
    assert.deepStrictEqual(outbound, []);
});
