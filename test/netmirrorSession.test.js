'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNewTvSession } = require('../utils/netmirrorSession');

const challenge = { status: 'otp', video_link: 'https://cdn.example/placeholder.m3u8' };
const ok = { status: 'ok', video_link: 'https://cdn.example/real.m3u8' };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function fixture(options = {}) {
    let exchanges = 0;
    const tokens = [];
    const client = createNewTvSession({ credential: () => '111111',
        exchange: async () => ({ status: 'ok', usertoken: `secret-${++exchanges}` }), ...options });
    const send = async (token) => { tokens.push(token); return token ? ok : challenge; };
    return { client, send, tokens, exchanges: () => exchanges };
}

test('OTP challenge exchanges once, retries what runs next, and reuses the token', async () => {
    const f = fixture();
    assert.equal(await f.client.request('https://api.example', f.send), ok);
    assert.deepEqual(f.tokens, ['', 'secret-1']);
    assert.equal(await f.client.request('https://api.example', f.send), ok);
    assert.deepEqual(f.tokens, ['', 'secret-1', 'secret-1']);
    assert.equal(f.exchanges(), 1);
});

test('a success needs no extra verification request; credentials remain opt-in', async () => {
    const f = fixture();
    assert.equal(await f.client.request('https://api.example', async () => ok), ok);
    assert.equal(f.exchanges(), 0);
    const disabled = fixture({ credential: () => '' });
    assert.equal(await disabled.client.request('https://api.example', disabled.send), challenge);
    assert.equal(disabled.exchanges(), 0);
});

test('simultaneous challenges share one exchange and all resume with the token', async () => {
    const exchange = deferred();
    let calls = 0;
    const f = fixture({ exchange: async () => { calls++; return exchange.promise; } });
    const requests = Array.from({ length: 5 }, () => f.client.request('https://api.example', f.send));
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    exchange.resolve({ status: 'ok', usertoken: 'shared' });
    assert.deepEqual(await Promise.all(requests), Array(5).fill(ok));
    assert.equal(f.tokens.filter((t) => t === 'shared').length, 5);
});

test('a delayed rejection cannot invalidate a newer token', async () => {
    const f = fixture();
    await f.client.request('https://api.example', f.send);
    const delayed = deferred();
    const stale = f.client.request('https://api.example', async (token) => {
        if (token === 'secret-1') return delayed.promise;
        return f.send(token);
    });
    await f.client.request('https://api.example', async (token) => token === 'secret-1' ? challenge : f.send(token));
    delayed.resolve(challenge);
    assert.equal(await stale, ok);
    assert.equal(f.exchanges(), 2, 'no third exchange for the old rejection');
    await f.client.request('https://api.example', f.send);
    assert.equal(f.tokens.at(-1), 'secret-2');
});

test('origin and credential changes do not reuse credentials from another session', async () => {
    let otp = '111111';
    const f = fixture({ credential: () => otp });
    await f.client.request('https://one.example', f.send);
    await f.client.request('https://two.example', f.send);
    otp = '222222';
    await f.client.request('https://one.example', f.send);
    assert.deepEqual(f.tokens, ['', 'secret-1', '', 'secret-2', '', 'secret-3']);
});

test('local token TTL bounds reuse but does not claim upstream expiry', async () => {
    let now = 1;
    const f = fixture({ now: () => now, ttlMs: 100 });
    await f.client.request('https://api.example', f.send);
    now += 101;
    await f.client.request('https://api.example', f.send);
    assert.deepEqual(f.tokens, ['', 'secret-1', '', 'secret-2']);
});

test('invalid OTP does not become a token; retries pause, then can recover', async () => {
    let now = 1;
    let exchanges = 0;
    const f = fixture({ now: () => now, failureMs: 100, exchange: async () => {
        exchanges++;
        return exchanges === 1 ? { status: 'error', error_msg: 'secret server text' } : { status: 'ok', usertoken: 'valid' };
    } });
    await assert.rejects(f.client.request('https://api.example', f.send), { code: 'NETMIRROR_AUTH_REQUIRED' });
    await assert.rejects(f.client.request('https://api.example', f.send), { code: 'NETMIRROR_AUTH_REQUIRED' });
    assert.equal(exchanges, 1);
    now += 101;
    assert.equal(await f.client.request('https://api.example', f.send), ok);
    assert.equal(exchanges, 2);
});

test('a repeated otp is bounded to one renewal and the token is invalidated', async () => {
    const f = fixture();
    let sends = 0;
    await assert.rejects(f.client.request('https://api.example', async () => { sends++; return challenge; }),
        { code: 'NETMIRROR_AUTH_REQUIRED' });
    assert.equal(sends, 2);
    assert.equal(f.exchanges(), 1);
    await assert.rejects(f.client.request('https://api.example', f.send), { code: 'NETMIRROR_AUTH_REQUIRED' });
    assert.equal(f.tokens.at(-1), '', 'rejected token not reused');
});

