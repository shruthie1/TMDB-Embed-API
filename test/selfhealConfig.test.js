'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createConfig } = require('../lib/selfheal/config');

// Task 1 (docs/superpowers/plans/2026-11-21-provider-selfheal.md): built-in <
// remote < heal, wrong types skipped, last good remote kept and persisted.

const K = 'a'.repeat(64);
const BUILTIN = { version: 1, ttlSec: 21600, vidrock: { key: K }, multimovies: { bases: ['https://vidbolt.xyz'] } };

function tmpFile() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shcfg-')), 'resolve-config.remote.json');
}
function fakeFetch(answers) {
    const calls = [];
    const f = async (url, opts) => {
        calls.push(url);
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
    };
    f.calls = calls;
    return f;
}
function captureLogs() {
    const lines = [];
    const orig = { warn: console.warn, log: console.log };
    console.warn = (...a) => lines.push(a.join(' '));
    console.log = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => Object.assign(console, orig) };
}
const doc = (o) => ({ status: 200, body: JSON.stringify(o) });

test('(a) no url: built-in value, no fetch', async () => {
    const f = fakeFetch([]);
    const c = createConfig({ builtin: BUILTIN, url: null, fetch: f, file: tmpFile() });
    await c.refresh();
    assert.strictEqual(c.cfg('vidrock', 'key', 'x'), K);
    assert.strictEqual(c.cfg('vidrock', 'missing', 'fb'), 'fb');
    assert.strictEqual(f.calls.length, 0);
});

test('(b) remote value wins over built-in', async () => {
    const R = 'b'.repeat(64);
    const logs = captureLogs();
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: fakeFetch([doc({ version: 2, vidrock: { key: R } })]), file: tmpFile() });
    try { await c.refresh(); } finally { logs.restore(); }
    assert.strictEqual(c.cfg('vidrock', 'key', K), R);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] remote ok version 2')), logs.lines.join('\n'));
});

test('(c) heal over remote; (d) remote edit of that field drops the heal', async () => {
    const R = 'b'.repeat(64), H = 'c'.repeat(64), R2 = 'd'.repeat(64);
    const f = fakeFetch([doc({ version: 2, vidrock: { key: R } }), doc({ version: 3, vidrock: { key: R2 } })]);
    const dropped = [];
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile(), onDropHeal: (p, k) => dropped.push(`${p}.${k}`) });
    await c.refresh();
    c.setHeals({ vidrock: { fields: { key: { value: H, how: 'bundle', over: R, verifiedAt: 1 } } } });
    assert.strictEqual(c.cfg('vidrock', 'key', K), H);
    await c.refresh();
    const logs = captureLogs();
    let v;
    try { v = c.cfg('vidrock', 'key', K); } finally { logs.restore(); }
    assert.strictEqual(v, R2);
    assert.deepStrictEqual(dropped, ['vidrock.key']);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] drop-heal vidrock.key')), logs.lines.join('\n'));
});

test('heal recorded over no remote value is dropped when a remote value appears', async () => {
    const H = 'c'.repeat(64), R = 'b'.repeat(64);
    const f = fakeFetch([doc({ version: 2 }), doc({ version: 2, vidrock: { key: R } })]);
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    await c.refresh();
    c.setHeals({ vidrock: { fields: { key: { value: H, how: 'bundle', over: null } } } });
    assert.strictEqual(c.cfg('vidrock', 'key', K), H);
    await c.refresh();
    assert.strictEqual(c.cfg('vidrock', 'key', K), R);
});

test('(e) remote 500 after a good fetch keeps last good', async () => {
    const R = 'b'.repeat(64);
    const f = fakeFetch([doc({ version: 2, vidrock: { key: R } }), { status: 500, body: 'oops' }, new Error('fetch failed ENOTFOUND cfg.test'), { status: 200, body: '{not json' }]);
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    await c.refresh();
    const logs = captureLogs();
    try { await c.refresh(); await c.refresh(); await c.refresh(); } finally { logs.restore(); }
    assert.strictEqual(c.cfg('vidrock', 'key', K), R);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] remote keep-last-good http 500')), logs.lines.join('\n'));
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] remote keep-last-good fetch')), logs.lines.join('\n'));
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] remote keep-last-good parse')), logs.lines.join('\n'));
});

test('(f) older remote version is ignored', async () => {
    const R = 'b'.repeat(64);
    const f = fakeFetch([doc({ version: 2, vidrock: { key: R } }), doc({ version: 1, vidrock: { key: 'e'.repeat(64) } })]);
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    await c.refresh();
    const logs = captureLogs();
    try { await c.refresh(); } finally { logs.restore(); }
    assert.strictEqual(c.cfg('vidrock', 'key', K), R);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] remote keep-last-good older version 1 < 2')), logs.lines.join('\n'));
});

