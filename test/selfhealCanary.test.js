'use strict';
// Provider self-heal Task 7: the canary loop and the provider_canary store.
// Fake clock, fake providers, in-memory store. No network.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCanary, HEALTHY_MS, FAILING_MS, EXCLUDED } = require('../lib/selfheal/canary');
const { openStore, MIGRATIONS } = require('../utils/store');
const { classify } = require('../lib/selfheal/classify');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TE = [{ url: 'https://x/te.m3u8', languages: ['Telugu'] }];
const EN = [{ url: 'https://x/en.m3u8', languages: ['English'] }];

function fakeProvider(name, answers = {}, opts = {}) {
    const calls = [];
    return {
        name,
        enabled: opts.enabled !== false,
        verifyTitle: opts.verifyTitle,
        calls,
        resolve: async (tmdbId) => {
            calls.push(String(tmdbId));
            const a = answers[String(tmdbId)] !== undefined ? answers[String(tmdbId)] : answers.default;
            if (typeof a === 'function') return a(calls.length);
            if (a instanceof Error) throw a;
            return a || [];
        },
    };
}

function setup(providers, extra = {}) {
    let t = Date.UTC(2026, 10, 21, 12, 0, 0);
    const store = openStore(':memory:', { backend: extra.backend });
    const outcomes = [];
    const heals = [];
    const lines = [];
    const canary = createCanary({
        providers: () => providers,
        store,
        classify: (input) => classify(input),
        heal: async (name, kind) => { heals.push([name, kind]); return extra.heal ? extra.heal(name, kind) : { applied: false }; },
        recordOutcome: (name, outcome) => outcomes.push([name, outcome]),
        now: () => t,
        log: (l) => lines.push(l),
    });
    return { canary, store, outcomes, heals, lines, advance: (ms) => { t += ms; }, now: () => t };
}

test('(a) one tick runs exactly one provider', async () => {
    const a = fakeProvider('castletv', { default: EN });
    const b = fakeProvider('showsst', { default: EN });
    const s = setup([a, b]);
    await s.canary.tick();
    assert.equal((a.calls.length > 0) + (b.calls.length > 0), 1);
    assert.equal(s.lines.filter((l) => l.startsWith('[canary] run ')).length, 1);
});

test('(b) netmirror and mapple are never chosen, even when most overdue', async () => {
    const nm = fakeProvider('netmirror', { default: EN });
    const mp = fakeProvider('mapple', { default: EN });
    const ok = fakeProvider('showsst', { default: EN });
    const s = setup([nm, mp, ok]);
    for (let i = 0; i < 5; i++) { await s.canary.tick(); s.advance(7 * HOUR); }
    assert.equal(nm.calls.length, 0);
    assert.equal(mp.calls.length, 0);
    assert.ok(ok.calls.length >= 5);
    assert.ok(EXCLUDED.has('netmirror') && EXCLUDED.has('mapple'));
    assert.ok(s.lines.some((l) => l === '[canary] skip netmirror (excluded)'));
});

test('(c) pass: recordOutcome hit, state ok, due +6 h; disabled providers skipped', async () => {
    const off = fakeProvider('castletv', { default: EN }, { enabled: false });
    const p = fakeProvider('showsst', { default: EN });
    const s = setup([off, p]);
    await s.canary.tick();
    assert.deepEqual(s.outcomes, [['showsst', 'hit']]);
    const row = s.store.canaryGet('showsst');
    assert.equal(row.state, 'ok');
    assert.equal(row.next_due_at, s.now() + HEALTHY_MS);
    assert.equal(row.last_ok_at, s.now());
    assert.equal(off.calls.length, 0);
    assert.equal(s.store.canaryGet('castletv'), null);
    // Not due again inside 6 h: a tick runs nothing.
    s.advance(HOUR);
    await s.canary.tick();
    assert.equal(p.calls.length, 1);
    assert.ok(s.lines.includes('[canary] idle (nothing due)'));
});

test('(d) blocked failure: no heal, due +6 h', async () => {
    const p = fakeProvider('showsst', { default: new Error('HTTP 403 Just a moment...') });
    const s = setup([p]);
    await s.canary.tick();
    assert.equal(s.heals.length, 0);
    const row = s.store.canaryGet('showsst');
    assert.equal(row.state, 'blocked');
    assert.equal(row.next_due_at, s.now() + HEALTHY_MS);
    assert.equal(row.fails, 1);
    assert.deepEqual(s.outcomes, []);
});

