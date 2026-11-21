'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Task 2: data/provider-heals.json holds host AND field heals; the legacy
// data/provider-bases.json is read once when the new file is absent.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heals-'));
const FILE = path.join(dir, 'provider-heals.json');
process.env.UPSTREAM_BASES_FILE = FILE;
process.env.RESOLVE_CONFIG_FILE = path.join(dir, 'resolve-config.remote.json');
delete process.env.RESOLVE_CONFIG_URL;

const up = require('../utils/upstreamBase');
const config = require('../lib/selfheal/config');

function captureLogs() {
    const lines = [];
    const orig = { warn: console.warn, log: console.log };
    console.warn = (...a) => lines.push(a.join(' '));
    console.log = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => Object.assign(console, orig) };
}

beforeEach(() => {
    process.env.UPSTREAM_BASES_FILE = FILE;
    for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    up._reset();
});

test('(a) legacy provider-bases.json: held (not served) until verified, saved in the new shape', () => {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'provider-bases.json'), JSON.stringify({
        castletv: { base: 'https://castle.new', seed: 'https://api.hlowb.com', how: 'redirect', updatedAt: now, checkedAt: now },
    }));
    const logs = captureLogs();
    let b;
    try { b = up.getBase('castletv', 'https://api.hlowb.com'); } finally { logs.restore(); }
    assert.strictEqual(b, 'https://api.hlowb.com');
    assert.strictEqual(up.legacyPending('castletv'), true);
    assert.strictEqual(up.allFields().castletv, undefined);
    assert.ok(logs.lines.some((l) => l.startsWith('[upstream] heals legacy-import 1')), logs.lines.join('\n'));
    up.setField('vidrock', 'key', 'f'.repeat(64), 'bundle');
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.strictEqual(saved.castletv.base.base, 'https://castle.new');
    assert.strictEqual(saved.castletv.base.legacy, true);
    assert.strictEqual(saved.vidrock.fields.key.value, 'f'.repeat(64));
});

function writeLegacy() {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'provider-bases.json'), JSON.stringify({
        castletv: { base: 'https://castle.new', seed: 'https://api.hlowb.com', how: 'redirect', updatedAt: now, checkedAt: now },
    }));
}

test('I4 legacy host that passes its first validation is adopted', async () => {
    writeLegacy();
    const logs = captureLogs();
    let seen;
    try {
        assert.strictEqual(await up.verifyLegacy('castletv', async (u) => { seen = u; return true; }), true);
    } finally { logs.restore(); }
    assert.strictEqual(seen, 'https://castle.new');
    assert.strictEqual(up.getBase('castletv', 'https://api.hlowb.com'), 'https://castle.new');
    assert.ok(up.allFields().castletv.base);
    assert.ok(logs.lines.some((l) => l.startsWith('[upstream] heals legacy-adopt castletv https://castle.new')), logs.lines.join('\n'));
});

test('I4 legacy host that fails its first validation is dropped', async () => {
    writeLegacy();
    const logs = captureLogs();
    try {
        assert.strictEqual(await up.verifyLegacy('castletv', async () => false), false);
    } finally { logs.restore(); }
    assert.strictEqual(up.getBase('castletv', 'https://api.hlowb.com'), 'https://api.hlowb.com');
    assert.strictEqual(up.legacyPending('castletv'), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).castletv, undefined);
    assert.ok(logs.lines.some((l) => l.startsWith('[upstream] heals legacy-drop castletv https://castle.new')), logs.lines.join('\n'));
});

test('I2 a field heal expires after TTL_MS (7 days), like a host heal', () => {
    const old = Date.now() - up.TTL_MS - 1000;
    fs.writeFileSync(FILE, JSON.stringify({
        multimovies: { fields: { playerPath: { value: '/m/{id}', how: 'titlepage', over: null, verifiedAt: old } } },
        vidrock: { fields: { key: { value: 'c'.repeat(64), how: 'bundle', over: null, verifiedAt: Date.now() } } },
    }));
    assert.strictEqual(up.getField('multimovies', 'playerPath'), null);
    const all = up.allFields();
    assert.strictEqual(all.multimovies, undefined);
    assert.strictEqual(all.vidrock.fields.key.expiresAt, all.vidrock.fields.key.verifiedAt + up.TTL_MS);
    assert.strictEqual(config.cfg('multimovies', 'playerPath', '/movie/{id}'), '/movie/{id}');
});

