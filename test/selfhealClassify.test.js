'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { classify, explain, classifyAndLog } = require('../lib/selfheal/classify');

// Task 4: failure -> host | key | token | blocked | drift | down. Strings are
// the real lastErr values from the audit
// (.superpowers/sdd/2026-11-21-audio-pairing-step2/provider-selfheal.md).

test('Cloudflare challenge is blocked, never host', () => {
    assert.strictEqual(classify({ message: 'no requestToken (watch 403, session 403: ... Just a moment...)' }), 'blocked');
    assert.strictEqual(classify({ status: 403, headers: { 'cf-mitigated': 'challenge' } }), 'blocked');
    assert.strictEqual(classify({ status: 200, body: 'const CONFIG = {"rateLimited":true,"apiToken":""}' }), 'blocked');
});

test('scrape miss on a live page is token', () => {
    assert.strictEqual(classify({ message: 'no apiToken on the player page' }), 'token');
});

test('an episode 404 is drift; a 404/410 on the base path is host', () => {
    assert.strictEqual(classify({ message: 'HTTP 404 from api3.devcorp.me/vod/123/episode/1' }), 'drift');
    assert.strictEqual(classify({ message: 'x', status: 404 }), 'drift');
    assert.strictEqual(classify({ message: 'x', status: 404, base: true }), 'host');
    assert.strictEqual(classify({ message: 'x', status: 410, base: true }), 'host');
});

test('DNS / connection / certificate errors are host', () => {
    assert.strictEqual(classify({ message: 'fetch failed ENOTFOUND vidbolt.xyz' }), 'host');
    assert.strictEqual(classify({ message: 'connect ECONNREFUSED 1.2.3.4:443' }), 'host');
    assert.strictEqual(classify({ message: 'getaddrinfo EAI_AGAIN embed.vidrift.net' }), 'host');
    assert.strictEqual(classify({ message: 'unable to verify the first certificate' }), 'host');
});

test('decrypt failures are key', () => {
    let gcmErr;
    try {
        const c = require('crypto');
        const d = c.createDecipheriv('aes-256-gcm', Buffer.alloc(32, 1), Buffer.alloc(12));
        d.setAuthTag(Buffer.alloc(16));
        d.update(Buffer.from('abcd')); d.final();
    } catch (e) { gcmErr = e; }
    assert.ok(gcmErr, 'node produced a GCM error');
    assert.strictEqual(classify({ message: gcmErr.message }), 'key');
    assert.strictEqual(classify({ message: 'error:1C800064:Provider routines::bad decrypt' }), 'key');
    assert.strictEqual(classify({ message: 'decrypted value is not a URL' }), 'key');
    assert.strictEqual(classify({ message: 'Unexpected token in JSON at position 0 (after decrypt)' }), 'key');
});

test('timeouts and 5xx are down', () => {
    assert.strictEqual(classify({ message: 'The operation was aborted due to timeout' }), 'down');
    assert.strictEqual(classify({ message: 'x', status: 502 }), 'down');
    assert.strictEqual(classify({ message: 'socket hang up' }), 'down');
});

test('anything else is drift', () => {
    assert.strictEqual(classify({ message: 'no embedMeta on the page', status: 200 }), 'drift');
    assert.strictEqual(classify({}), 'drift');
});

test('explain names the rule; classifyAndLog logs a greppable line', () => {
    assert.deepStrictEqual(explain({ message: 'fetch failed ENOTFOUND vidbolt.xyz' }), { kind: 'host', rule: 'dns' });
    const lines = [];
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    let k;
    try { k = classifyAndLog('multimovies', { message: 'fetch failed ENOTFOUND vidbolt.xyz' }); } finally { console.warn = orig; }
    assert.strictEqual(k, 'host');
    assert.ok(lines.some((l) => l.startsWith('[selfheal] classify multimovies host rule=dns')), lines.join('\n'));
});

test('429 / throttle is down', () => {
    assert.strictEqual(classify({ status: 429 }), 'down');
    assert.strictEqual(classify({ message: 'multimovies: vidbolt resolve failed for 1: HTTP 429' }), 'down');
});
test('hosting quotas are down/quota even when Cloudflare uses a non-429 status',()=>{
 const {shouldHeal}=require('../lib/selfheal/classify');
 for(const input of [
  {status:503,body:'Error 1027: The owner has reached their plan limits.'},
  {message:'Nexus upstream quota reached',status:429},
  {message:'GD mirror quota cooldown active'},
 ]){assert.deepStrictEqual(explain(input),{kind:'down',rule:'quota'});assert.equal(shouldHeal(explain(input)),false);}
});