test('(e) key failure: heal(key) once; applied: 27205 re-run once, then pass', async () => {
    let n = 0;
    const p = fakeProvider('vidrock', { 579974: () => (++n === 1 ? Promise.reject(new Error('unable to authenticate data')) : TE), 784572: TE }, { verifyTitle: { tmdbId: '579974' } });
    const s = setup([p], { heal: () => ({ applied: true, how: 'bundle' }) });
    await s.canary.tick();
    assert.deepEqual(s.heals, [['vidrock', 'key']]);
    assert.deepEqual(p.calls.filter((c) => c === '579974').length, 2);
    const row = s.store.canaryGet('vidrock');
    assert.equal(row.state, 'ok');
    assert.equal(row.heal_how, 'bundle');
    assert.equal(row.heal_at, s.now());
});

test('(e2) host failure with no heal applied: no re-run, due +30 min', async () => {
    const p = fakeProvider('castletv', { default: new Error('getaddrinfo ENOTFOUND api.hlowb.com') });
    const s = setup([p]);
    await s.canary.tick();
    assert.deepEqual(s.heals, [['castletv', 'host']]);
    assert.equal(p.calls.filter((c) => c === '27205').length, 1);
    const row = s.store.canaryGet('castletv');
    assert.equal(row.state, 'host');
    assert.equal(row.next_due_at, s.now() + FAILING_MS);
});

test('(e3) down and drift: no heal; down due +30 min, drift (empty) due +6 h', async () => {
    const down = fakeProvider('castletv', { default: new Error('timeout after 20000ms') });
    const s1 = setup([down]);
    await s1.canary.tick();
    assert.equal(s1.heals.length, 0);
    assert.equal(s1.store.canaryGet('castletv').next_due_at, s1.now() + FAILING_MS);
    const empty = fakeProvider('showsst', { default: [] });
    const s2 = setup([empty]);
    await s2.canary.tick();
    assert.equal(s2.store.canaryGet('showsst').state, 'drift');
    assert.equal(s2.store.canaryGet('showsst').next_due_at, s2.now() + HEALTHY_MS);
    assert.ok(s2.lines.some((l) => /^\[canary\] fail showsst kind=drift rule=empty/.test(l)));
});

test('(f) telugu_ok: 1 when Krack 784572 gives a Telugu row, 0 otherwise', async () => {
    const yes = fakeProvider('castletv', { 27205: EN, 784572: TE });
    const s1 = setup([yes]);
    await s1.canary.tick();
    assert.deepEqual(yes.calls, ['27205', '784572']);
    assert.equal(s1.store.canaryGet('castletv').telugu_ok, 1);
    const no = fakeProvider('multimovies', { 27205: EN, 784572: EN });
    const s2 = setup([no]);
    await s2.canary.tick();
    assert.equal(s2.store.canaryGet('multimovies').telugu_ok, 0);
    // A provider with no Telugu title in its run records null, not 0.
    const other = fakeProvider('showsst', { 27205: EN });
    const s3 = setup([other]);
    await s3.canary.tick();
    assert.equal(s3.store.canaryGet('showsst').telugu_ok, null);
});

test('(g) migration runs on an existing DB at the previous version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-mig-'));
    const file = path.join(dir, 'learning.sqlite');
    const Database = require('better-sqlite3');
    const db = new Database(file);
    for (let v = 0; v < MIGRATIONS.length - 1; v++) db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    db.prepare('insert into provider_health (provider, updated_at) values (?, ?)').run('castletv', 1);
    db.close();
    const s = openStore(file);
    assert.equal(s.userVersion(), MIGRATIONS.length);
    assert.equal(s.providerHealth('castletv').provider, 'castletv');
    s.canaryPut('castletv', { state: 'ok', runs: 1 });
    assert.equal(s.canaryGet('castletv').state, 'ok');
    s.close();
});

test('(g2) JSON fallback backend has the same canary calls', () => {
    const s = openStore(':memory:', { backend: 'json' });
    s.canaryPut('showsst', { state: 'down', fails: 2 });
    assert.equal(s.canaryGet('showsst').fails, 2);
    assert.equal(s.canaryAll().length, 1);
});

test('(h) vidrift runs 579974 only, never 27205; telugu_ok from RRR', async () => {
    const p = fakeProvider('vidrift', { 579974: TE, 27205: EN }, { verifyTitle: { tmdbId: '579974' } });
    const s = setup([p]);
    await s.canary.tick();
    assert.deepEqual(p.calls, ['579974']);
    assert.equal(s.store.canaryGet('vidrift').telugu_ok, 1);
});

