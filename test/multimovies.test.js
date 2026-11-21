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

// Network fixtures for getMultimoviesStreams. `hang` URLs never answer until
// their AbortSignal fires, like Krack's kan/mal/tam playlists (2026-11-20:
// three of four timed out at 30s, Telugu answered in 593ms).
function stubFetch(t, routes) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = (url, opts = {}) => {
        const u = String(url);
        calls.push(u);
        const route = routes.find(([re]) => re.test(u));
        if (!route) return Promise.resolve(new Response('', { status: 404 }));
        const body = route[1];
        if (body === 'hang') {
            return new Promise((_, reject) => {
                const s = opts.signal;
                if (s) s.addEventListener('abort', () => reject(s.reason || new Error('aborted')));
            });
        }
        return Promise.resolve(typeof body === 'function' ? body(u) : new Response(body, { status: 200 }));
    };
    t.after(() => { global.fetch = realFetch; });
    return calls;
}

const KRACK_API = JSON.stringify({ stream: { server: 'vidbolt', sources: [{ url: KRACK_URL, kind: 'hls', quality: '1080p' }] } });

test('P6a: audio renditions whose playlist does not answer are dropped; Telugu kept', async (t) => {
    const mm = require('../providers/multimovies');
    mm._config.audioTimeoutMs = 100;
    mm._clearDisguiseCache();
    t.after(() => { mm._config.audioTimeoutMs = 8000; });
    stubFetch(t, [
        [/\/api\/resolve/, KRACK_API],
        [/index\.m3u8/, KRACK],
        [/track_telugu/, '#EXTM3U\n#EXTINF:4,\na.aac\n'],
        [/track_(kannada|malayalam|tamil)/, 'hang'],
        [/tiles\.m3u8/, '#EXTM3U\n#EXTINF:4,\ns0.png\n'],
        [/s0\.png/, () => new Response(Buffer.from([0x47, 0x40, 0x11, 0x10]), { status: 206 })],
    ]);
    const rows = await mm.getMultimoviesStreams('784572', 'movie');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].audio.map((a) => a.language), ['tel']);
    assert.deepEqual(rows[0].languages, ['tel']);
    assert.equal(rows[0].selectableAudio, true);
    await mm._disguiseSettled();
});

test('P6b: the disguised-segment check does not hold up the resolve, and is cached per host', async (t) => {
    const mm = require('../providers/multimovies');
    mm._clearDisguiseCache();
    let segHits = 0;
    stubFetch(t, [
        [/\/api\/resolve/, KRACK_API],
        [/index\.m3u8/, KRACK],
        [/track_/, '#EXTM3U\n#EXTINF:4,\na.aac\n'],
        [/tiles\.m3u8/, '#EXTM3U\n#EXTINF:4,\ns0.png\n'],
        [/s0\.png/, () => {
            segHits += 1;
            // A slow host: answers an image header after 300ms.
            return new Promise((res) => setTimeout(() => res(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 206 })), 300));
        }],
    ]);
    const t0 = Date.now();
    const first = await mm.getMultimoviesStreams('784572', 'movie');
    assert.ok(Date.now() - t0 < 250, `resolve waited for the check: ${Date.now() - t0}ms`);
    assert.equal(first.length, 1, 'unknown host fails open');
    await mm._disguiseSettled();
    const second = await mm.getMultimoviesStreams('784572', 'movie');
    assert.equal(second.length, 0, 'cached disguised host drops the row');
    await mm._disguiseSettled();
    assert.equal(segHits, 1, 'one check per host');
});

// Recorded 2026-11-21: RRR (579974) VidBolt Telugu bridge master, signature
// redacted. AUDIO is NAME="Audio" with no LANGUAGE; vidbolt /api/resolve says
// language "Telugu" for this source. Before: languages ['Audio'].
const RRR_BRIDGE = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'multimovies', 'rrr-bridge-telugu.m3u8'), 'utf8');
const RRR_URL = 'https://dash-hls-bridge.johndoesdmc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5820588283537016992_0_0_1080_h265_795%2Fmaster.m3u8';

test('RRR bridge: generic "Audio" rendition takes VidBolt source language, Telugu', () => {
    const n = normaliseStream(streamFromMaster({ quality: '1080p', language: 'Telugu' }, RRR_BRIDGE, RRR_URL));
    assert.deepEqual(n.languages, ['Telugu']);
    assert.deepEqual(n.audio.map((a) => a.language), ['Telugu']);
    assert.equal(n.selectableAudio, true);
    assert.equal(n.videoCodec, 'hevc');
});

test('RRR bridge: a master that states a real LANGUAGE still wins over the source', () => {
    const tagged = RRR_BRIDGE.replace('NAME="Audio"', 'NAME="Audio",LANGUAGE="hin"');
    const n = normaliseStream(streamFromMaster({ language: 'Telugu' }, tagged, RRR_URL));
    assert.deepEqual(n.languages, ['Hindi']);
});

test('RRR bridge: no source language keeps the old fallback, nothing dropped', () => {
    const n = normaliseStream(streamFromMaster({}, RRR_BRIDGE, RRR_URL));
    assert.deepEqual(n.audio.map((a) => a.name), ['Audio']);
    assert.equal(n.audio.length, 1);
});

test('RRR bridge: "Arabic sub" is a subtitle label, not an audio language', () => {
    const n = normaliseStream(streamFromMaster({ language: 'Arabic sub' }, RRR_BRIDGE, RRR_URL));
    assert.ok(!n.languages.includes('Arabic'));
    assert.equal(n.audio.length, 1);
});

test('RRR bridge: a named (non-generic) rendition is not overridden by the source', () => {
    const named = RRR_BRIDGE.replace('NAME="Audio"', 'NAME="Tamil"');
    const n = normaliseStream(streamFromMaster({ language: 'Telugu' }, named, RRR_URL));
    assert.deepEqual(n.languages, ['Tamil']);
});

test('RRR bridge: two generic renditions are left as the master states (no stamp)', () => {
    const two = RRR_BRIDGE.replace(/(#EXT-X-MEDIA:TYPE=AUDIO[^\n]*NAME=)"Audio"([^\n]*)/, '$1"Audio 1"$2\n$1"Audio 2"$2');
    const n = normaliseStream(streamFromMaster({ language: 'Telugu' }, two, RRR_URL));
    assert.equal(n.audio.length, 2);
    assert.ok(!n.audio.some((a) => a.language === 'Telugu'), 'no Telugu stamped on two renditions');
});

test('RRR bridge: an unrecognised source label ("Hindi Dubbed") does not replace "Audio"', () => {
    const n = normaliseStream(streamFromMaster({ language: 'Hindi Dubbed' }, RRR_BRIDGE, RRR_URL));
    assert.deepEqual(n.audio.map((a) => a.name), ['Audio']);
    assert.ok(!n.languages.some((l) => /dub/i.test(l)), n.languages.join(','));
});

test('RRR bridge: source "Original" takes TMDB original_language, else stays unlabelled', () => {
    const withTmdb = normaliseStream(streamFromMaster({ language: 'Original' }, RRR_BRIDGE, RRR_URL, null, 'te'));
    assert.deepEqual(withTmdb.languages, ['Telugu']);
    const without = normaliseStream(streamFromMaster({ language: 'Original' }, RRR_BRIDGE, RRR_URL, null, null));
    assert.ok(!without.languages.includes('Telugu'));
});
