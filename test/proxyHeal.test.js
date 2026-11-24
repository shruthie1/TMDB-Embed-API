'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A3 (VM logs 2026-11-21..22): vidrift moved embed.vidrift.net -> .in. Its
// masters answered 404 on /m3u8-proxy for ~16 h, but only resolve failures fed
// the heal streak, so the heal came 14 h late. After it, cached rows on the
// old host kept failing (25 `.net` 404s after the adopt).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxyheal-'));
const FILE = path.join(dir, 'missing', 'provider-bases.json');
process.env.UPSTREAM_BASES_FILE = FILE;

const up = require('../utils/upstreamBase');
const registry = require('../providers/registry');
const { createTtlCache } = require('../lib/runtime/ttlCache');
const { evictHostRows } = require('../lib/selfheal/evictOnHeal');

const vidrift = require('../providers/vidrift');
const SEED = vidrift.UPSTREAM.seed;
const master = (n) => `${up.getBase('vidrift', SEED)}/api/orion/H${n}/master.m3u8`;

let realTrigger; let triggered;
beforeEach(() => {
    up._reset();
    registry._resetProxyStreaks();
    triggered = [];
    realTrigger = up.triggerRediscover;
    up.triggerRediscover = (name) => { triggered.push(name); return Promise.resolve({ applied: null }); };
});
afterEach(() => { up.triggerRediscover = realTrigger; up._reset(); });

test('proxy 404s on a provider base host start that provider\'s rediscover', () => {
    for (let i = 0; i < up.FAIL_STREAK - 1; i++) registry.noteProxyStatus(master(i), 404);
    assert.deepEqual(triggered, [], 'rediscover started before the streak');
    registry.noteProxyStatus(master(99), 404);
    assert.deepEqual(triggered, ['vidrift']);
});

test('a proxy 2xx on the host resets the proxy streak', () => {
    for (let i = 0; i < up.FAIL_STREAK - 1; i++) registry.noteProxyStatus(master(i), 404);
    registry.noteProxyStatus(master(50), 200);
    for (let i = 0; i < up.FAIL_STREAK - 1; i++) registry.noteProxyStatus(master(i + 10), 404);
    assert.deepEqual(triggered, []);
});

test('403, 5xx and hosts no provider uses never count', () => {
    for (let i = 0; i < up.FAIL_STREAK * 2; i++) {
        registry.noteProxyStatus(master(i), 403);
        registry.noteProxyStatus(master(i), 502);
        registry.noteProxyStatus(`https://cdn.unrelated.example/x${i}.m3u8`, 404);
    }
    assert.deepEqual(triggered, []);
});

test('a host change notifies listeners with the previous base', async () => {
    const seen = [];
    const off = up.onHostApplied((name, applied, previous) => seen.push([name, applied, previous]));
    try {
        const f = async () => { throw new Error('getaddrinfo ENOTFOUND x'); };
        const out = await up.rediscover('vidrift', {
            seed: 'https://embed.vidrift.net',
            extra: ['https://embed.vidrift.in'],
            verify: async (u) => u === 'https://embed.vidrift.in',
        }, { fetch: f, budgetMs: 200 });
        assert.equal(out.applied, 'https://embed.vidrift.in');
        assert.deepEqual(seen, [['vidrift', 'https://embed.vidrift.in', 'https://embed.vidrift.net']]);
    } finally { off(); }
});

test('evictHostRows drops cached rows and answers on the replaced host only', () => {
    const hit = createTtlCache({ ttlMs: 60000, maxEntries: 100 });
    const empty = createTtlCache({ ttlMs: 60000, maxEntries: 100 });
    const memo = createTtlCache({ ttlMs: 60000, maxEntries: 100 });
    const old = 'https://embed.vidrift.net/api/orion/A/master.m3u8';
    hit.set('vidrift|movie:1:::', [{ url: old }]);
    hit.set('vidrift|movie:2:::', [{ url: 'https://embed.vidrift.in/api/orion/B/master.m3u8' }]);
    hit.set('castletv|movie:1:::', [{ url: 'https://castle.example/a.m3u8' }]);
    empty.set('vidrift|movie:3:::', true);
    empty.set('castletv|movie:3:::', true);
    memo.set('movie:1:::a', { streams: [{ url: `https://api.example/m3u8-proxy?url=${encodeURIComponent(old)}` }] });
    memo.set('movie:9:::a', { streams: [{ url: 'https://castle.example/a.m3u8' }] });
    const n = evictHostRows({ providerHitCache: hit, providerEmptyCache: empty, streamsMemo: memo },
        'vidrift', 'https://embed.vidrift.net');
    assert.deepEqual(n, { hits: 1, empties: 1, memo: 1 });
    assert.equal(hit.get('vidrift|movie:1:::'), undefined);
    assert.ok(hit.get('vidrift|movie:2:::'));
    assert.ok(hit.get('castletv|movie:1:::'));
    assert.equal(empty.get('vidrift|movie:3:::'), undefined);
    assert.ok(empty.get('castletv|movie:3:::'));
    assert.equal(memo.get('movie:1:::a'), undefined);
    assert.ok(memo.get('movie:9:::a'));
});