test('vaplayer (APK-only on the VM): a token miss (empty apiToken = VM IP gate, spec section 6) is blocked, no heal, due +6 h', async () => {
    const p = fakeProvider('vaplayer', { default: new Error('no apiToken on the player page') });
    const s = setup([p]);
    await s.canary.tick();
    assert.equal(s.heals.length, 0);
    const row = s.store.canaryGet('vaplayer');
    assert.equal(row.state, 'blocked');
    assert.equal(row.kind, 'blocked');
    assert.equal(row.next_due_at, s.now() + HEALTHY_MS);
    assert.ok(s.lines.some((l) => l.startsWith('[canary] fail vaplayer kind=token') && l.includes('(apk-only, no heal)')));
});

// Review I2: `blocked` (which turns the server path off for APK callers) only
// on Cloudflare or rateLimited; drift, timeout and down keep their own class.
test('I2 vaplayer: blocked only on Cloudflare or rateLimited; drift, timeout, down keep their class; never healed, due +6 h', async () => {
    const cases = [
        [new Error('HTTP 503 Just a moment...'), 'blocked'],
        [new Error('vaplayer: player page says rateLimited:true (IP gate)'), 'blocked'],
        [[], 'drift'],
        [new Error('The operation was aborted due to timeout'), 'down'],
        [Object.assign(new Error('api HTTP 502 for x'), { status: 502 }), 'down'],
    ];
    for (const [answer, want] of cases) {
        const p = fakeProvider('vaplayer', { default: answer });
        const s = setup([p]);
        await s.canary.tick();
        const row = s.store.canaryGet('vaplayer');
        assert.equal(row.state, want, String(answer && answer.message));
        assert.equal(row.next_due_at, s.now() + HEALTHY_MS);
        assert.equal(s.heals.length, 0);
    }
});

// Review M1: the registry answers [] with timedOut on its deadline. That is a
// timeout (down, +30 min), not drift (+6 h).
test('M1 a provider timeout ([] with timedOut) is down rule=timeout, due +30 min', async () => {
    const out = []; out.timedOut = true;
    const p = fakeProvider('castletv', { default: () => out });
    const s = setup([p]);
    await s.canary.tick();
    const row = s.store.canaryGet('castletv');
    assert.equal(row.state, 'down');
    assert.equal(row.kind, 'down');
    assert.equal(row.next_due_at, s.now() + FAILING_MS);
    assert.ok(s.lines.some((l) => l.startsWith('[canary] fail castletv kind=down rule=timeout')), s.lines.join('\n'));
});

// Review M3: the serve-skip line once per blocked state change, not per request.
test('M3 serve-skip logs once per provider per blocked state change', () => {
    const { serveSkip } = require('../lib/selfheal/canary');
    const store = openStore(':memory:');
    const lines = []; const w = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
        store.canaryPut('vaplayer', { state: 'blocked', kind: 'blocked' });
        for (let i = 0; i < 5; i++) assert.equal(serveSkip('vaplayer', null, store, () => true), true);
        assert.equal(lines.filter((l) => l.startsWith('[canary] serve-skip vaplayer')).length, 1);
        store.canaryPut('vaplayer', { state: 'ok' });
        assert.equal(serveSkip('vaplayer', null, store, () => true), false);
        store.canaryPut('vaplayer', { state: 'blocked', kind: 'blocked' });
        for (let i = 0; i < 3; i++) serveSkip('vaplayer', null, store, () => true);
        assert.equal(lines.filter((l) => l.startsWith('[canary] serve-skip vaplayer')).length, 2);
    } finally { console.warn = w; }
});

test('failing provider is retried every 30 min, a healthy one every 6 h; one provider per tick', async () => {
    const bad = fakeProvider('castletv', { default: new Error('timeout after 20000ms') });
    const good = fakeProvider('showsst', { default: EN });
    const s = setup([bad, good]);
    // 12 ticks, 10 min apart = 2 h.
    for (let i = 0; i < 12; i++) { await s.canary.tick(); s.advance(10 * MIN); }
    assert.equal(good.calls.length, 1);
    assert.equal(bad.calls.length, 4); // t=0, 30, 60, 90 min
});

test('a run that throws inside the canary never escapes tick(); a second tick while one runs is skipped', async () => {
    let release;
    const slow = fakeProvider('showsst', { default: () => new Promise((r) => { release = () => r(EN); }) });
    const s = setup([slow]);
    const first = s.canary.tick();
    await new Promise((r) => setImmediate(r));
    await s.canary.tick();
    assert.ok(s.lines.includes('[canary] skip tick (a run is in flight)'));
    release();
    await first;
    assert.equal(slow.calls.length, 1);
});