test('(b) setField survives a reload; (c) no .tmp left; config sees the heal', () => {
    assert.strictEqual(up.setField('vidrock', 'key', 'c'.repeat(64), 'bundle'), true);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
    up._reset();
    const f = up.getField('vidrock', 'key');
    assert.strictEqual(f.value, 'c'.repeat(64));
    assert.strictEqual(f.how, 'bundle');
    assert.strictEqual(f.over, null);
    assert.ok(f.verifiedAt > 0);
    assert.strictEqual(config.cfg('vidrock', 'key', 'a'.repeat(64)), 'c'.repeat(64));
    assert.ok(up.allFields().vidrock.fields.key);
});

test('dropField removes the heal from memory, disk and config', () => {
    up.setField('vaplayer', 'streamDataApiUrl', 'https://api.new/x', 'config');
    const logs = captureLogs();
    try { up.dropField('vaplayer', 'streamDataApiUrl'); } finally { logs.restore(); }
    assert.strictEqual(up.getField('vaplayer', 'streamDataApiUrl'), null);
    up._reset();
    assert.strictEqual(up.getField('vaplayer', 'streamDataApiUrl'), null);
    assert.strictEqual(config.cfg('vaplayer', 'streamDataApiUrl', 'fb'), 'fb');
    assert.ok(logs.lines.some((l) => l.startsWith('[upstream] heal-drop vaplayer.streamDataApiUrl')), logs.lines.join('\n'));
});

test('(d) unwritable dir: setField returns false, value held in memory, one warning', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.UPSTREAM_BASES_FILE = path.join(blocker, 'sub', 'provider-heals.json');
    up._reset();
    const logs = captureLogs();
    let ok;
    try { ok = up.setField('onetouchtv', 'key', 'k'.repeat(32), 'bundle'); } finally { logs.restore(); }
    assert.strictEqual(ok, false);
    assert.strictEqual(up.getField('onetouchtv', 'key').value, 'k'.repeat(32));
    assert.strictEqual(logs.lines.filter((l) => l.startsWith('[upstream] could not write')).length, 1, logs.lines.join('\n'));
});

test('I4 registry: first use of a provider with a legacy host runs its verify once (no title proof: dropped)', async () => {
    writeLegacy();
    const { _checkLegacy } = require('../providers/registry');
    let calls = 0;
    const mod = { UPSTREAM: { name: 'castletv', seed: 'https://api.hlowb.com' }, get: async () => { calls++; return [{ url: 'https://cdn.test/x.mp4' }]; } };
    const proof = require('../lib/selfheal/proof');
    proof._setDeps({ fetch: async () => new Response(Buffer.from('no mvhd box'), { status: 206 }) });
    const logs = captureLogs();
    try {
        _checkLegacy({ name: 'castletv', functionName: 'get' }, mod);
        _checkLegacy({ name: 'castletv', functionName: 'get' }, mod); // single-flight
        await up.verifyLegacy('castletv', async () => false);
        await new Promise((r) => setTimeout(r, 20));
    } finally { logs.restore(); proof._setDeps({}); }
    assert.strictEqual(calls, 1);
    assert.strictEqual(up.legacyPending('castletv'), false);
    assert.strictEqual(up.getBase('castletv', 'https://api.hlowb.com'), 'https://api.hlowb.com');
    for (const p of ['[heal] castletv legacy-verify start', '[heal] castletv reject https://castle.new no-title-proof', '[upstream] heals legacy-drop castletv https://castle.new']) {
        assert.ok(logs.lines.some((l) => l.startsWith(p)), `missing ${p}\n${logs.lines.join('\n')}`);
    }
});
