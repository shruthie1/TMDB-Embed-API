'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// G1: POST /api/playback-report feeds source_stats, and the aggregate route
// reorders WITHIN a language group from it. Telugu stays the primary key.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const stream = (provider, lang, quality, file) => ({ provider, name: provider, title: `${provider} ${lang}`,
    quality, url: `https://cdn.example/${file}.mp4?sig=${Math.random()}`, container: 'mp4', languages: [lang] });
const NAMES = ['castletv', 'netmirror', 'onetouchtv'];
const rows = {
    castletv: () => [stream('CastleTV', 'Telugu', '1080p', 'castle-te')],
    netmirror: () => [stream('NetMirror', 'Telugu', '1080p', 'nm-te')],
    // Higher quality, wrong language: must never jump the Telugu group.
    onetouchtv: () => [stream('OneTouchTV', 'Hindi', '2160p', 'ott-hi')],
};
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true, fetch: async () => rows[name](),
}]));
stub('providers/registry.js', {
    listProviders: () => NAMES.map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
// Byte verification is another layer (lib/media/segmentVerify.js); keep it
// out of this test so the order seen is the learning layer's alone.
stub('lib/media/segmentVerify.js', { verifyTopStreams: async (s) => s });
process.env.PRIMARY_PROVIDERS = 'castletv,netmirror';
process.env.PREFERRED_AUDIO_LANGUAGE = 'Telugu';
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });
const app = require('../apiServer');
const { getStore } = require('../utils/store');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const report = (body) => fetch(`${base}/api/playback-report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const order = async (id) => {
    const d = await (await fetch(`${base}/api/streams/movie/${id}`)).json();
    return { providers: d.streams.map((s) => s.provider), cached: Boolean(d.cached), count: d.count };
};

test('sink refuses unkeyable reports', async () => {
    assert.strictEqual((await report({ provider: 'castletv' })).status, 400);
    assert.strictEqual((await report({ tmdbId: -4, provider: 'castletv' })).status, 400);
    assert.strictEqual((await report({ tmdbId: 'abc', provider: 'castletv' })).status, 400);
    assert.strictEqual((await report({ tmdbId: 5, provider: '<script>' })).status, 400);
    assert.strictEqual((await report({ tmdbId: 5 })).status, 400);
});

test('sink clamps every numeric field', async () => {
    const r = await report({ tmdbId: 4242, type: 'movie', provider: 'CastleTV', playedOk: true,
        startupMs: 1e12, stallCount: 1e9, stallMs: -50, recoveryCount: 'lots', waitMs: 'x',
        device: 'd'.repeat(500), audioLang: 'Telugu<script>' });
    assert.strictEqual(r.status, 200);
    const row = getStore().sourceStatsFor({ tmdbId: 4242, type: 'movie' })[0];
    assert.strictEqual(row.provider, 'castletv');
    // A4: a startup over 120 s (VM max 687390 ms, a backgrounded app) is an
    // outlier, stored as null, not as a real startup.
    assert.strictEqual(row.startup_ms, null);
    assert.strictEqual(row.stall_count, 1000);
    assert.strictEqual(row.stall_ms, 0);
    assert.strictEqual(row.recovery_count, 0);
    assert.strictEqual(row.wait_ms, 0);
    assert.strictEqual(row.play_device.length, 24);
    assert.strictEqual(row.audio_lang, null, 'a non-language string is not stored');
    assert.ok(row.played_ok_at > 0);
});

test('A4: startupMs over 120000 or negative is stored as null; in range is kept', async () => {
    const cases = [[120001, null], [687390, null], [-5, null], [120000, 120000], [3179, 3179]];
    for (const [i, [sent, want]] of cases.entries()) {
        const id = 4300 + i;
        assert.strictEqual((await report({ tmdbId: id, type: 'movie', provider: 'castletv', playedOk: true, startupMs: sent })).status, 200);
        const row = getStore().sourceStatsFor({ tmdbId: id, type: 'movie' })[0];
        assert.strictEqual(row.startup_ms, want, `startupMs ${sent}`);
    }
});

test('a langOk=false report writes viewer evidence keyed on the media identity', async () => {
    const mediaUrl = `/m3u8-proxy?url=${encodeURIComponent('https://cdn.example/v/one.mp4?sig=abc')}`;
    await report({ tmdbId: 4243, type: 'movie', provider: 'netmirror', playedOk: true, mediaUrl,
        audioLang: 'Telugu', langOk: false });
    const ev = getStore().audioEvidenceFor('cdn.example/v/one.mp4');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].source, 'viewer');
    assert.strictEqual(ev[0].lang, 'Telugu');
    assert.strictEqual(ev[0].refuted, 1);
    // No langOk -> no evidence at all, even with an audioLang.
    await report({ tmdbId: 4243, type: 'movie', provider: 'netmirror', playedOk: true,
        mediaUrl: 'https://cdn.example/v/two.mp4', audioLang: 'Telugu' });
    assert.strictEqual(getStore().audioEvidenceFor('cdn.example/v/two.mp4').length, 0);
});

test('play_fails >= 2 sinks a row inside the Telugu group; Telugu stays first; a fail report drops the memo (11.8)', async () => {
    const id = 7001;
    const before = await order(id);
    assert.strictEqual(before.count, 3);
    assert.deepStrictEqual(before.providers.slice(2), ['OneTouchTV'], 'Hindi 2160p stays below Telugu 1080p');
    const top = before.providers[0];
    const other = before.providers[1];

    // One failure is a bad moment on someone's wifi: no change.
    await report({ tmdbId: id, type: 'movie', provider: top, playedOk: false, reason: 'stall' });
    let after = await order(id);
    assert.notStrictEqual(after.cached, true, 'a failed report drops the memo (gap 11.8)');
    assert.deepStrictEqual(after.providers, before.providers);

    // Second failure sinks it - below the other Telugu row, never below Hindi.
    await report({ tmdbId: id, type: 'movie', provider: top, playedOk: false, reason: 'stall' });
    after = await order(id);
    assert.notStrictEqual(after.cached, true, 'a failed report drops the memo (gap 11.8)');
    assert.deepStrictEqual(after.providers, [other, top, 'OneTouchTV']);
    assert.strictEqual(after.count, 3, 'nothing dropped');

    // A success clears the failures; a browser-confirmed row outranks an
    // unconfirmed one of the same language.
    await report({ tmdbId: id, type: 'movie', provider: top, playedOk: true, startupMs: 900 });
    after = await order(id);
    assert.strictEqual(after.cached, true, 'a success report keeps the memo, and the memo hit re-ranks');
    assert.deepStrictEqual(after.providers, [top, other, 'OneTouchTV']);
});

test('browser confirmation never lifts a Hindi row above Telugu', async () => {
    const id = 7002;
    await report({ tmdbId: id, type: 'movie', provider: 'OneTouchTV', playedOk: true, startupMs: 100 });
    await report({ tmdbId: id, type: 'movie', provider: 'CastleTV', playedOk: false });
    await report({ tmdbId: id, type: 'movie', provider: 'CastleTV', playedOk: false });
    await report({ tmdbId: id, type: 'movie', provider: 'NetMirror', playedOk: false });
    await report({ tmdbId: id, type: 'movie', provider: 'NetMirror', playedOk: false });
    const { providers } = await order(id);
    assert.strictEqual(providers[2], 'OneTouchTV', 'both Telugu rows sank, still above Hindi');
});

test('one runtime-mismatch report sinks a confirmed row inside the Telugu group', async () => {
    // Krack 784572: a truncated Castle Telugu file (102.5m vs 154m) was
    // confirmed before runtimeMin loaded and ranked first on every visit.
    const id = 7003;
    const before = await order(id);
    const top = before.providers[0];
    const other = before.providers[1];
    await report({ tmdbId: id, type: 'movie', provider: top, playedOk: true, startupMs: 500 });
    let after = await order(id);
    assert.deepStrictEqual(after.providers, [top, other, 'OneTouchTV'], 'confirmed row leads');

    await report({ tmdbId: id, type: 'movie', provider: top, playedOk: false,
        reason: 'runtime mismatch (103m vs 154m)' });
    after = await order(id);
    assert.deepStrictEqual(after.providers, [other, top, 'OneTouchTV'],
        'sinks on the first report, still above Hindi');
    assert.strictEqual(after.count, 3, 'nothing dropped');
});

test('one ordinary failure on a confirmed row does not sink it', async () => {
    const id = 7004;
    const before = await order(id);
    const top = before.providers[0];
    const other = before.providers[1];
    await report({ tmdbId: id, type: 'movie', provider: other, playedOk: true, startupMs: 500 });
    await report({ tmdbId: id, type: 'movie', provider: other, playedOk: false, reason: 'stall' });
    const after = await order(id);
    assert.deepStrictEqual(after.providers, [other, top, 'OneTouchTV']);
});