test('(g) wrong-typed value falls back to the layer below', async () => {
    const f = fakeFetch([doc({ version: 2, multimovies: { bases: 'https://x.test' } })]);
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    await c.refresh();
    const logs = captureLogs();
    let v;
    try { v = c.cfg('multimovies', 'bases', ['https://fallback.test']); } finally { logs.restore(); }
    assert.deepStrictEqual(v, ['https://vidbolt.xyz']);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] skip-type remote multimovies.bases')), logs.lines.join('\n'));
    // An array that is not all strings is skipped too when the fallback is a string list.
    c.setHeals({ multimovies: { fields: { bases: { value: [1, 2], over: null } } } });
    assert.deepStrictEqual(c.cfg('multimovies', 'bases', ['https://fallback.test']), ['https://vidbolt.xyz']);
});

test('(h) last good file is read on a fresh instance when fetch fails', async () => {
    const file = tmpFile();
    const R = 'b'.repeat(64);
    const c1 = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: fakeFetch([doc({ version: 2, vidrock: { key: R } })]), file });
    await c1.refresh();
    assert.ok(fs.existsSync(file));
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), []);
    const logs = captureLogs();
    let v;
    const c2 = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: fakeFetch([new Error('down')]), file });
    try { await c2.refresh(); v = c2.cfg('vidrock', 'key', K); } finally { logs.restore(); }
    assert.strictEqual(v, R);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] last-good loaded version 2')), logs.lines.join('\n'));
});

test('snapshot merges built-in < remote < heals and keeps unknown keys', async () => {
    const f = fakeFetch([doc({ version: 2, ttlSec: 600, newThing: { a: 1 }, vidrock: { bases: ['https://vidrock.net'] } })]);
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    await c.refresh();
    c.setHeals({ vaplayer: { fields: { wrapperBases: { value: ['https://va.new'], over: null } } }, castletv: { base: { base: 'https://castle.new' } } });
    const s = c.snapshot();
    assert.strictEqual(s.version, 2);
    assert.strictEqual(s.ttlSec, 600);
    assert.deepStrictEqual(s.newThing, { a: 1 });
    assert.strictEqual(s.vidrock.key, K);
    assert.deepStrictEqual(s.vidrock.bases, ['https://vidrock.net']);
    assert.deepStrictEqual(s.vaplayer.wrapperBases, ['https://va.new']);
    assert.strictEqual(c.ttlMs(), 600000);
    // A healed base goes in front of the provider's base list.
    c.setHeals({ multimovies: { base: { base: 'https://vidbolt.new' } } });
    assert.deepStrictEqual(c.snapshot().multimovies.bases, ['https://vidbolt.new', 'https://vidbolt.xyz']);
});

// ---- review 2026-11-21 fixes ----

test('I4 snapshot serves host heals only for APK on-device providers, never mapple, never keys or paths', () => {
    const c = createConfig({ builtin: { ...BUILTIN, mapple: { bases: ['https://mapple.fun'] } } });
    c.setHeals({
        mapple: { base: { base: 'https://mapple.evil' } },
        vidrock: { base: { base: 'https://vidrock.new' }, fields: { key: { value: 'c'.repeat(64), over: null } } },
        multimovies: { base: { base: 'https://vidbolt.new' }, fields: { playerPath: { value: '/m/{id}', over: null } } },
        castletv: { base: { base: 'https://castle.old', legacy: true } },
    });
    const s = c.snapshot();
    assert.deepStrictEqual(s.mapple.bases, ['https://mapple.fun']);
    assert.strictEqual(s.vidrock.key, K);
    assert.strictEqual(s.vidrock.bases, undefined);
    assert.deepStrictEqual(s.multimovies.bases, ['https://vidbolt.new', 'https://vidbolt.xyz']);
    assert.strictEqual(s.multimovies.playerPath, undefined);
    assert.strictEqual(s.castletv, undefined);
    // The server itself still uses the key heal.
    assert.strictEqual(c.cfg('vidrock', 'key', K), 'c'.repeat(64));
});

test('M1 last good file is ignored when no remote URL is set', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ version: 9, vidrock: { key: 'b'.repeat(64) } }));
    const c = createConfig({ builtin: BUILTIN, url: null, file });
    await c.refresh();
    assert.strictEqual(c.cfg('vidrock', 'key', K), K);
    assert.strictEqual(c.snapshot().version, 1);
});

