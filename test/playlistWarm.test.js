'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const cache = require('../proxy/playlistTextCache');
const { createProxyRoutes, warmPlaylists } = require('../proxy/proxyServer');

beforeEach(() => cache._reset());

const VOD = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg-1.ts\n#EXT-X-ENDLIST\n';
const LIVE = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg-1.ts\n';

test('playlist cache: keeps masters and finished playlists, never live ones or non-playlists', () => {
    assert.equal(cache.put('https://h/a.m3u8', {}, VOD), true);
    assert.equal(cache.get('https://h/a.m3u8', {}), VOD);
    assert.equal(cache.put('https://h/live.m3u8', {}, LIVE), false);
    assert.equal(cache.put('https://h/x.m3u8', {}, '<html>nope</html>'), false);
    assert.equal(cache.get('https://h/live.m3u8', {}), null);
});

test('playlist cache: headers are part of the key; TTL and signed expiry bound an entry', () => {
    const now = 1_800_000_000_000;
    cache.put('https://h/a.m3u8', { Referer: 'https://r/' }, VOD, now);
    assert.equal(cache.get('https://h/a.m3u8', {}, now), null);
    assert.equal(cache.get('https://h/a.m3u8', { Referer: 'https://r/' }, now), VOD);
    assert.equal(cache.get('https://h/a.m3u8', { Referer: 'https://r/' }, now + cache.TTL_MS), null);
    // Signed to expire in 30 s: inside the 60 s skew, so not kept at all.
    const exp = Math.floor((now + 30_000) / 1000);
    assert.equal(cache.put(`https://h/b.m3u8?expires=${exp}`, {}, VOD, now), false);
});

// Shape of insertunit's RRR master: Russian DEFAULT, Telugu among the
// renditions, two rungs. A player starting low with Telugu reads exactly
// master, the 360p rung and the te audio playlist.
const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Rus",LANGUAGE="ru",DEFAULT=YES,URI="index-a1.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Original",LANGUAGE="te",URI="index-a7.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2415961,RESOLUTION=1280x720,AUDIO="audio0"',
    'index-v1.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=849219,RESOLUTION=640x360,AUDIO="audio0"',
    'index-v2.m3u8',
    '',
].join('\n');

test('warmPlaylists: master, lowest rung and the Telugu audio; the open then reads them from memory', async () => {
    const hits = [];
    const origin = http.createServer((req, res) => {
        hits.push(req.url.split('?')[0]);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(req.url.startsWith('/m/master.m3u8') ? MASTER : VOD);
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    try {
        const P = `http://127.0.0.1:${proxy.address().port}`;
        const O = `http://127.0.0.1:${origin.address().port}`;
        const h = encodeURIComponent(JSON.stringify({ 'User-Agent': 'UA-row' }));
        const rowUrl = `${P}/m3u8-proxy?url=${encodeURIComponent(`${O}/m/master.m3u8`)}&headers=${h}`;
        const n = await warmPlaylists(rowUrl);
        assert.equal(n, 3);
        assert.deepStrictEqual(hits.sort(), ['/m/index-a7.m3u8', '/m/index-v2.m3u8', '/m/master.m3u8']);
        // The player's own requests, built from the rewritten master.
        const m = await (await fetch(rowUrl)).text();
        const te = m.split('\n').find((l) => l.includes('LANGUAGE="te"')).match(/URI="([^"]+)"/)[1];
        const low = m.split('\n').filter((l) => l && !l.startsWith('#')).find((l) => decodeURIComponent(l).includes('index-v2'));
        assert.equal((await fetch(new URL(te, P))).status, 200);
        assert.equal((await fetch(new URL(low, P))).status, 200);
        // (The proxy may prefetch a first segment; only playlists count here.)
        const playlists = hits.filter((x) => x.endsWith('.m3u8'));
        assert.equal(playlists.length, 3, `upstream re-read: ${hits.join(',')}`);
    } finally {
        proxy.close();
        origin.close();
    }
});

test('warmPlaylists: not a proxy url, or a hybrid rebase url, does nothing', async () => {
    assert.equal(await warmPlaylists('https://cdn.example/master.m3u8'), 0);
    assert.equal(await warmPlaylists('http://127.0.0.1:1/m3u8-proxy?url=http%3A%2F%2Fx%2Fa.m3u8&rebase=1&pts=0'), 0);
});
