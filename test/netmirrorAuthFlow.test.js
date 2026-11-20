'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
process.env.NETMIRROR_OTP = '111111';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Test Movie', release_date: '2024-01-01' }) });
stub('lib/media/mp4AudioProbe.js', { probeAudioTracks: async () => [] });
const { guard } = require('../utils/netmirrorGuard');
const moduleId = require.resolve('../providers/netmirror');
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
const realMaster = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="tel",NAME="[4] Telugu",URI="a/te.m3u8"\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="hin",NAME="Hindi",URI="a/hi.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="a"\nhttps://cdn.example/files/123/1080p.m3u8\n';
const clipMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\nhttps://cdn.example/files/220884/1080p.m3u8\n';
let provider;
beforeEach(() => { guard.reset(); delete require.cache[moduleId]; provider = require(moduleId); });

function install({ challengeAt = 'search.php', invalidOtp = false, repeated = false, series = false, clip = false, rejectJson = false } = {}) {
    const calls = [];
    global.fetch = async (url, init = {}) => {
        const u = new URL(url);
        const headers = init.headers || {};
        calls.push({ path: u.pathname, headers, redirect: init.redirect });
        if (headers.Range) return new Response('', { status: 206 });
        if (u.pathname.includes('/api/embed-tmdb/')) return json({ ok: true, streams: [] });
        if (u.pathname === '/checknewtv.php') return json({ token_hash: Buffer.from('https://newtv.example').toString('base64') });
        if (u.pathname === '/newtv/otp.php') {
            assert.equal(headers.Otp, '111111');
            assert.match(headers['User-Agent'], /OS\.Gatu v1\.0$/);
            return json(invalidOtp ? { status: 'error' } : { status: 'ok', usertoken: 'private-session-token' });
        }
        if (u.pathname.startsWith('/newtv/')) {
            if (rejectJson) return new Response(JSON.stringify({ status: 'error' }), { status: 403 });
            if (headers.Ott !== 'nf') return json({ searchResult: [] });
            if (u.pathname.endsWith(challengeAt) && (repeated || headers.Usertoken !== 'private-session-token')) {
                // A challenge may carry a decoy link. It must not be fetched
                // before auth retries the ORIGINAL player operation.
                return json({ status: 'otp', video_link: 'https://cdn.example/clip.m3u8' });
            }
            if (u.pathname.endsWith('ott.php')) return json({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) });
            if (u.pathname.endsWith('search.php')) return json({ searchResult: [{ id: '123', t: 'Test Movie' }] });
            if (u.pathname.endsWith('post.php')) return json({ type: series ? 't' : 'm', main_id: '123',
                lang: [{ l: 'Telugu' }, { l: 'Hindi' }], ...(series ? { season: [{ id: 's1', selected: true }], nextPageShow: 1, episodes: [] } : {}) });
            if (u.pathname.endsWith('episodes.php')) return json({ episodes: [{ id: '123', ep: '2' }] });
            if (u.pathname.endsWith('player.php')) return json({ status: 'ok', video_link: 'https://cdn.example/master.m3u8', referer: 'https://newtv.example/' });
        }
        if (u.hostname === 'cdn.example') return new Response(clip ? clipMaster : realMaster);
        throw new Error(`unexpected route ${url}`);
    };
    return calls;
}

for (const challengeAt of ['ott.php', 'search.php', 'post.php', 'player.php', 'episodes.php']) {
    test(`${challengeAt} requires auth: verify before metadata, carry credentials downstream, keep every audio language`, async () => {
        const series = challengeAt === 'episodes.php';
        const calls = install({ challengeAt, series });
        const rows = await provider.getNetmirrorStreams(101, series ? 'tv' : 'movie', series ? 1 : null, series ? 2 : null);
        const hls = rows.find((s) => s.url === 'https://cdn.example/master.m3u8');
        assert.ok(hls, 'authenticated player row returned');
        assert.deepEqual(hls.audio.map((a) => a.language), ['Telugu', 'Hindi']);
        assert.equal(hls.selectableAudio, true);
        assert.match(hls.language, /Telugu\/Hindi/);
        const authIndex = calls.findIndex((c) => c.path === '/newtv/otp.php');
        assert.ok(authIndex > 0);
        for (const c of calls.filter((c) => c.path.startsWith('/newtv/'))) {
            assert.equal(c.redirect, 'error', 'custom credential headers cannot follow a redirect');
        }
        assert.equal(calls[authIndex + 1].path, '/newtv/ott.php', 'verification precedes the first metadata request');
        for (const c of calls.slice(authIndex + 1).filter((c) => c.path.startsWith('/newtv/'))) {
            assert.equal(c.headers.Usertoken, 'private-session-token', c.path);
        }
        for (const c of calls.filter((c) => c.path.endsWith('.m3u8'))) {
            assert.equal(c.headers.Usertoken, undefined, 'token never sent to the media CDN');
        }
        assert.equal(hls.headers.Usertoken, undefined, 'token never exposed in browser/proxy stream headers');
        assert.ok(!JSON.stringify(rows).includes('private-session-token'));
        assert.ok(!calls.some((c) => c.path === '/clip.m3u8'), 'unauthenticated clip never inspected');
        assert.equal(guard.coolingMs(), 0, 'successful auth is not a throttle');
    });
}

