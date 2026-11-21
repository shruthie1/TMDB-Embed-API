'use strict';
const assert = require('node:assert');
const { test, beforeEach, afterEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Task 5: providers read hosts, keys and paths from lib/selfheal/config.js per
// call. No remote and no heal: exactly today's hosts. No network.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shprov-'));
process.env.UPSTREAM_BASES_FILE = path.join(dir, 'provider-heals.json');
process.env.RESOLVE_CONFIG_FILE = path.join(dir, 'remote.json');
delete process.env.RESOLVE_CONFIG_URL;
for (const k of ['VAPLAYER_WRAPPER_ORIGIN', 'SHOWSST_API_BASE', 'SHOWSST_ORIGIN', 'NETMIRROR_API_BASE', 'NEWTV_DOMAINS', 'VIDRIFT_BASE']) delete process.env[k];
process.env.NETMIRROR_BUDGET_CALLS = '1000';
process.env.NETMIRROR_STATE_FILE = path.join(dir, 'netmirror-state.json');

const config = require('../lib/selfheal/config');
const up = require('../utils/upstreamBase');
const mm = require('../providers/multimovies');
const vidrock = require('../providers/vidrock');
const ott = require('../providers/onetouchtv');
const castle = require('../providers/castletv');
const showsst = require('../providers/showsst');
const vaplayer = require('../providers/vaplayer');

beforeEach(() => { config.shared._setRemote(null); config.setHeals({}); up._reset(); });
afterEach(() => { config.shared._setRemote(null); config.setHeals({}); });

test('(a) no remote: every provider uses today\'s exact host and key', () => {
    assert.strictEqual(mm._internal.resolveUrl('27205', 'movie'), 'https://vidbolt.xyz/api/resolve?type=movie&id=27205');
    assert.deepStrictEqual(mm._internal.streamHeaders(), mm.STREAM_HEADERS);
    assert.strictEqual(vidrock._internal.apiBase(), 'https://vidrock.net');
    assert.deepStrictEqual(vidrock._internal.headers(), vidrock.HEADERS);
    assert.strictEqual(vidrock._internal.streamKey().toString('hex'), vidrock.CONFIG_DEFAULTS.key);
    assert.strictEqual(ott._internal.mainUrl(), 'https://api3.devcorp.me');
    assert.strictEqual(ott._internal.fetchHeaders().Referer, 'https://onetouchtv.xyz/');
    assert.strictEqual(castle._internal.castleBase(), 'https://api.hlowb.com');
    assert.strictEqual(castle._internal.apiVersion('video'), 'v2.0.1');
    assert.deepStrictEqual(showsst._mirrors().map((m) => m.api), ['https://api.vidqueen.st', 'https://api.vidmario.net']);
    assert.strictEqual(vaplayer._internal.wrapperOrigin(), 'https://vaplayer.ru');
    assert.strictEqual(vaplayer._internal.streamApi(), 'https://streamdata.vaplayer.ru/api.php');
});

test('(b) remote multimovies.bases: the request goes there with its Referer', async (t) => {
    config.shared._setRemote({ version: 2, multimovies: { bases: ['https://x.test'] } });
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), referer: opts.headers && (opts.headers.Referer || opts.headers.referer) });
        throw new Error('getaddrinfo ENOTFOUND stub');
    };
    t.after(() => { global.fetch = realFetch; });
    await mm.getMultimoviesStreams('27205', 'movie').catch(() => null);
    const api = calls.find((c) => /\/api\/resolve/.test(c.url));
    assert.ok(api, calls.map((c) => c.url).join('\n'));
    assert.match(api.url, /^https:\/\/x\.test\/api\/resolve\?type=movie&id=27205/);
    assert.match(api.referer, /^https:\/\/x\.test\//);
    assert.ok(!calls.some((c) => c.url.includes('vidbolt.xyz')), 'today\'s host not asked');
    assert.strictEqual(mm.UPSTREAM.seed, 'https://x.test');
});

