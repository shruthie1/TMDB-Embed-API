'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { streamFromMaster, audioFromMaster, looksLikeImage, STREAM_HEADERS } = require('../providers/multimovies');
const { normaliseStream } = require('../utils/streamSchema');

// Recorded 2026-11-20: vidbolt.xyz/api/resolve?type=movie&id=784572 (Krack).
// One master, four dubbed languages as AUDIO renditions, letterboxed 1920x800.
const KRACK_URL = 'https://img.rousav.tech/media/830010a43bd0e6cc32f9/index.m3u8?api_key=k';
const KRACK = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English  [CC]",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en-us.[CC]",URI="subtitles_englishcc.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="kan",NAME="[1] Kannada",DEFAULT=NO,URI="track_kannada.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="mal",NAME="[2] Malayalam",DEFAULT=NO,URI="track_malayalam.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tam",NAME="[3] Tamil",DEFAULT=NO,URI="track_tamil.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tel",NAME="[4] Telugu",DEFAULT=NO,URI="track_telugu.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aac",RESOLUTION=1920x800,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'tiles.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac",DEFAULT=YES,RESOLUTION=1280x528,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'video_720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aac",RESOLUTION=960x400,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'video_480p.m3u8', '',
].join('\n');

// Recorded 2026-11-20: same api, Inception (27205).
const INCEPTION = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="eng",NAME="1. English",DEFAULT=YES,URI="track_english.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="hin",NAME="2. Hindi",DEFAULT=NO,URI="track_hindi.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aac",RESOLUTION=1920x1080', 'tiles.m3u8', '',
].join('\n');

test('Krack: every AUDIO rendition is listed, Telugu first, selectable', () => {
    const row = streamFromMaster({ quality: '1080p' }, KRACK, KRACK_URL);
    assert.deepEqual(row.audio.map((a) => a.language), ['kan', 'mal', 'tam', 'tel']);
    assert.equal(row.selectableAudio, true);
    const n = normaliseStream(row);
    assert.deepEqual(n.languages, ['Telugu', 'Kannada', 'Malayalam', 'Tamil']);
    assert.deepEqual(n.audio.map((a) => a.language), ['Kannada', 'Malayalam', 'Tamil', 'Telugu']);
    assert.equal(n.selectableAudio, true);
});

test('Krack: letterboxed 1920x800 reads as 1080p, the real master URL is kept', () => {
    const n = normaliseStream(streamFromMaster({}, KRACK, KRACK_URL));
    assert.equal(n.quality, '1080p');
    assert.equal(n.url, KRACK_URL);
    assert.equal(n.container, 'hls');
    assert.deepEqual(n.levels.map((l) => l.height), [800, 528, 400]);
});

test('stream carries VidBolt Referer/Origin for /m3u8-proxy', () => {
    const row = streamFromMaster({}, INCEPTION, 'https://x/index.m3u8');
    assert.equal(row.headers.Referer, 'https://vidbolt.xyz/');
    assert.equal(row.headers.Origin, 'https://vidbolt.xyz');
    assert.deepEqual(STREAM_HEADERS, row.headers);
});

test('Inception: English + Hindi, no Telugu invented', () => {
    const n = normaliseStream(streamFromMaster({}, INCEPTION, 'https://x/index.m3u8'));
    assert.deepEqual(n.languages, ['English', 'Hindi']);
    assert.equal(n.selectableAudio, true);
});

test('a master with no AUDIO renditions is not selectable and claims no language', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv.m3u8\n';
    const n = normaliseStream(streamFromMaster({}, text, 'https://x/m.m3u8'));
    assert.equal(n.selectableAudio, false);
    assert.deepEqual(n.languages, []);
    assert.deepEqual(n.audio, []);
});

test('an untagged rendition keeps its NAME as the language', () => {
    const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="und",NAME="[1] Telugu",URI="t.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",RESOLUTION=1920x1080\nv.m3u8\n';
    assert.deepEqual(audioFromMaster(text, 'https://x/m.m3u8').map((a) => a.language), ['Telugu']);
});

test('a master with no variants yields no row', () => {
    assert.equal(streamFromMaster({}, '#EXTM3U\n#EXTINF:4,\na.ts\n', 'https://x/m.m3u8'), null);
});

test('image-header segments are detected; MPEG-TS is not', () => {
    assert.equal(looksLikeImage([0x89, 0x50, 0x4e, 0x47, 0x0d]), true);
    assert.equal(looksLikeImage([0xff, 0xd8, 0xff]), true);
    assert.equal(looksLikeImage([0x47, 0x49, 0x46, 0x38]), true);
    // Krack's ".png" segments are real TS: sync byte 0x47 then PID bytes.
    assert.equal(looksLikeImage([0x47, 0x40, 0x11, 0x10]), false);
});
