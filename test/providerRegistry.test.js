'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-'));
process.env.UPSTREAM_BASES_FILE = path.join(dir, 'provider-heals.json');
process.env.RESOLVE_CONFIG_FILE = path.join(dir, 'remote.json');
delete process.env.RESOLVE_CONFIG_URL;

// providers/__nm_s.js is an unused copy of netmirror.js with no entry in the
// function map. The registry still listed it as enabled, so every fan-out ran
// it, it returned [] in ~4ms, and it counted toward its own breaker (prod
// 2026-11-15: __nm_s hit 0 / empty 8, trips 4) and showed up in providerTimings.
test('registry only lists provider files that have a mapped entry function', () => {
    const { listProviders } = require('../providers/registry');
    const names = listProviders().map((p) => p.name);
    assert.ok(!names.includes('__nm_s'), `listed: ${names.join(',')}`);
    assert.ok(names.includes('netmirror'));
    assert.ok(names.includes('castletv'));
});

// ---- provider self-heal Task 8: the registry gate and the canary heal ----

const up = require('../utils/upstreamBase');

function captureRediscover(t) {
    const calls = [];
    const real = up.triggerRediscover;
    up.triggerRediscover = (name, opts) => { calls.push({ name, opts }); return null; };
    const warn = console.warn;
    console.warn = () => {};
    t.after(() => { up.triggerRediscover = real; console.warn = warn; up._reset(); });
    up._reset();
    return calls;
}
const info = (name, fn) => ({ name, file: `${name}.js`, functionName: fn });

test('Task 8 (a): 5 mapple failures with a Cloudflare body: zero rediscover calls', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/mapple');
    for (let i = 0; i < 5; i++) _noteUpstream(info('mapple', 'getMappleStreams'), mod, 'fail', { tmdbId: '27205' }, new Error('HTTP 403: <title>Just a moment...</title>'));
    assert.equal(calls.length, 0);
});

test('Task 8 (b): 5 vidrock host errors: one rediscover', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/vidrock');
    for (let i = 0; i < 5; i++) _noteUpstream(info('vidrock', 'getVidrockStreams'), mod, 'fail', { tmdbId: '579974' }, new Error('getaddrinfo ENOTFOUND vidrock.net'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'vidrock');
    assert.equal(typeof calls[0].opts.verify, 'function');
});

test('Task 8 (f): 5 multimovies ENOTFOUND vidbolt.xyz: one rediscover with the VidBolt trails and verify', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/multimovies');
    for (let i = 0; i < 5; i++) _noteUpstream(info('multimovies', 'getMultimoviesStreams'), mod, 'fail', { tmdbId: '27205' }, new Error('getaddrinfo ENOTFOUND vidbolt.xyz'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.trails.length, 2, 'title-page trail + scraper trail');
    assert.equal(typeof calls[0].opts.verify, 'function');
    assert.ok(calls[0].opts.budget && calls[0].opts.budget.max === 12);
});

test('Task 8 (g): 5 vidrift ENOTFOUND embed.vidrift.net: one rediscover with the Task 5B trails and verify', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/vidrift');
    for (let i = 0; i < 5; i++) _noteUpstream(info('vidrift', 'getVidriftStreams'), mod, 'fail', { tmdbId: '579974' }, new Error('getaddrinfo ENOTFOUND embed.vidrift.net'));
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0].opts.trails) && calls[0].opts.trails.length >= 1);
    assert.equal(typeof calls[0].opts.verify, 'function');
});

test('Task 8: healNow(host) starts one rediscover and reports applied + how; inside the cooldown it does nothing', async (t) => {
    const warn = console.warn; console.warn = () => {};
    const real = up.triggerRediscover;
    let n = 0;
    up.triggerRediscover = () => { n++; return n === 1 ? Promise.resolve({ applied: 'https://new.test', candidates: [{ url: 'https://new.test', how: 'redirect' }] }) : null; };
    t.after(() => { up.triggerRediscover = real; console.warn = warn; });
    const { healNow } = require('../providers/registry');
    assert.deepEqual(await healNow('castletv', 'host'), { applied: true, how: 'host:redirect' });
    assert.deepEqual(await healNow('castletv', 'host'), { applied: false });
    assert.deepEqual(await healNow('castletv', 'drift'), { applied: false });
    assert.deepEqual(await healNow('netmirror', 'key'), { applied: false });
});

