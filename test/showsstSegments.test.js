'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert');

// Measured 2026-11-24 (movie/1359490, from the VM): the ShowsSt HLS source on
// cdn.ngcloud.app lists 1034 segments on p16-sg.tiktokcdn.com and every one
// answers HTTP 200 image/png, 70 bytes: a 1x1 PNG placeholder. Referer, Origin
// and User-Agent change nothing. The row plays nothing, so it is not offered.

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

const PNG_1X1 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
    + '1f15c4890000000d49444154' + '08d76360606060000000050001' + '5ef32a3a0000000049454e44ae426082', 'hex');

const HLS = {
    meta: null,
    source: { source: 'x', label: 'Vidqueen', url: 'https://cdn.ngcloud.app/movie/abc', manifest: 'hls' },
    subtitles: [],
};

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:10\n#EXT-X-PLAYLIST-TYPE:VOD\n'
    + '#EXTINF:6.44,\nhttps://p16-sg.tiktokcdn.com/obj/seg0\n#EXTINF:5.68,\nhttps://p16-sg.tiktokcdn.com/obj/seg1\n#EXT-X-ENDLIST\n';

function tsBytes(n = 4096) {
    const b = Buffer.alloc(n, 0xff);
    for (let i = 0; i < n; i += 188) b[i] = 0x47;
    return b;
}

function stub(segment) {
    const calls = [];
    global.fetch = async (url) => {
        calls.push(String(url));
        const host = new URL(url).hostname;
        if (host === 'api.vidqueen.st') {
            return new Response(JSON.stringify(HLS), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (host === 'cdn.ngcloud.app') {
            return new Response(PLAYLIST, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
        }
        if (host === 'p16-sg.tiktokcdn.com') return segment();
        throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    return calls;
}

function load() {
    delete require.cache[require.resolve('../providers/showsst')];
    return require('../providers/showsst');
}

test('showsst drops an HLS source whose first segment is a 70 B PNG placeholder', async () => {
    const calls = stub(() => new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/png' } }));
    const streams = await load().getShowsstStreams('1359490', 'movie');
    assert.deepEqual(streams, []);
    assert.ok(calls.some((u) => u.includes('tiktokcdn.com/obj/seg0')), 'first segment was read');
});

test('showsst keeps an HLS source whose first segment is real MPEG-TS', async () => {
    stub(() => new Response(tsBytes(), { status: 206, headers: { 'content-type': 'video/mp2t' } }));
    const streams = await load().getShowsstStreams('1359490', 'movie');
    assert.equal(streams.length, 1);
    assert.equal(streams[0].container, 'hls');
});

test('showsst keeps the source when the segment check cannot answer (network error)', async () => {
    stub(() => { throw new Error('ECONNRESET'); });
    const streams = await load().getShowsstStreams('1359490', 'movie');
    assert.equal(streams.length, 1);
});
