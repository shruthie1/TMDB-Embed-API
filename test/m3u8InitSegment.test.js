'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { rewriteM3u8 } = require('../proxy/proxyServer');

// Prod 2026-11-15, mapple on The Paradise (1376856): its fMP4 playlist lists
// the init segment as #EXT-X-MAP:URI="https://proxy2.jordanblackwell.bid/...".
// The rewriter proxied the media segments but left that URI raw, so the
// browser fetched it directly without the Referer the CDN requires (403) and
// the stream never started, while NetMirror (plain mp4) played.
test('EXT-X-MAP init segment is routed through ts-proxy, absolute and relative', () => {
    const body = [
        '#EXTM3U',
        '#EXT-X-MAP:URI="https://cdn.example/video/init.mp4"',
        '#EXTINF:6.0,',
        'https://cdn.example/video/seg1.m4s',
        '#EXT-X-MAP:URI="init2.mp4",BYTERANGE="720@0"',
        '#EXTINF:6.0,',
        'seg2.m4s',
    ].join('\n');
    const out = rewriteM3u8(body, 'https://cdn.example/video/index.m3u8', 'https://api.example', { Referer: 'https://mapple.fun/' });
    const maps = out.split('\n').filter((l) => l.startsWith('#EXT-X-MAP'));
    assert.equal(maps.length, 2);
    assert.match(maps[0], /URI="https:\/\/api\.example\/ts-proxy\?url=https%3A%2F%2Fcdn\.example%2Fvideo%2Finit\.mp4&headers=/);
    assert.match(maps[1], /URI="https:\/\/api\.example\/ts-proxy\?url=https%3A%2F%2Fcdn\.example%2Fvideo%2Finit2\.mp4&headers=.*",BYTERANGE="720@0"/);
});