test('Task 8: verifyTitleOf gives RRR for vidrift/vidrock/onetouchtv and null for castletv', () => {
    const { verifyTitleOf } = require('../providers/registry');
    for (const n of ['vidrift', 'vidrock', 'onetouchtv']) assert.equal(verifyTitleOf(n).tmdbId, '579974');
    assert.equal(verifyTitleOf('castletv'), null);
});

// Soak 1 (VM 2026-11-22 09:12:54Z): 5 vidrift `orionStreams null` answers for
// title 1496785 counted as host fails and moved the host .net -> .in. A
// title-level empty must never move a host.
const titleEmpty = (msg) => Object.assign(new Error(msg), { titleEmpty: true });

test('soak 1: 5 vidrift titleEmpty errors on a non-verify title: zero rediscover, no fail streak', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/vidrift');
    for (let i = 0; i < 6; i++) {
        _noteUpstream(info('vidrift', 'getVidriftStreams'), mod, 'fail', { tmdbId: '1496785' },
            titleEmpty('vidrift: every host failed for 1496785: https://embed.vidrift.net: orionStreams null; https://embed.vidrift.in: orionStreams null'));
    }
    assert.equal(calls.length, 0);
    assert.equal(up.failStreak('vidrift'), 0);
});

test('soak 1: titleEmpty on the provider verify title still counts (RRR must have rows)', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/vidrift');
    for (let i = 0; i < 5; i++) {
        _noteUpstream(info('vidrift', 'getVidriftStreams'), mod, 'fail', { tmdbId: '579974' }, titleEmpty('orionStreams null'));
    }
    assert.equal(calls.length, 1);
});

test('soak 1: 5 multimovies titleEmpty errors (VidBolt 2xx, no source) on a non-verify title: zero rediscover', (t) => {
    const calls = captureRediscover(t);
    const { _noteUpstream } = require('../providers/registry');
    const mod = require('../providers/multimovies');
    for (let i = 0; i < 5; i++) {
        _noteUpstream(info('multimovies', 'getMultimoviesStreams'), mod, 'fail', { tmdbId: '1496785' }, titleEmpty('multimovies vidbolt server(s) not heard: 2(timeout)'));
    }
    assert.equal(calls.length, 0);
});

test('soak 1: the registry wrapper keeps titleEmpty on the [] + upstreamError throw', async (t) => {
    const calls = captureRediscover(t);
    const reg = require('../providers/registry');
    const mm = require('../providers/multimovies');
    const real = mm.getMultimoviesStreams;
    mm.getMultimoviesStreams = async () => Object.assign([], { upstreamError: 'multimovies vidbolt server(s) not heard: vega(cut)', titleEmpty: true });
    t.after(() => { mm.getMultimoviesStreams = real; });
    const p = reg.getProvider('multimovies');
    for (let i = 0; i < 5; i++) {
        await assert.rejects(p.fetch({ tmdbId: '1496785', type: 'movie' }), (e) => e.titleEmpty === true);
    }
    assert.equal(calls.length, 0);
    assert.equal(up.failStreak('multimovies'), 0);
});

// Prod 2026-11-24: vidout's catalogue 404 must reach the fan-out as notListed
// so it stays out of the breaker count.
test('the registry wrapper keeps notListed on an empty result', async (t) => {
    const reg = require('../providers/registry');
    const vo = require('../providers/vidout');
    const real = vo.getVidoutStreams;
    vo.getVidoutStreams = async () => Object.assign([], { notListed: true });
    t.after(() => { vo.getVidoutStreams = real; });
    const out = await reg.getProvider('vidout').fetch({ tmdbId: '27205', type: 'movie' });
    assert.deepStrictEqual([...out], []);
    assert.equal(out.notListed, true);
});
