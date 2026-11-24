'use strict';
// Part B items 1 (observe), 4 (per-server canary), 7 (learned ranking), 8 (health).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../utils/store');
const state = require('../lib/mmhub/state');
const hub = require('../lib/mmhub/hub');
const canary = require('../lib/mmhub/canary');
const ranking = require('../lib/mmhub/ranking');

beforeEach(() => { state._reset(); ranking._reset(); });

const te = (url) => ({ provider: 'insertunit', url, languages: ['Telugu'], audio: [{ language: 'Telugu' }] });
const ru = (url) => ({ provider: 'insertunit', url, languages: ['Russian'], audio: [{ language: 'Russian' }] });
const servers = [
    { name: 'Vidbolt', host: 'vidbolt.xyz', known: true, extractor: 'multimovies' },
    { name: 'GD mirror', host: 'streams.iqsmartgames.com', known: true, extractor: 'insertunit' },
    { name: 'Cineverse', host: 'rozgarlelo.modiplay.xyz', known: true, extractor: null },
];

test('observe: per-server rows, Telugu count and errors land on health', async () => {
    const by = new Map([['multimovies', { rows: [ru('a')] }], ['insertunit', { rows: [te('b'), ru('c')] }]]);
    await hub.observe({ tmdbId: 579974, type: 'movie' }, by, { read: async () => ({ servers }) });
    const snap = state.snapshot();
    assert.strictEqual(snap.servers.Vidbolt.state, 'ok');
    assert.strictEqual(snap.servers.Vidbolt.teluguCount, 0);
    assert.strictEqual(snap.servers['GD mirror'].teluguCount, 1);
    assert.ok(snap.servers['GD mirror'].lastOk);
    assert.ok(!('Cineverse' in snap.servers) || snap.servers.Cineverse.state === 'unknown');
    const by2 = new Map([['insertunit', { rows: [], err: 'HTTP 503' }]]);
    await hub.observe({ tmdbId: 579974, type: 'movie' }, by2, { read: async () => ({ servers }) });
    assert.strictEqual(state.snapshot().servers['GD mirror'].state, 'down');
    assert.strictEqual(state.snapshot().servers['GD mirror'].lastErr, 'HTTP 503');
});

test('observe: no page (unknown title) records nothing and never throws', async () => {
    await hub.observe({ tmdbId: 1, type: 'movie' }, new Map(), { read: async () => null });
    await hub.observe({ tmdbId: 1, type: 'movie' }, new Map(), { read: async () => { throw new Error('boom'); } });
    assert.deepStrictEqual(state.snapshot().servers, {});
});

function mkCanary(s, rowsFor, extra = {}) {
    const logs = [];
    let now = 1_000_000_000;
    const c = canary.createMmCanary({
        store: s,
        servers: () => [{ name: 'GD mirror', extractor: 'insertunit' }],
        titles: () => [{ tmdbId: '579974', type: 'movie', label: 'RRR' }],
        resolve: async (extractor, t) => rowsFor(extractor, t),
        verify: async () => ({ ok: true }),
        rowSeconds: async () => 185 * 60,
        runtimeMinutes: async () => 187,
        now: () => now,
        log: (l) => logs.push(l),
        ...extra,
    });
    return { c, logs, advance: (ms) => { now += ms; }, at: () => now };
}

test('canary: pass -> ok, next run in 6 h, Telugu remembered', async () => {
    const s = store.openStore(':memory:');
    const k = mkCanary(s, () => [te('https://x/m.m3u8')]);
    await k.c.runDue();
    assert.strictEqual(state.snapshot().servers['GD mirror'].state, 'ok');
    const row = s.canaryGet('mm:insertunit');
    assert.strictEqual(row.state, 'ok');
    assert.strictEqual(row.next_due_at, k.at() + 6 * 3600e3);
    assert.strictEqual(s.canaryGet('mm:insertunit:579974').telugu_ok, 1);
});

test('canary: Telugu gone where it was present -> degraded + alert line, backoff 30 min then doubling', async () => {
    const s = store.openStore(':memory:');
    let rows = [te('https://x/m.m3u8')];
    const k = mkCanary(s, () => rows);
    await k.c.runDue();
    rows = [ru('https://x/m.m3u8')];
    k.advance(6 * 3600e3);
    await k.c.runDue();
    assert.ok(k.logs.includes('[mm-canary] GD mirror telugu missing RRR'), k.logs.join('\n'));
    assert.strictEqual(state.snapshot().servers['GD mirror'].state, 'degraded');
    const r1 = s.canaryGet('mm:insertunit');
    assert.strictEqual(r1.next_due_at, k.at() + 30 * 60e3);
    k.advance(30 * 60e3);
    await k.c.runDue();
    assert.strictEqual(s.canaryGet('mm:insertunit').next_due_at, k.at() + 60 * 60e3);
    assert.ok(state.degradedProviders().has('insertunit'));
});

test('canary: zero rows, short runtime, fake first segment each degrade', async () => {
    for (const [why, rowsFor, extra, re] of [
        ['rows', () => [], {}, /rows=0/],
        ['runtime', () => [te('u')], { rowSeconds: async () => 100 * 60 }, /runtime/],
        ['segment', () => [te('u')], { verify: async () => ({ ok: false, reason: 'segment html' }) }, /segment/],
    ]) {
        state._reset();
        const s = store.openStore(':memory:');
        const k = mkCanary(s, rowsFor, extra);
        await k.c.runDue();
        assert.strictEqual(state.snapshot().servers['GD mirror'].state, 'degraded', why);
        assert.match(s.canaryGet('mm:insertunit').last_error, re, why);
    }
});

test('canary: not due -> no resolve', async () => {
    const s = store.openStore(':memory:');
    let calls = 0;
    const k = mkCanary(s, () => { calls++; return [te('u')]; });
    await k.c.runDue();
    k.advance(60e3);
    await k.c.runDue();
    assert.strictEqual(calls, 1);
});

test('canary: hydrate restores a persisted degraded verdict onto health', async () => {
    const s = store.openStore(':memory:');
    s.canaryPut('mm:insertunit', { state: 'degraded', last_error: 'telugu missing RRR', next_due_at: 5, last_run_at: 1 });
    const k = mkCanary(s, () => []);
    k.c.hydrate();
    assert.strictEqual(state.snapshot().servers['GD mirror'].state, 'degraded');
});

test('ranking: playback outcomes per server give a bounded score; degraded is flagged', () => {
    const s = store.openStore(':memory:');
    for (let i = 0; i < 6; i++) s.recordPlayback({ tmdbId: 100 + i, type: 'movie', provider: 'insertunit', ok: true });
    for (let i = 0; i < 6; i++) s.recordPlayback({ tmdbId: 200 + i, type: 'movie', provider: 'vidout', ok: false, reason: 'x' });
    const good = ranking.serverScore('insertunit', { store: s });
    const bad = ranking.serverScore('vidout', { store: s });
    assert.ok(good > 0 && good <= 0.5, String(good));
    assert.ok(bad < 0 && bad >= -0.5, String(bad));
    assert.strictEqual(ranking.serverScore('castletv', { store: s }), 0, 'not an MM server');
    state.setCanary('GD mirror', { state: 'degraded', extractor: 'insertunit' });
    assert.strictEqual(ranking.isDegraded('insertunit'), true);
    assert.strictEqual(ranking.isDegraded('vidout'), false);
});
