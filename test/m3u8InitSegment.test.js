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
    // Headers ride as a short token since R4 (lib/routing/headerTokens.js).
    const headerTokens = require('../lib/routing/headerTokens');
    const m0 = maps[0].match(/URI="(https:\/\/api\.example\/ts-proxy\?[^"]+)"/);
    const m1 = maps[1].match(/URI="(https:\/\/api\.example\/ts-proxy\?[^"]+)",BYTERANGE="720@0"/);
    assert.ok(m0 && m1, maps.join('\n'));
    const q0 = new URL(m0[1]).searchParams; const q1 = new URL(m1[1]).searchParams;
    assert.equal(q0.get('url'), 'https://cdn.example/video/init.mp4');
    assert.equal(q1.get('url'), 'https://cdn.example/video/init2.mp4');
    assert.deepEqual(headerTokens.get(q0.get('h')), { Referer: 'https://mapple.fun/' });
    assert.equal(q1.get('h'), q0.get('h'));
});

// fMP4 segments and init files (mapple) start with a styp/ftyp/moof box but
// arrive disguised, so the URL guess labelled them video/mp2t.
test('fMP4 segment bodies are labelled video/mp4, TS stays video/mp2t', () => {
    const { inferContentType, sniffSegmentType } = require('../proxy/proxyServer');
    const box = (type) => new Uint8Array([0, 0, 0, 24, ...Buffer.from(type, 'latin1'), 0, 0, 0, 0]);
    for (const type of ['styp', 'ftyp', 'moof']) {
        assert.equal(sniffSegmentType('video/mp2t', box(type)), 'video/mp4', type);
    }
    const ts = new Uint8Array(188); ts[0] = 0x47;
    assert.equal(sniffSegmentType('video/mp2t', ts), 'video/mp2t');
    assert.equal(sniffSegmentType('video/mp2t', new Uint8Array(4)), 'video/mp2t');
    // A real upstream type is never overridden.
    assert.equal(sniffSegmentType('video/iso.segment', box('styp')), 'video/iso.segment');
    assert.equal(inferContentType('image/jpeg', 'https://cdn.example/seg1.m4s'), 'video/mp4');
    assert.equal(inferContentType(null, 'https://cdn.example/seg1.jpg'), 'video/mp2t');
});