test('invalid OTP is an upstream failure and cannot become empty cached metadata', async () => {
    const calls = install({ challengeAt: 'post.php', invalidOtp: true });
    await assert.rejects(provider.getNetmirrorStreams(102, 'movie'), /OTP verification required/);
    assert.equal(calls.filter((c) => c.path === '/newtv/otp.php').length, 1);
    assert.equal(guard.cacheGet('nt3|nf|/newtv/post.php?id=123'), undefined);
    assert.ok(!calls.some((c) => c.path === '/newtv/player.php'));
});

test('a player rejecting the established token renews once and never fetches its decoy', async () => {
    const calls = install({ challengeAt: 'player.php', repeated: true });
    await assert.rejects(provider.getNetmirrorStreams(103, 'movie'), /OTP verification required/);
    assert.equal(calls.filter((c) => c.path === '/newtv/player.php').length, 2);
    assert.equal(calls.filter((c) => c.path === '/newtv/otp.php').length, 2);
    assert.ok(!calls.some((c) => c.path.endsWith('.m3u8')));
});

test('authenticated status ok still cannot admit a wrong-title master', async () => {
    const calls = install({ challengeAt: 'player.php', clip: true });
    await assert.rejects(provider.getNetmirrorStreams(104, 'movie'), /netmirror-throttled/);
    assert.equal(calls.filter((c) => c.path === '/newtv/otp.php').length, 1);
    assert.ok(guard.coolingMs() > 0);
});


test('JSON HTTP errors remain failures instead of becoming cached empty catalogues', async () => {
    const calls = install({ rejectJson: true });
    await assert.rejects(provider.getNetmirrorStreams(105, 'movie'), /HTTP 403/);
    assert.equal(guard.cacheGet('nt3|nf|/newtv/search.php?s=Test%20Movie'), undefined);
    assert.ok(!calls.some((c) => c.path === '/newtv/player.php'));
});


test('cold series resolves all catalogs with two anonymous calls and a bounded authenticated allowance', async () => {
    const calls=install({challengeAt:'player.php',series:true});
    while(guard.tokens()>6) guard.take();
    const rows=await provider.getNetmirrorStreams(202,'tv',1,2);
    assert.ok(rows.some(s=>s.url==='https://cdn.example/master.m3u8'));
    assert.equal(calls.filter(c=>c.path.startsWith('/newtv/')||c.path==='/checknewtv.php').length,9);
    assert.equal(guard.tokens(),4);
    assert.equal(guard.tokens(true),17);
    assert.equal(rows.upstreamError,undefined);
    assert.equal(calls.filter(c=>c.path==='/newtv/player.php').length,1);
    assert.equal(calls.filter(c=>c.path==='/newtv/otp.php').length,1);
    assert.equal(calls.find(c=>c.path==='/newtv/player.php').headers.Usertoken,'private-session-token');
});


test('an exhausted anonymous bucket does not block a current valid token', async () => {
    install();await provider.getNetmirrorStreams(203,'movie');
    while(guard.take()) { /* anonymous exhausted */ }
    guard.cacheDelete('nt3|nf|player|123');
    const calls=install();const rows=await provider.getNetmirrorStreams(204,'movie');
    assert.ok(rows.some(s=>s.url==='https://cdn.example/master.m3u8'));
    assert.equal(calls.filter(c=>c.path==='/newtv/player.php').length,1);
    assert.ok(!calls.some(c=>c.path==='/newtv/otp.php'||c.path==='/checknewtv.php'));
});

test('authenticated allowance exhaustion stops metadata before sending and reports partial failure', async () => {
    while(guard.take(true)) { /* auth allowance exhausted */ }
    const calls=install();await assert.rejects(provider.getNetmirrorStreams(205,'movie'),/netmirror-budget/);
    assert.equal(calls.filter(c=>c.path==='/newtv/otp.php').length,1);
    assert.ok(!calls.some(c=>c.path==='/newtv/ott.php'||c.path==='/newtv/search.php'));
});

test('a freshly verified metadata token rejected immediately gets no second exchange', async () => {
    const calls=install({challengeAt:'ott.php',repeated:true});
    await assert.rejects(provider.getNetmirrorStreams(206,'movie'),/OTP verification required/);
    assert.equal(calls.filter(c=>c.path==='/newtv/ott.php').length,1);
    assert.equal(calls.filter(c=>c.path==='/newtv/otp.php').length,1);
});

test('authenticated HTTP 429 opens the same shared cooldown and the next lookup sends nothing', async () => {
    const calls=install();const route=global.fetch;
    global.fetch=async(url,init)=>String(url).includes('/newtv/search.php')?new Response('',{status:429}):route(url,init);
    await assert.rejects(provider.getNetmirrorStreams(207,'movie'),/netmirror-throttled/);
    assert.ok(guard.coolingMs()>0);const before=calls.length;
    await assert.rejects(provider.getNetmirrorStreams(208,'movie'),/netmirror-throttled/);
    assert.equal(calls.length,before);
});


test('authenticated IP refusal blocks subsequent newtv calls using the shared refusal gate', async () => {
    const calls=install();const route=global.fetch;
    global.fetch=async(url,init)=>String(url).includes('/newtv/ott.php')?new Response('<html>Page Not Found</html>',{status:403}):route(url,init);
    await assert.rejects(provider.getNetmirrorStreams(209,'movie'),/netmirror-newtv-blocked/);
    assert.ok(guard.newtvBlockedMs()>0);const before=calls.filter(c=>c.path.startsWith('/newtv/')).length;
    await assert.rejects(provider.getNetmirrorStreams(210,'movie'),/netmirror-newtv-blocked/);
    assert.equal(calls.filter(c=>c.path.startsWith('/newtv/')).length,before);
});
