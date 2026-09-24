const test = require('node:test');
const assert = require('node:assert');
const { rewriteM3u8 } = require('../proxy/proxyServer');

const BASE = 'http://localhost:8790';
const route = (line) => (line.match(/localhost:8790\/([a-z0-9-]+)/) || [])[1];
const urlLines = (out) => out.split('\n').filter((l) => l.trim() && !l.startsWith('#'));

// showsst serves BOTH its variant playlists and its segments as
// `https://host/api?d=<blob>` - no .m3u8, no .ts, nothing in the URL says which
// is which. Extension matching alone therefore sent a variant PLAYLIST through
// ts-proxy, and hls.js got playlist text where it expected MPEG-TS: duration
// 0:00, permanent spinner, and the segments inside were never rewritten so the
// browser fetched them from the origin and got 403. Measured on movie/1408162.
test('a URL after EXT-X-STREAM-INF is a playlist even with no .m3u8 in it', () => {
    const master = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=715546,RESOLUTION=640x268',
        'https://a2.example.com/api?d=BLOB1',
        '#EXT-X-STREAM-INF:BANDWIDTH=4618828,RESOLUTION=1920x802',
        'https://a2.example.com/api?d=BLOB2',
    ].join('\n');
    const out = rewriteM3u8(master, 'https://a2.example.com/api?d=MASTER', BASE, {});
    const lines = urlLines(out);
    assert.strictEqual(lines.length, 2);
    for (const l of lines) assert.strictEqual(route(l), 'm3u8-proxy');
});

test('segments in a media playlist still go to ts-proxy', () => {
    const media = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:5.005,',
        'https://d.example.com/api?d=SEG1',
        '#EXTINF:5.005,',
        'https://d.example.com/api?d=SEG2',
    ].join('\n');
    const out = rewriteM3u8(media, 'https://d.example.com/api?d=MEDIA', BASE, {});
    const lines = urlLines(out);
    assert.strictEqual(lines.length, 2);
    for (const l of lines) assert.strictEqual(route(l), 'ts-proxy');
});

// The flag must clear after the URL line it applies to. Leaving it set made
// every subsequent segment look like a playlist.
test('the variant flag does not leak past its own URL line', () => {
    const mixed = [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1',
        'https://a.example.com/api?d=VARIANT',
        '#EXTINF:5.0,',
        'https://a.example.com/api?d=SEGMENT',
    ].join('\n');
    const out = rewriteM3u8(mixed, 'https://a.example.com/x', BASE, {});
    const [first, second] = urlLines(out);
    assert.strictEqual(route(first), 'm3u8-proxy');
    assert.strictEqual(route(second), 'ts-proxy');
});

test('an explicit .m3u8 variant is still detected without the tag', () => {
    const master = ['#EXTM3U', 'https://a.example.com/v/720/index.m3u8'].join('\n');
    const out = rewriteM3u8(master, 'https://a.example.com/master.m3u8', BASE, {});
    assert.strictEqual(route(urlLines(out)[0]), 'm3u8-proxy');
});

// Segments disguised as images are why extension matching cannot simply be
// tightened: Castle and OneTouchTV ship .jpg segments.
test('an image-named segment is still a segment', () => {
    const media = ['#EXTM3U', '#EXTINF:5.0,', 'https://img.example.com/hls/243.jpg'].join('\n');
    const out = rewriteM3u8(media, 'https://img.example.com/x.m3u8', BASE, {});
    assert.strictEqual(route(urlLines(out)[0]), 'ts-proxy');
});
