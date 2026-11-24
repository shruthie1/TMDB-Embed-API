'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// Measured 2026-11-16. vidlove.cc lost its DNS (NS reset to the registrar's
// default on 2026-11-05; both name servers answer REFUSED). Cloudflare blocked
// shows.st and the HLS CDN phantomflix.net for ToS. The same backend now runs
// as api.vidqueen.st and api.vidmario.net. It answers {"source":null} unless
// the request carries Chrome's fetch headers, and it now serves MovieBox MP4
// files with a `qualities` list and `file`-keyed subtitles.

const realFetch = global.fetch;
let calls;

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]);

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MOVIEBOX = {
    meta: null,
    source: {
        source: 'moviebox', label: 'MovieBox', url: 'https://frame.example/api?d=TOP',
        qualities: [
            { quality: '2160p', codec: 'h264', url: 'https://frame.example/api?d=Q2160' },
            { quality: '1080p', codec: 'hevc', url: 'https://frame.example/api?d=QHEVC' },
            { quality: '720p', codec: 'h264', url: 'https://frame.example/api?d=Q720' },
        ],
    },
    subtitles: [{ label: 'English', file: 'https://subs.example/en.vtt', type: 'vtt' }],
};

function load() {
    delete require.cache[require.resolve('../providers/showsst')];
    return require('../providers/showsst');
}

beforeEach(() => {
    calls = [];
    delete process.env.SHOWSST_API_BASE;
    delete process.env.SHOWSST_ORIGIN;
});
afterEach(() => { global.fetch = realFetch; });

test('showsst resolves through api.vidqueen.st with browser fetch headers', async () => {
    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), headers: opts.headers || {} });
        const host = new URL(url).hostname;
        if (host === 'api.vidqueen.st') return json(MOVIEBOX);
        if (host === 'frame.example') return new Response(MP4_HEAD, { status: 206, headers: { 'content-type': 'video/mp4' } });
        throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    const { getShowsstStreams } = load();
    const streams = await getShowsstStreams('155', 'movie');

    const api = calls.find((c) => c.url.startsWith('https://api.vidqueen.st/movie?id=155&mode=json'));
    assert.ok(api, `api.vidqueen.st was called: ${calls.map((c) => c.url).join(', ')}`);
    for (const h of ['Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest', 'sec-ch-ua', 'Accept-Language', 'priority']) {
        assert.ok(api.headers[h], `API request sends ${h}`);
    }
    assert.equal(api.headers.Origin, 'https://player.vidqueen.st');

    // HEVC is dropped: most browsers cannot decode it.
    assert.deepEqual(streams.map((s) => s.quality), ['2160p', '720p']);
    for (const s of streams) {
        assert.equal(s.provider, 'showsst');
        assert.equal(s.container, 'mp4');
        // The proxy picks /ts-proxy only for URLs ending in .mp4; the fragment
        // is never sent upstream.
        assert.match(s.url, /#\.mp4$/);
    }
    assert.equal(streams[0].url, 'https://frame.example/api?d=Q2160#.mp4');
    assert.deepEqual(streams[0].subtitles, [{ url: 'https://subs.example/en.vtt', lang: 'English', id: 'sst-0' }]);
});

test('showsst fails over to api.vidmario.net when the first mirror errors', async () => {
    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), headers: opts.headers || {} });
        const host = new URL(url).hostname;
        if (host === 'api.vidqueen.st') return new Response('forbidden', { status: 403 });
        if (host === 'api.vidmario.net') return json(MOVIEBOX);
        if (host === 'frame.example') return new Response(MP4_HEAD, { status: 206, headers: { 'content-type': 'video/mp4' } });
        throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    const { getShowsstStreams } = load();
    const streams = await getShowsstStreams('1399', 'tv', 1, 2);
    const mario = calls.find((c) => c.url.startsWith('https://api.vidmario.net/tv?id=1399&season=1&episode=2&mode=json'));
    assert.ok(mario, 'second mirror was tried with the TV route');
    assert.equal(mario.headers.Origin, 'https://player.vidmario.net');
    assert.equal(streams.length, 2);
});

test('showsst keeps an HLS source as hls with no fragment', async () => {
    global.fetch = async (url) => {
        const host = new URL(url).hostname;
        if (host === 'api.vidqueen.st') {
            return json({ source: { label: 'VidAPI', url: 'https://cdn.example/api?d=M' }, subtitles: [] });
        }
        // The provider reads the first segment (dead-segment check, 2026-11-24): serve real TS there.
        if (host === 'cdn.example' && new URL(url).pathname === '/seg0.ts') {
            const ts = Buffer.alloc(4096, 0xff);
            for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
            return new Response(ts, { status: 200 });
        }
        if (host === 'cdn.example' && new URL(url).pathname === '/a') return new Response('#EXTM3U\n#EXTINF:6,\nseg0.ts\n', { status: 200 });
        if (host === 'cdn.example') return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na\n', { status: 200 });
        throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    const { getShowsstStreams } = load();
    const streams = await getShowsstStreams('155', 'movie');
    assert.equal(streams.length, 1);
    assert.equal(streams[0].container, 'hls');
    assert.equal(streams[0].url, 'https://cdn.example/api?d=M');
});

test('showsst returns [] on a null source without trying other mirrors', async () => {
    global.fetch = async (url) => {
        calls.push({ url: String(url) });
        return json({ meta: null, source: null, subtitles: [] });
    };
    const { getShowsstStreams } = load();
    assert.deepEqual(await getShowsstStreams('1', 'movie'), []);
    assert.equal(calls.length, 1);
});

test('showsst treats a per-quality list as mp4 when the probe fails', async () => {
    global.fetch = async (url) => {
        const host = new URL(url).hostname;
        if (host === 'api.vidqueen.st') return json(MOVIEBOX);
        throw new Error('The operation was aborted due to timeout');
    };
    const { getShowsstStreams } = load();
    const streams = await getShowsstStreams('1376856', 'movie');
    assert.equal(streams.length, 2);
    assert.ok(streams.every((s) => s.container === 'mp4' && s.url.endsWith('#.mp4')));
});
