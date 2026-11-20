'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// NetMirror throttle guard (N7): cool-down, newtv block, call budget and the
// long cache, all persisted so a restart does not re-hammer NetMirror.
const { createGuard } = require('../utils/netmirrorGuard');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function clock(start = 1_000_000_000_000) {
    let t = start;
    return { now: () => t, add: (ms) => { t += ms; } };
}
const quiet = () => {};

test('cool-down opens at 10 min, doubles per re-open up to 2h, resets on a real master', () => {
    const c = clock();
    const g = createGuard({ file: null, now: c.now, log: quiet });
    assert.equal(g.coolingMs(), 0);
    g.throttleOpen('clip');
    assert.equal(g.coolingMs(), 10 * MIN);
    // A second signal while open does not double.
    g.throttleOpen('otp');
    assert.equal(g.coolingMs(), 10 * MIN);
    const seen = [];
    for (let i = 0; i < 6; i++) {
        c.add(g.coolingMs());
        assert.equal(g.coolingMs(), 0);
        g.throttleOpen('clip');
        seen.push(g.coolingMs() / MIN);
    }
    assert.deepEqual(seen, [20, 40, 80, 120, 120, 120]);
    g.throttleClose('real-master');
    assert.equal(g.coolingMs(), 0);
    g.throttleOpen('http-429');
    assert.equal(g.coolingMs(), 10 * MIN, 'reset back to 10 min');
});

test('throttle-open and throttle-close are logged', () => {
    const c = clock();
    const logs = [];
    const g = createGuard({ file: null, now: c.now, log: (l) => logs.push(l) });
    g.throttleOpen('clip');
    g.throttleClose('real-master');
    assert.ok(logs.some((l) => /^\[netmirror\] throttle-open reason=clip for=600s/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /^\[netmirror\] throttle-close reason=real-master/.test(l)), logs.join('\n'));
});

test('cool-down, newtv block, bucket and cache survive a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmguard-'));
    const file = path.join(dir, 'state.json');
    const c = clock();
    const a = createGuard({ file, now: c.now, log: quiet });
    a.throttleOpen('clip');
    a.newtvBlock('page-not-found');
    for (let i = 0; i < 4; i++) assert.equal(a.take(), true);
    a.cacheSet('post|nf|81', { lang: ['Telugu'] }, 7 * 24 * HOUR);
    a.flush();
    const b = createGuard({ file, now: c.now, log: quiet });
    assert.equal(b.coolingMs(), 10 * MIN);
    assert.equal(b.newtvBlockedMs(), 6 * HOUR);
    assert.equal(b.tokens(), 2, 'a restart does not refill the bucket');
    assert.deepEqual(b.cacheGet('post|nf|81'), { lang: ['Telugu'] });
    // Doubling state survives too.
    c.add(10 * MIN);
    b.throttleOpen('clip');
    assert.equal(b.coolingMs(), 20 * MIN);
});

test('newtv block holds 6h, then allows one re-probe', () => {
    const c = clock();
    const g = createGuard({ file: null, now: c.now, log: quiet });
    g.newtvBlock('page-not-found');
    assert.equal(g.newtvBlockedMs(), 6 * HOUR);
    c.add(6 * HOUR - 1);
    assert.ok(g.newtvBlockedMs() > 0);
    c.add(1);
    assert.equal(g.newtvBlockedMs(), 0, 're-probe allowed');
    g.newtvBlock('page-not-found');
    assert.equal(g.newtvBlockedMs(), 6 * HOUR, 'a refused re-probe blocks again');
});

test('bucket: 6 calls per 5 min, one token back every 50s, never above 6', () => {
    const c = clock();
    const g = createGuard({ file: null, now: c.now, log: quiet });
    for (let i = 0; i < 6; i++) assert.equal(g.take(), true, `call ${i + 1}`);
    assert.equal(g.take(), false, 'seventh call in the window is refused');
    c.add(49 * 1000);
    assert.equal(g.take(), false);
    c.add(1000);
    assert.equal(g.take(), true, 'one token after 50s');
    c.add(HOUR);
    assert.equal(g.tokens(), 6);
});

test('cache entries expire at their own TTL', () => {
    const c = clock();
    const g = createGuard({ file: null, now: c.now, log: quiet });
    g.cacheSet('search|nf|x', { rows: [] }, 30 * MIN);
    g.cacheSet('post|nf|1', { lang: ['Hindi'] }, 7 * 24 * HOUR);
    c.add(30 * MIN);
    assert.equal(g.cacheGet('search|nf|x'), undefined);
    assert.deepEqual(g.cacheGet('post|nf|1'), { lang: ['Hindi'] });
});


test('authenticated allowance is independent, bounded at 24, refills, and persists without credentials', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nm-auth-'));const file=path.join(dir,'state.json');const c=clock();
    const a=createGuard({file,now:c.now,log:quiet});
    for(let i=0;i<6;i++)assert.equal(a.take(),true);
    assert.equal(a.take(),false);assert.equal(a.tokens(true),24);
    for(let i=0;i<24;i++)assert.equal(a.take(true),true);
    assert.equal(a.take(true),false);a.flush();
    const b=createGuard({file,now:c.now,log:quiet});assert.equal(b.tokens(),0);assert.equal(b.tokens(true),0);
    c.add(12500);assert.equal(b.take(true),true);assert.equal(b.take(true),false);assert.equal(b.take(),false);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file,'utf8')).authBucket).sort(),['at','tokens']);
});

test('loading an older state initializes auth allowance without resetting anonymous, refusal, cooldown or cache', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nm-old-'));const file=path.join(dir,'state.json');const c=clock();
    const a=createGuard({file,now:c.now,log:quiet});a.take();a.throttleOpen('clip');a.newtvBlock('refused');a.cacheSet('keep',1,100000);a.flush();
    const old=JSON.parse(fs.readFileSync(file,'utf8'));delete old.authBucket;fs.writeFileSync(file,JSON.stringify(old));
    const b=createGuard({file,now:c.now,log:quiet});assert.equal(b.tokens(),5);assert.equal(b.tokens(true),24);
    assert.ok(b.coolingMs()>0);assert.ok(b.newtvBlockedMs()>0);assert.equal(b.cacheGet('keep'),1);
});