test('budget and IP-refusal gates retain their meaning and the next request may recover', async () => {
    const gate = Object.assign(new Error('budget'), { code: 'NM_BUDGET', gate: true });
    let fail = true;
    const f = fixture({ exchange: async () => { if (fail) throw gate; return { status: 'ok', usertoken: 'valid' }; } });
    await assert.rejects(f.client.request('https://api.example', f.send), (e) => e === gate);
    fail = false;
    assert.equal(await f.client.request('https://api.example', f.send), ok);
});

test('credentials are never sent to an insecure or credential-bearing API URL', async () => {
    const f = fixture();
    let sends = 0;
    for (const api of ['http://api.example', 'https://user:pass@api.example']) {
        await assert.rejects(f.client.request(api, async () => { sends++; return challenge; }),
            { code: 'NETMIRROR_AUTH_REQUIRED' });
    }
    assert.equal(sends, 0);
    assert.equal(f.exchanges(), 0);
    assert.equal(await f.client.request('https://api.example', f.send), ok, 'valid next request still succeeds');
});


test('player opt-in authenticates before sending and reuses the token on the next operation', async () => {
    const f = fixture();
    assert.equal(await f.client.request('https://api.example', f.send, {ensureToken:true}), ok);
    assert.deepEqual(f.tokens,['secret-1']);
    assert.equal(await f.client.request('https://api.example', f.send, {ensureToken:true}),ok);
    assert.deepEqual(f.tokens,['secret-1','secret-1']);
    assert.equal(f.exchanges(),1);
});

test('a freshly issued player token rejection is bounded and pauses the next exchange', async () => {
    let now=1;
    const f=fixture({now:()=>now,failureMs:100});
    let sends=0;
    const reject=async()=>{sends++;return challenge;};
    await assert.rejects(f.client.request('https://api.example',reject,{ensureToken:true}),{code:'NETMIRROR_AUTH_REQUIRED'});
    await assert.rejects(f.client.request('https://api.example',reject,{ensureToken:true}),{code:'NETMIRROR_AUTH_REQUIRED'});
    assert.equal(sends,1);
    assert.equal(f.exchanges(),1);
    now+=101;
    assert.equal(await f.client.request('https://api.example',f.send,{ensureToken:true}),ok);
    assert.deepEqual(f.tokens,['secret-2']);
});

test('an existing player token can renew once after rejection and replay immediately', async () => {
    const f=fixture();
    await f.client.request('https://api.example',f.send,{ensureToken:true});
    assert.equal(await f.client.request('https://api.example',async token=>token==='secret-1'?challenge:f.send(token),{ensureToken:true}),ok);
    assert.equal(f.exchanges(),2);
    assert.equal(f.tokens.at(-1),'secret-2');
});


test('concurrent cold player requests share verification and each sends only its authenticated operation', async () => {
    const exchange=deferred();let exchanges=0;
    const f=fixture({exchange:async()=>{exchanges++;return exchange.promise;}});
    const requests=Array.from({length:4},()=>f.client.request('https://api.example',f.send,{ensureToken:true}));
    await new Promise(setImmediate);
    assert.equal(exchanges,1);assert.equal(f.tokens.length,0);
    exchange.resolve({status:'ok',usertoken:'shared'});
    assert.deepEqual(await Promise.all(requests),Array(4).fill(ok));
    assert.deepEqual(f.tokens,Array(4).fill('shared'));
});

test('player preauthentication gate spends no send and the next operation can recover', async () => {
    const gate=Object.assign(new Error('budget'),{code:'NM_BUDGET',gate:true});let fail=true;
    const f=fixture({exchange:async()=>{if(fail)throw gate;return {status:'ok',usertoken:'valid'};}});
    await assert.rejects(f.client.request('https://api.example',f.send,{ensureToken:true}),e=>e===gate);
    assert.deepEqual(f.tokens,[]);fail=false;
    assert.equal(await f.client.request('https://api.example',f.send,{ensureToken:true}),ok);
    assert.deepEqual(f.tokens,['valid']);
});


test('session presence is scoped and expiry triggers proactive renewal before the next metadata send', async () => {
    let now=1;const f=fixture({now:()=>now,ttlMs:100});
    assert.equal(f.client.hasToken('https://api.example'),false);
    await f.client.request('https://api.example',f.send,{ensureToken:true});
    assert.equal(f.client.hasToken('https://api.example'),true);assert.equal(f.client.hasToken('https://other.example'),false);
    now+=101;assert.equal(f.client.hasToken('https://api.example'),false);
    assert.equal(await f.client.request('https://api.example',f.send,{ensureToken:true}),ok);
    assert.deepEqual(f.tokens,['secret-1','secret-2']);assert.equal(f.exchanges(),2);
});
