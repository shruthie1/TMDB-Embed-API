'use strict';
// A5 (VM 2026-11-22): source_stats had `784572 castletv mobile "runtime
// mismatch (102m vs 154m)"`, 5 fails, while the canary passed castletv on
// 27205 and 784572: it checked rows only. The castletv canary now measures
// each row's duration against the TMDB runtime with the client's rule
// (PlayPolicy.runtimeVerdict: duration >= 0.82 x runtime).
const { test } = require('node:test');
const assert = require('node:assert');
const { createCanary, runtimeVerdict } = require('../lib/selfheal/canary');
const { openStore } = require('../utils/store');
const { classify } = require('../lib/selfheal/classify');

const RUNTIME = { 27205: 148, 784572: 154 };

function run(name, rowsByTitle, secondsByUrl) {
    const store = openStore(':memory:');
    const lines = [];
    const measured = [];
    const canary = createCanary({
        providers: () => [{ name, enabled: true, resolve: async (id) => rowsByTitle[String(id)] || [] }],
        store,
        classify: (input) => classify(input),
        heal: async () => ({ applied: false }),
        recordOutcome: () => {},
        now: () => Date.UTC(2026, 10, 24, 12),
        log: (l) => lines.push(l),
        rowSeconds: async (row) => { measured.push(row.url); const s = secondsByUrl[row.url]; if (s instanceof Error) throw s; return s ?? null; },
        runtimeMinutes: async (id) => RUNTIME[String(id)] || null,
    });
    return { canary, store, lines, measured };
}

test('client rule: 0.82 x runtime', () => {
    assert.equal(runtimeVerdict(102 * 60, 154), 'mismatch');
    assert.equal(runtimeVerdict(127 * 60, 154), 'ok');
    assert.equal(runtimeVerdict(null, 154), 'unknown');
    assert.equal(runtimeVerdict(100 * 60, null), 'unknown');
});

test('a wrong-cut castletv row on Krack fails the canary as runtime mismatch', async () => {
    const s = run('castletv',
        { 27205: [{ url: 'https://c/inc.m3u8' }], 784572: [{ url: 'https://c/krack-ok.m3u8', languages: ['Telugu'] }, { url: 'https://c/krack-cut.m3u8', languages: ['Telugu'] }] },
        { 'https://c/inc.m3u8': 148 * 60, 'https://c/krack-ok.m3u8': 154 * 60, 'https://c/krack-cut.m3u8': 102 * 60 });
    await s.canary.tick();
    const row = s.store.canaryGet('castletv');
    assert.equal(row.state, 'drift');
    assert.match(row.last_error, /runtime mismatch \(102m vs 154m\) title=784572/);
    assert.ok(s.lines.some((l) => l.startsWith('[canary] fail castletv kind=drift rule=runtime')), s.lines.join('\n'));
});

test('right-length castletv rows pass; an unreadable duration is not a fail', async () => {
    const s = run('castletv',
        { 27205: [{ url: 'https://c/inc.m3u8' }], 784572: [{ url: 'https://c/k1.m3u8', languages: ['Telugu'] }, { url: 'https://c/k2.m3u8' }] },
        { 'https://c/inc.m3u8': 148 * 60, 'https://c/k1.m3u8': 153 * 60, 'https://c/k2.m3u8': new Error('HTTP 403') });
    await s.canary.tick();
    assert.equal(s.store.canaryGet('castletv').state, 'ok');
    assert.equal(s.measured.length, 3);
});

test('other providers are not runtime-checked', async () => {
    const s = run('showsst', { 27205: [{ url: 'https://c/inc.m3u8' }] }, { 'https://c/inc.m3u8': 10 * 60 });
    await s.canary.tick();
    assert.equal(s.store.canaryGet('showsst').state, 'ok');
    assert.equal(s.measured.length, 0);
});
