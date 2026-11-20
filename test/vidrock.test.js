'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { decryptStreamUrl, streamFromMaster, tierOf, HEADERS } = require('../providers/vidrock');
const { normaliseStream } = require('../utils/streamSchema');

// Recorded 2026-11-20: vidrock.net/api/movie/27205, server "Nova". The
// expected plaintext is what the original scraper's own AES code returned for
// the same input (14/14 entries matched across 27205 and 784572).
const NOVA = {
    url: '-WbKBfm9CChGjJWuVrVU6T6TEoIVdNOz0eXYNN336-y0s8GqCGI9XN4epuDfzC9RyC4rA2s4wjVpnFuRt4-9pp_8AoBNEnf9gxSTKMKlfTdyF4v1QgmfEf5hut92i15kZcWJTUe8s5t3oj0TFjeBXgOv1pnmkzZT',
    language: 'English', flag: 'us', type: 'hls',
};
const NOVA_URL = 'https://vercetti.org/movie/bTwndMfHcTPIrd1MKnTeMHTOhoPAxg6Ufd7DYNj-mzQ.IOpUPRGB/bigtits.m3u8';
const NOVA_MASTER = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080', 'https://vercetti.org/seg/a',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720', 'https://vercetti.org/seg/b',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'https://vercetti.org/seg/c', '',
].join('\n');

test('decrypts a recorded server url to the same URL the scraper got', () => {
    assert.equal(decryptStreamUrl(NOVA.url), NOVA_URL);
});

test('too-short ciphertext throws', () => {
    assert.throws(() => decryptStreamUrl('AAAA'), /too short/);
});

test('Nova row: 1080p, English as stated, no switchable audio, vidrock headers', () => {
    const row = streamFromMaster('Nova', NOVA, NOVA_URL, NOVA_MASTER);
    const n = normaliseStream(row);
    assert.equal(n.quality, '1080p');
    assert.deepEqual(n.languages, ['English']);
    assert.equal(n.selectableAudio, false);
    assert.equal(n.container, 'hls');
    assert.equal(row.headers.Referer, 'https://vidrock.net/');
    assert.equal(row.headers.Origin, 'https://vidrock.net');
    assert.deepEqual(row.headers, HEADERS);
});

test('a media playlist (no variants) yields no row', () => {
    assert.equal(streamFromMaster('Lyra', NOVA, NOVA_URL, '#EXTM3U\n#EXTINF:4,\na.ts\n'), null);
});

test('master AUDIO renditions are declared when present', () => {
    const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="tel",NAME="Telugu",URI="t.m3u8"\n'
        + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="hin",NAME="Hindi",URI="h.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",RESOLUTION=1280x720\nv.m3u8\n';
    const n = normaliseStream(streamFromMaster('X', { language: '' }, 'https://x/m.m3u8', text));
    assert.equal(n.selectableAudio, true);
    assert.deepEqual(n.languages, ['Telugu', 'Hindi']);
});

test('quality tiers follow the scraper (width or height)', () => {
    assert.equal(tierOf(1920, 800), '1080p');
    assert.equal(tierOf(1280, 720), '720p');
    assert.equal(tierOf(640, 360), '360p');
    assert.equal(tierOf(0, 0), null);
});