test('M2 a missing or failed remote never drops a heal', async () => {
    const dropped = [];
    const c = createConfig({ builtin: BUILTIN, url: 'https://cfg.test/rc.json', fetch: fakeFetch([new Error('down')]), file: tmpFile(), onDropHeal: (p, f) => dropped.push(`${p}.${f}`) });
    await c.refresh();
    c.setHeals({ vidrock: { fields: { key: { value: 'c'.repeat(64), over: 'd'.repeat(64) } } } });
    assert.strictEqual(c.cfg('vidrock', 'key', K), 'c'.repeat(64));
    assert.deepStrictEqual(dropped, []);
});

test('M3 a broken built-in file makes snapshot throw (route answers 500); cfg still falls back', () => {
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shcfg-')), 'resolve-config.json');
    fs.writeFileSync(bad, '{ not json');
    const c = createConfig({ builtin: bad });
    const logs = captureLogs();
    try {
        assert.throws(() => c.snapshot(), /built-in config unreadable/);
        assert.strictEqual(c.cfg('vidrock', 'key', K), K);
    } finally { logs.restore(); }
});

test('M5 remote host lists: https only, at most 10, netmirror.domains capped at the built-in count', async () => {
    const many = Array.from({ length: 14 }, (_, i) => `https://h${i}.test`);
    const f = fakeFetch([doc({
        version: 2,
        multimovies: { bases: ['http://plain.test', ...many] },
        showsst: { mirrors: [{ api: 'http://a.test', player: 'https://p.test' }, { api: 'https://a2.test', player: 'https://p2.test' }] },
        netmirror: { domains: ['https://d1.test', 'https://d2.test', 'https://d3.test'] },
        mapple: { fronts: Array.from({ length: 13 }, (_, i) => `s${i}`) },
    })]);
    const builtin = { ...BUILTIN, netmirror: { domains: ['https://n1.test', 'https://n2.test'] } };
    const c = createConfig({ builtin, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    const logs = captureLogs();
    try { await c.refresh(); } finally { logs.restore(); }
    assert.deepStrictEqual(c.cfg('multimovies', 'bases', ['https://x.test']), many.slice(0, 10));
    assert.deepStrictEqual(c.cfg('showsst', 'mirrors', []), [{ api: 'https://a2.test', player: 'https://p2.test' }]);
    assert.deepStrictEqual(c.cfg('netmirror', 'domains', ['https://x.test']), ['https://d1.test', 'https://d2.test']);
    assert.strictEqual(c.cfg('mapple', 'fronts', ['x']).length, 13);
    assert.ok(logs.lines.some((l) => l.startsWith('[selfheal-config] remote trim multimovies.bases 15->10')), logs.lines.join('\n'));
});

test('prewarm: /api/resolve-config passes boolean prewarm through (built-in v4 defaults), drops bad values', async () => {
    const shipped = path.join(__dirname, '..', 'routes', 'resolve-config.json');
    const snap = createConfig({ builtin: shipped }).snapshot();
    assert.equal(snap.version, 4);
    const on = Object.keys(snap).filter((k) => snap[k] && snap[k].prewarm === true).sort();
    assert.deepStrictEqual(on, ['castletv', 'mapple', 'multimovies', 'netmirror', 'vidrift']);
    for (const k of ['vaplayer', 'showsst', 'onetouchtv']) assert.strictEqual(snap[k].prewarm, false, k);
    // The static web copy the APK falls back to carries the same flags.
    const web = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'resolve-config.json'), 'utf8'));
    assert.equal(web.version, 4);
    for (const k of Object.keys(snap)) if (snap[k] && typeof snap[k] === 'object' && 'prewarm' in snap[k]) assert.strictEqual(web[k].prewarm, snap[k].prewarm, k);

    // A remote edit wins per field; a non-boolean is dropped (APK reads it as false); heals never touch it.
    const f = fakeFetch([{ status: 200, body: JSON.stringify({ version: 4, mapple: { prewarm: false }, vidrift: { prewarm: 'yes' } }) }]);
    const c = createConfig({ builtin: { version: 3, mapple: { prewarm: true }, vidrift: { prewarm: true }, castletv: { prewarm: true, bases: ['https://a.test'] } }, url: 'https://cfg.test/rc.json', fetch: f, file: tmpFile() });
    await c.refresh();
    c.setHeals({ castletv: { bases: { value: ['https://b.test'], over: ['https://a.test'] } } });
    const s = c.snapshot();
    assert.strictEqual(s.mapple.prewarm, false);
    assert.ok(!('prewarm' in s.vidrift));
    assert.strictEqual(s.castletv.prewarm, true);
});
