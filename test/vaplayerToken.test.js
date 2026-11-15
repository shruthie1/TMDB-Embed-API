'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// 2026-11-15: VaPlayer's api.php stopped returning stream_urls unless called
// with a single-use api_token from the player page, and the stream host
// answers 401 unless the url carries a token from <origin>/generate.php.
// The old provider made one bare api.php call and returned 0 on every title.
test('vaplayer fetches an api_token, requests stream_urls with it, and signs each url', async (t) => {
    const seen = [];
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async (url) => {
        const u = String(url);
        seen.push(u);
        const res = (body, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => body, json: async () => JSON.parse(body) });
        if (u.includes('va_src.php')) return res(JSON.stringify({ src: 'https://player.example/embed/movie/tt1?va=x' }));
        if (u.startsWith('https://player.example/')) return res('<script>var CONFIG={"apiToken":"TOK123"}</script>');
        if (u.includes('api.php')) return res(JSON.stringify({ status_code: '200', data: { file_name: 'X.2024.1080p.mp4', stream_urls: ['https://cdn.example/pl/abc/master.m3u8'] } }));
        if (u.includes('/generate.php')) return res('HOSTTOKEN');
        if (u.includes('master.m3u8')) return res('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.m3u8\n');
        return res('', false);
    };
    delete require.cache[require.resolve('../providers/vaplayer')];
    delete require.cache[require.resolve('../utils/tmdb')];
    const tmdb = require('../utils/tmdb');
    const realResolve = tmdb.resolveImdbId;
    tmdb.resolveImdbId = async () => 'tt1';
    t.after(() => { tmdb.resolveImdbId = realResolve; });
    const { getVaplayerStreams } = require('../providers/vaplayer');

    const streams = await getVaplayerStreams('1', 'movie');
    const api = seen.find((u) => u.includes('api.php'));
    assert.ok(api && /[?&]stream_urls(&|$)/.test(api) && api.includes('api_token=TOK123'), api);
    assert.ok(seen.some((u) => u === 'https://cdn.example/generate.php?api_token=TOK123'));
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://cdn.example/pl/abc/master.m3u8?token=HOSTTOKEN');
});
