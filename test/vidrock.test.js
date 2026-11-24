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

test('Nova row: 1080p, unconfirmed English not claimed, no switchable audio, vidrock headers', () => {
    const row = streamFromMaster('Nova', NOVA, NOVA_URL, NOVA_MASTER);
    const n = normaliseStream(row);
    assert.equal(n.quality, '1080p');
    assert.deepEqual(n.languages, []);
    assert.equal(n.selectableAudio, false);
    assert.equal(n.container, 'hls');
    assert.equal(row.headers.Referer, 'https://vidrock.net/');
    assert.equal(row.headers.Origin, 'https://vidrock.net');
    assert.deepEqual(row.headers, HEADERS);
});

// VM logs 2026-11-20..24: 6 of 8 servers were dropped as "master has no
// variants". A media playlist (#EXTINF segments) is playable on its own, so it
// is kept as a single-variant row. The stated language stays a hint only.
test('a media playlist (no variants) is kept as one Auto row, language not invented', () => {
    const row = streamFromMaster('Lyra', NOVA, NOVA_URL, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n');
    assert.ok(row, 'a playable media playlist was dropped');
    assert.equal(row.quality, 'Auto');
    assert.equal(row.container, 'hls');
    assert.equal(row.url, NOVA_URL);
    assert.deepEqual(row.languages, []);
    assert.equal(row.statedLanguage, 'English');
    assert.deepEqual(row.levels, []);
    assert.equal(row.selectableAudio, false);
    const n = normaliseStream(row);
    assert.deepEqual(n.languages, []);
    assert.equal(n.quality, 'Auto');
});

test('a body that is not a playlist (HTML error page, empty) still yields no row', () => {
    assert.equal(streamFromMaster('Atlas', NOVA, NOVA_URL, '<!DOCTYPE html><html><head><title>502</title></head></html>'), null);
    assert.equal(streamFromMaster('Atlas', NOVA, NOVA_URL, ''), null);
    assert.equal(streamFromMaster('Atlas', NOVA, NOVA_URL, '#EXTM3U\n#EXT-X-ENDLIST\n'), null);
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

// L1 (2026-11-20). The server's `language` is a hint, not a fact: Radhe Shyam
// 673392's Nova row said English over a Hindi track. It labels the row only
// when the master's own AUDIO renditions confirm it; otherwise the row stays
// unlabelled and the hint is kept on `statedLanguage`.
test('L1: stated language with no EXT-X-MEDIA leaves the row unlabelled, hint kept', () => {
    const row = streamFromMaster('Nova', NOVA, NOVA_URL, NOVA_MASTER);
    assert.deepEqual(row.languages, []);
    assert.equal(row.statedLanguage, 'English');
    const n = normaliseStream(row);
    assert.deepEqual(n.languages, []);
    assert.equal(n.language, undefined);
});

test('L1: stated language confirmed by a master AUDIO rendition labels the row', () => {
    const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="eng",NAME="English",URI="e.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",RESOLUTION=1920x1080\nv.m3u8\n';
    const n = normaliseStream(streamFromMaster('Nova', NOVA, 'https://x/m.m3u8', text));
    assert.deepEqual(n.languages, ['English']);
});

test('L1: stated language contradicted by the master is dropped, renditions kept', () => {
    const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="hin",NAME="Hindi",URI="h.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",RESOLUTION=1920x1080\nv.m3u8\n';
    const row = streamFromMaster('Nova', NOVA, 'https://x/m.m3u8', text);
    assert.deepEqual(normaliseStream(row).languages, ['Hindi']);
    assert.equal(row.statedLanguage, 'English');
});

// P7a (2026-11-20). vercetti.org answers a sporadic 403 on the SAME master URL
// regardless of age (laptop: 1 of 10 fetches at 3s spacing; 403 at t=20s then
// 200 at 40/60/80s). On VM1 that dropped the only row twice in 20 minutes.
test('P7a: one master 403 is retried once and the row survives', async (t) => {
    const { getVidrockStreams } = require('../providers/vidrock');
    const realFetch = global.fetch;
    let masterCalls = 0;
    global.fetch = async (url) => {
        if (String(url).startsWith('https://vidrock.net/api/')) {
            return new Response(JSON.stringify({ Nova: NOVA }), { status: 200 });
        }
        masterCalls += 1;
        return masterCalls === 1 ? new Response('', { status: 403 }) : new Response(NOVA_MASTER, { status: 200 });
    };
    t.after(() => { global.fetch = realFetch; });
    const rows = await getVidrockStreams('27205', 'movie');
    assert.equal(masterCalls, 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, NOVA_URL);
});

// Audit 11-24: 80 vidrock answers over 28 titles were cached 30 min after a
// master was dropped on a 502 (Atlas 68x, Orion 27x). A 5xx drop is partial.
async function twoServers(t, secondStatus) {
    const { getVidrockStreams } = require('../providers/vidrock');
    const realFetch = global.fetch;
    let masterCalls = 0;
    global.fetch = async (url) => {
        if (String(url).startsWith('https://vidrock.net/api/')) {
            return new Response(JSON.stringify({ Nova: NOVA, Atlas: NOVA }), { status: 200 });
        }
        masterCalls += 1;
        return masterCalls === 1 ? new Response(NOVA_MASTER, { status: 200 }) : new Response('x', { status: secondStatus });
    };
    t.after(() => { global.fetch = realFetch; });
    return getVidrockStreams('27205', 'movie');
}
test('a master dropped on HTTP 502 marks the answer partial (not cached as complete)', async (t) => {
    const rows = await twoServers(t, 502);
    assert.equal(rows.length, 1);
    assert.match(rows.upstreamError, /dropped: \w+: HTTP 502/);
});
test('a master dropped on HTTP 404 keeps the answer complete', async (t) => {
    const rows = await twoServers(t, 404);
    assert.equal(rows.length, 1);
    assert.equal(rows.upstreamError, undefined);
});
