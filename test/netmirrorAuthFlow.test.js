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

for (const challengeAt of ['search.php', 'post.php', 'player.php', 'episodes.php']) {
    test(`${challengeAt} challenge: exchange, replay, carry credentials downstream, keep every audio language`, async () => {
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
        assert.equal(calls[authIndex + 1].path, `/newtv/${challengeAt}`, 'original operation retried immediately');
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
    assert.equal(guard.cacheGet('nt|nf|/newtv/post.php?id=123'), undefined);
    assert.ok(!calls.some((c) => c.path === '/newtv/player.php'));
});

test('a repeated auth challenge stops after one replay, without fetching its decoy', async () => {
    const calls = install({ challengeAt: 'player.php', repeated: true });
    await assert.rejects(provider.getNetmirrorStreams(103, 'movie'), /OTP verification required/);
    assert.equal(calls.filter((c) => c.path === '/newtv/player.php').length, 2);
    assert.equal(calls.filter((c) => c.path === '/newtv/otp.php').length, 1);
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
    assert.equal(guard.cacheGet('nt|nf|/newtv/search.php?s=Test%20Movie'), undefined);
    assert.ok(!calls.some((c) => c.path === '/newtv/player.php'));
});
