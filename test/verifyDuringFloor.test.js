'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// /api/streams held a ready Telugu answer until EARLY_ANSWER_FLOOR_MS (2500)
// and only THEN ran verifyTopStreams (master + variant + first bytes of the
// top rows), which added 0.3-1.0 s after the floor (apk-playback.md, RRR and
// Krack, 2026-11-22). The byte check now starts on the best rows while the
// floor runs, and again when the top changes, so the answer goes out at the
// floor. The floor itself, the rows, their order and their tags are unchanged.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plan = {};
const stream = (provider, lang, q = '1080p') => ({ provider, name: provider, title: `${provider} ${lang}`, quality: q,
    url: `https://cdn.example/${provider}/${lang}.mp4`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'netmirror', 'onetouchtv'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true,
    fetch: async (ctx) => {
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

// The byte check is REAL here. Its fetches of cdn.example are answered
// locally with 4 KB of mp4 (ftyp) after VERIFY_DELAY_MS: a stand-in for the
// upstream master/segment reads. Nothing leaves the machine.
const VERIFY_DELAY_MS = 800;
const realFetch = globalThis.fetch;
const verifyFetches = [];
const outbound = [];
function mp4Bytes() {
    const b = Buffer.alloc(4096, 0);
    b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1');
    return b;
}
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (/^http:\/\/127\.0\.0\.1:/.test(u)) return realFetch(url, opts);
    if (u.startsWith('https://cdn.example/')) {
        verifyFetches.push({ u, at: Date.now() });
        await new Promise((res, rej) => {
            const t = setTimeout(res, VERIFY_DELAY_MS);
            if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
        });
        return new Response(mp4Bytes(), { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    outbound.push(u);
    throw new Error(`outbound fetch blocked in test: ${u}`);
};
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
const fetchedOf = (id) => verifyFetches.filter((f) => f.u.includes('cdn.example')).map((f) => f.u);

test('a Telugu row ready at 300 ms: the byte check runs during the floor, answer goes out at the floor', async () => {
    verifyFetches.length = 0;
    plan[5001] = {
        castletv: async () => { await sleep(300); return [stream('CastleTV', 'Telugu')]; },
        onetouchtv: async () => { await sleep(500); return [stream('OneTouchTV', 'Hindi')]; },
        netmirror: async () => { await sleep(5000); return []; },
    };
    const first = await get(5001);
    console.log(`[measure] floor-verify first answer ${first.ms}ms (verify fetch ${VERIFY_DELAY_MS}ms)`);
    // Before: floor 2500 + one verify read 800 = ~3300 ms.
    assert.ok(first.ms >= 2400, `the floor still holds: ${first.ms}ms`);
    assert.ok(first.ms < 2900, `first answer took ${first.ms}ms`);
    assert.deepEqual(first.d.streams.map((s) => s.provider), ['CastleTV', 'OneTouchTV'], 'same rows, same order');
    assert.deepEqual(first.d.streams.map((s) => s.languages), [['Telugu'], ['Hindi']], 'same language tags');
    assert.equal(first.d.streams[0].byteCheck && first.d.streams[0].byteCheck.ok, true, 'top row carries its verdict');
    const urls = fetchedOf(5001);
    assert.equal(urls.length, new Set(urls).size, `each url read once: ${urls.join(', ')}`);
});

test('when the top changes during the floor, the new top is checked; nothing is read twice', async () => {
    verifyFetches.length = 0;
    plan[5002] = {
        castletv: async () => { await sleep(200); return [stream('CastleTV', 'Hindi')]; },
        onetouchtv: async () => { await sleep(900); return [stream('OneTouchTV', 'Telugu')]; },
        netmirror: async () => { await sleep(5000); return []; },
    };
    const first = await get(5002);
    console.log(`[measure] top-change first answer ${first.ms}ms`);
    assert.ok(first.ms >= 2400 && first.ms < 2900, `first answer took ${first.ms}ms`);
    assert.deepEqual(first.d.streams.map((s) => s.provider), ['OneTouchTV', 'CastleTV'], 'Telugu first, as before');
    assert.equal(first.d.streams[0].byteCheck && first.d.streams[0].byteCheck.ok, true);
    const urls = fetchedOf(5002);
    assert.ok(urls.includes('https://cdn.example/OneTouchTV/Telugu.mp4'));
    assert.equal(urls.length, new Set(urls).size, `each url read once: ${urls.join(', ')}`);
});

test('makes no outbound network call', () => {
    assert.deepStrictEqual(outbound, []);
});