test('(c) vidrock, onetouchtv and multimovies export UPSTREAM', () => {
    assert.strictEqual(vidrock.UPSTREAM.name, 'vidrock');
    assert.strictEqual(vidrock.UPSTREAM.seed, 'https://vidrock.net');
    assert.strictEqual(ott.UPSTREAM.name, 'onetouchtv');
    assert.strictEqual(ott.UPSTREAM.seed, 'https://api3.devcorp.me');
    assert.strictEqual(ott.UPSTREAM.player(), 'https://onetouchtv.xyz');
    assert.strictEqual(mm.UPSTREAM.name, 'multimovies');
    assert.strictEqual(castle.UPSTREAM.seed, 'https://api.hlowb.com');
});

test('(d) castle keySuffix from config changes the derived key; versions follow config', () => {
    const sk = Buffer.alloc(8, 7).toString('base64');
    const before = castle._deriveKey(sk).toString('hex');
    config.shared._setRemote({ version: 2, castletv: { keySuffix: 'ZZZZZZ', apiVersions: { video: 'v2.0.2', search: 'bad' } } });
    assert.notStrictEqual(castle._deriveKey(sk).toString('hex'), before);
    assert.strictEqual(castle._internal.apiVersion('video'), 'v2.0.2');
    assert.strictEqual(castle._internal.apiVersion('search'), 'v1.1.0'); // malformed -> today's
    assert.strictEqual(castle._internal.apiVersion('details'), 'v1.9.9'); // missing -> today's
});

test('heals: vidrock key and multimovies base heal apply per call; bad key falls back', () => {
    const K2 = 'ab'.repeat(32);
    up.setField('vidrock', 'key', K2, 'bundle');
    assert.strictEqual(vidrock._internal.streamKey().toString('hex'), K2);
    config.setHeals({ vidrock: { fields: { key: { value: 'nothex', over: null } } } });
    assert.strictEqual(vidrock._internal.streamKey().toString('hex'), vidrock.CONFIG_DEFAULTS.key);
    config.shared._setRemote({ version: 2, onetouchtv: { key: 'short', iv: 'x' } });
    const [k, iv] = ott._internal.aesKeyIv();
    assert.strictEqual(k.toString('utf8'), ott.CONFIG_DEFAULTS.key);
    assert.strictEqual(iv.toString('utf8'), ott.CONFIG_DEFAULTS.iv);
});

test('vaplayer: a streamDataApiUrl heal replaces STREAM_API', () => {
    up.setField('vaplayer', 'streamDataApiUrl', 'https://streamdata.new.test/api.php', 'config-object');
    assert.strictEqual(vaplayer._internal.streamApi(), 'https://streamdata.new.test/api.php');
});

test('showsst: remote mirrors replace the static list', () => {
    config.shared._setRemote({ version: 2, showsst: { mirrors: [{ api: 'https://api.q.test', player: 'https://player.q.test' }] } });
    assert.deepStrictEqual(showsst._mirrors(), [{ api: 'https://api.q.test', player: 'https://player.q.test' }]);
});

test('(e) netmirror: a config domain list makes the same number of discovery requests', async (t) => {
    const { guard } = require('../utils/netmirrorGuard');
    const realFetch = global.fetch;
    let calls = [];
    const tokenHash = Buffer.from('https://api.nm.test/').toString('base64');
    global.fetch = async (url) => {
        calls.push(String(url));
        // The first two discovery domains fail; the third answers.
        if (calls.length < 3) throw new Error('getaddrinfo ENOTFOUND stub');
        return new Response(JSON.stringify({ token_hash: tokenHash }), { status: 200 });
    };
    t.after(() => { global.fetch = realFetch; });
    const id = require.resolve('../providers/netmirror');
    const run = async () => {
        guard.reset();
        delete require.cache[id];
        calls = [];
        const nm = require('../providers/netmirror');
        assert.strictEqual(await nm._resolveNewTvApi(), 'https://api.nm.test');
        return calls.slice();
    };
    const today = await run();
    config.shared._setRemote({ version: 2, netmirror: { domains: ['https://d1.test', 'https://d2.test', 'https://d3.test', 'https://d4.test'] } });
    const withCfg = await run();
    assert.strictEqual(withCfg.length, today.length);
    assert.strictEqual(today.length, 3);
    assert.ok(withCfg.every((u) => /^https:\/\/d[123]\.test\/checknewtv\.php$/.test(u)), withCfg.join('\n'));
    assert.match(today[0], /checknewtv\.php$/);
});