// Review I1: a streak of timeouts, resets or refused connections on one host
// heals (the rule before batch 1); HTTP 403 (blocked), 429 (throttle) and
// 5xx (down) skip.
async function streak(msg) {
    const up = require('../utils/upstreamBase');
    const { _noteUpstream } = require('../providers/registry');
    up._reset();
    up._setDeps({ fetch: async (u) => { throw new Error(`getaddrinfo ENOTFOUND ${new URL(u).host}`); }, budgetMs: 500 });
    let trailRuns = 0;
    const mod = { UPSTREAM: { name: 'gatestub', seed: 'https://gate.test', healRun: () => ({ trails: [async () => { trailRuns++; return []; }] }) }, get: async () => [] };
    const info = { name: 'gatestub', functionName: 'get' };
    const lines = [];
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    let started;
    try {
        for (let i = 0; i < up.FAIL_STREAK; i++) _noteUpstream(info, mod, 'fail', { tmdbId: '27205' }, new Error(msg));
        started = up.pending('gatestub') !== null;
        await up.pending('gatestub');
    } finally { console.warn = orig; up._setDeps({}); up._reset(); }
    return { started, trailRuns, lines };
}

for (const [msg, label] of [
    ['timeout after 20000ms', 'registry deadline timeout'],
    ['The operation was aborted due to timeout', 'AbortSignal timeout'],
    ['read ECONNRESET', 'connection reset'],
    ['socket hang up', 'socket hang up'],
    ['connect ECONNREFUSED 1.2.3.4:443', 'connection refused'],
]) {
    test(`I1 registry: a ${label} streak starts a heal run`, async () => {
        const r = await streak(msg);
        assert.strictEqual(r.started, true, r.lines.join('\n'));
        assert.strictEqual(r.trailRuns, 1);
        assert.ok(r.lines.some((l) => l.startsWith('[registry] gatestub failed 5x in a row')), r.lines.join('\n'));
        assert.ok(!r.lines.some((l) => l.startsWith('[heal] gatestub skip rediscover')), r.lines.join('\n'));
    });
}

for (const [msg, kind, rule] of [
    ['vidrock: api HTTP 403 for 27205', 'blocked', 'http-403'],
    ['no requestToken (watch 403, session 403: ... Just a moment...)', 'blocked', 'cloudflare'],
    ['multimovies: resolve HTTP 429', 'down', 'throttle'],
    ['castle: HTTP 502', 'down', '5xx'],
]) {
    test(`I1 registry: ${msg} skips rediscover (${kind} ${rule})`, async () => {
        const r = await streak(msg);
        assert.strictEqual(r.started, false);
        assert.strictEqual(r.trailRuns, 0);
        assert.ok(r.lines.some((l) => l.startsWith(`[heal] gatestub skip rediscover (${kind} ${rule})`)), r.lines.join('\n'));
    });
}

test('I1 status in the message classifies by that status; shouldHeal gate', () => {
    const { explain, shouldHeal } = require('../lib/selfheal/classify');
    assert.deepStrictEqual(explain({ message: 'vidrock: api HTTP 403 for 27205' }), { kind: 'blocked', rule: 'http-403' });
    assert.deepStrictEqual(explain({ message: 'castle: HTTP 521' }), { kind: 'down', rule: '5xx' });
    assert.deepStrictEqual(explain({ message: 'x HTTP 429' }), { kind: 'down', rule: 'throttle' });
    assert.deepStrictEqual(explain({ message: 'read ECONNRESET' }), { kind: 'down', rule: 'reset' });
    assert.deepStrictEqual(explain({ message: 'timeout after 20000ms' }), { kind: 'down', rule: 'timeout' });
    assert.strictEqual(shouldHeal(explain({ message: 'timeout after 20000ms' })), true);
    assert.strictEqual(shouldHeal(explain({ message: 'socket hang up' })), true);
    assert.strictEqual(shouldHeal(explain({ message: 'connect ECONNREFUSED 1.2.3.4:443' })), true);
    assert.strictEqual(shouldHeal(explain({ message: 'HTTP 403' })), false);
    assert.strictEqual(shouldHeal(explain({ message: 'HTTP 429' })), false);
    assert.strictEqual(shouldHeal(explain({ message: 'HTTP 503' })), false);
});
