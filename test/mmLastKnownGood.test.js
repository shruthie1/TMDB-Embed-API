'use strict';
// Part B item 6: last-known-good Telugu rows (lib/mmhub/lastKnownGood.js and
// the store table behind it).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../utils/store');
const lkg = require('../lib/mmhub/lastKnownGood');

const tmpFile = (ext = 'sqlite') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lkg-')), `learning.${ext}`);
const T = { tmdbId: 579974, type: 'movie', season: null, episode: null };
const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 10, 24, 15, 0, 0);
const teRow = (url, extra = {}) => ({ provider: 'multimovies', url, languages: ['Telugu'],
    audio: [{ language: 'Telugu', languageCode: 'te' }], quality: '1080p', headers: { Referer: 'https://vidbolt.xyz/' }, ...extra });
const enRow = (url) => ({ provider: 'vidrock', url, languages: ['English'], audio: [], quality: '1080p' });
// Expiry in seconds, the `e=` form lib/urlExpiry.js reads.
const signed = (host, expMs) => `https://${host}/a/master.m3u8?e=${Math.floor(expMs / 1000)}&sig=x`;

for (const backend of ['sqlite', 'json']) {
    test(`${backend}: lkgPut / lkgFor / lkgEvict round trip, survives reopen`, () => {
        const file = tmpFile();
        let s = store.openStore(file, { backend });
        s.lkgPut({ ...T, provider: 'multimovies', mediaIdentity: 'cdn.example/a/master.m3u8',
            row: teRow('u1'), expiresAt: NOW + HOUR, storedAt: NOW });
        assert.strictEqual(s.lkgFor(T, NOW).length, 1);
        s.close();
        s = store.openStore(file, { backend });
        const got = s.lkgFor(T, NOW);
        assert.strictEqual(got.length, 1);
        assert.deepStrictEqual(got[0].row.languages, ['Telugu']);
        assert.strictEqual(got[0].expiresAt, NOW + HOUR);
        // Past expiry: gone from reads.
        assert.strictEqual(s.lkgFor(T, NOW + 2 * HOUR).length, 0);
        assert.strictEqual(s.lkgEvict(T, 'multimovies', 'cdn.example/a/master.m3u8'), 1);
        assert.strictEqual(s.lkgFor(T, NOW).length, 0);
        s.close();
    });
}

test('remember: stores Telugu rows only, expiry from the URL, 24 h cap when none stated', () => {
    const s = store.openStore(':memory:');
    const rows = [
        teRow(signed('cdn1.example', NOW + 3 * 24 * HOUR)),
        teRow('https://cdn2.example/b/master.m3u8', { provider: 'insertunit' }),
        enRow('https://cdn3.example/c/master.m3u8'),
    ];
    const n = lkg.remember(T, rows, { store: s, now: NOW });
    assert.strictEqual(n, 2);
    const got = s.lkgFor(T, NOW);
    const byProv = Object.fromEntries(got.map((g) => [g.provider, g]));
    assert.strictEqual(byProv.multimovies.expiresAt, Math.floor((NOW + 3 * 24 * HOUR) / 1000) * 1000);
    assert.strictEqual(byProv.insertunit.expiresAt, NOW + 24 * HOUR);
    assert.ok(!got.some((g) => g.provider === 'vidrock'));
});

test('remember: skips expired, local (own server), failed-bytes and lastKnownGood rows', () => {
    const s = store.openStore(':memory:');
    const rows = [
        teRow(signed('cdn1.example', NOW - HOUR)),
        teRow('https://api.local/castle-demux/x/master.m3u8'),
        teRow('https://cdn4.example/d/master.m3u8', { byteCheck: { ok: false, reason: 'html' } }),
        teRow('https://cdn5.example/e/master.m3u8', { lastKnownGood: true }),
    ];
    assert.strictEqual(lkg.remember(T, rows, { store: s, now: NOW, skipPrefix: 'https://api.local' }), 0);
});

test('serve: nothing when the live answer already has Telugu', async () => {
    const s = store.openStore(':memory:');
    lkg.remember(T, [teRow('https://cdn2.example/b/master.m3u8')], { store: s, now: NOW });
    let calls = 0;
    const out = await lkg.serveIfMissing(T, [teRow('https://cdn9.example/z/master.m3u8')],
        { store: s, now: NOW, verify: async () => { calls++; return { ok: true }; } });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(calls, 0);
});

test('serve: verified row comes back tagged lastKnownGood with its original language tags', async () => {
    const s = store.openStore(':memory:');
    lkg.remember(T, [teRow('https://cdn2.example/b/master.m3u8')], { store: s, now: NOW });
    const out = await lkg.serveIfMissing(T, [enRow('https://cdn3.example/c/master.m3u8')],
        { store: s, now: NOW + HOUR, verify: async () => ({ ok: true, container: 'ts' }) });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].lastKnownGood, true);
    assert.deepStrictEqual(out[0].languages, ['Telugu']);
    assert.deepStrictEqual(out[0].audio, [{ language: 'Telugu', languageCode: 'te' }]);
    assert.strictEqual(out[0].url, 'https://cdn2.example/b/master.m3u8');
    assert.deepStrictEqual(out[0].headers, { Referer: 'https://vidbolt.xyz/' });
    assert.strictEqual(out[0].lastKnownGoodAt, NOW);
});

test('serve: a failed check evicts the row and serves nothing', async () => {
    const s = store.openStore(':memory:');
    lkg.remember(T, [teRow('https://cdn2.example/b/master.m3u8')], { store: s, now: NOW });
    const out = await lkg.serveIfMissing(T, [], { store: s, now: NOW, verify: async () => ({ ok: false, reason: 'http 403' }) });
    assert.deepStrictEqual(out, []);
    assert.strictEqual(s.lkgFor(T, NOW).length, 0);
});

test('serve: a row whose media is already live is not duplicated', async () => {
    const s = store.openStore(':memory:');
    lkg.remember(T, [teRow('https://cdn2.example/b/master.m3u8?e=1&x=1')], { store: s, now: NOW });
    const live = [{ ...enRow('https://cdn2.example/b/master.m3u8?other=2'), provider: 'multimovies' }];
    const out = await lkg.serveIfMissing(T, live, { store: s, now: NOW, verify: async () => ({ ok: true }) });
    assert.deepStrictEqual(out, []);
});

test('evictReported: a playback failure on a served row drops it', () => {
    const s = store.openStore(':memory:');
    lkg.remember(T, [teRow('https://cdn2.example/b/master.m3u8')], { store: s, now: NOW });
    const n = lkg.evictReported({ tmdbId: 579974, type: 'movie', season: 0, episode: 0, provider: 'MultiMovies',
        mediaIdentity: 'cdn2.example/b/master.m3u8' }, { store: s });
    assert.strictEqual(n, 1);
    assert.strictEqual(s.lkgFor(T, NOW).length, 0);
});

test('remember: keeps at most 3 rows per title', () => {
    const s = store.openStore(':memory:');
    const rows = [1, 2, 3, 4, 5].map((i) => teRow(`https://cdn${i}.example/m/master.m3u8`, { provider: `p${i}` }));
    lkg.remember(T, rows, { store: s, now: NOW });
    assert.strictEqual(s.lkgFor(T, NOW).length, 3);
});
