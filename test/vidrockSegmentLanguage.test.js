'use strict';
// vidrock single-variant rows (fcxmb/hscow media playlists) carry no manifest
// language; the first segment's PMT does. Fixtures are the first 4 TS packets
// of Jailer 937020 segment 0 (Vega server) and of an Orion segment, cut
// 2026-11-24. ffprobe on each fixture reports the same tags asserted here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ts = require('../lib/media/tsLanguages');
const { streamFromMaster, withSegmentLanguages } = require('../providers/vidrock');
const { normaliseStream } = require('../utils/streamSchema');

const FIVE = fs.readFileSync(path.join(__dirname, 'fixtures/vidrock-pmt-hin-tam-tel-mal-kan.ts'));
const UND = fs.readFileSync(path.join(__dirname, 'fixtures/vidrock-pmt-und.ts'));
const MEDIA = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nhttps://img.fcxmb.com/hls_mps/abc/720/0.jpg?sig=x\n#EXTINF:10,\nhttps://img.fcxmb.com/hls_mps/abc/720/1.jpg?sig=x\n#EXT-X-ENDLIST\n';
const URL_ = 'https://img1.fcxmb.com/hls_mps/abc/720/index.m3u8';

test('PMT: five tagged AAC tracks in file order, Telugu among them', () => {
    const tracks = ts.pmtAudioTracks(FIVE);
    assert.deepEqual(tracks.map((t) => t.code), ['hin', 'tam', 'tel', 'mal', 'kan']);
    assert.deepEqual(ts.languagesOf(tracks), ['Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada']);
    assert.ok(tracks.every((t) => t.streamType === 0x0f));
});

test('PMT: und tag is unknown, not a language', () => {
    const tracks = ts.pmtAudioTracks(UND);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].code, 'und');
    assert.equal(tracks[0].language, null);
    assert.deepEqual(ts.languagesOf(tracks), []);
});

test('PMT: no table in the bytes -> null; garbage -> null', () => {
    assert.equal(ts.pmtAudioTracks(FIVE.subarray(0, 188)), null);
    assert.equal(ts.pmtAudioTracks(Buffer.from('<!DOCTYPE html><html></html>')), null);
    assert.equal(ts.pmtAudioTracks(Buffer.alloc(0)), null);
});

test('first segment url resolves against the playlist', () => {
    assert.equal(ts.firstSegmentUrl(MEDIA, URL_), 'https://img.fcxmb.com/hls_mps/abc/720/0.jpg?sig=x');
    assert.equal(ts.firstSegmentUrl('#EXTM3U\n#EXTINF:4,\nseg/a.ts\n', 'https://h/x/p.m3u8'), 'https://h/x/seg/a.ts');
    assert.equal(ts.firstSegmentUrl('#EXTM3U\n#EXT-X-ENDLIST\n', URL_), null);
});

test('probe reads only the head of the first segment, caches by path across mirrors', async () => {
    ts._cache.clear();
    const calls = [];
    const fetchHeadFn = async (u, h) => { calls.push({ u, h }); return FIVE; };
    const a = await ts.probeSegmentLanguages(MEDIA, URL_, { Referer: 'r' }, { fetchHeadFn });
    const mirror = MEDIA.replace(/fcxmb/g, 'hscow').replace(/sig=x/g, 'sig=y');
    const b = await ts.probeSegmentLanguages(mirror, URL_, {}, { fetchHeadFn });
    assert.deepEqual(a.languages, ['Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada']);
    assert.deepEqual(b.languages, a.languages);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].h.Referer, 'r');
});

test('probe failure is unknown and not cached', async () => {
    ts._cache.clear();
    let n = 0;
    const fetchHeadFn = async () => { n++; throw new Error('HTTP 403'); };
    assert.equal(await ts.probeSegmentLanguages(MEDIA, URL_, {}, { fetchHeadFn }), null);
    assert.equal(await ts.probeSegmentLanguages(MEDIA, URL_, {}, { fetchHeadFn }), null);
    assert.equal(n, 2);
});

test('vidrock single-variant row takes the PMT languages; stated language ignored', async () => {
    const base = streamFromMaster('Lyra', { language: 'Hindi' }, URL_, MEDIA);
    assert.deepEqual(base.languages, []);
    const row = await withSegmentLanguages(base, MEDIA, URL_, async () => ({ languages: ts.languagesOf(ts.pmtAudioTracks(FIVE)) }));
    assert.deepEqual(row.languages, ['Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada']);
    assert.equal(row.selectableAudio, false);
    const n = normaliseStream(row);
    assert.ok(n.languages.includes('Telugu'));
});

test('vidrock row stays unknown on und, on probe failure, and is not probed when it has variants', async () => {
    const base = streamFromMaster('Orion', { language: 'English' }, URL_, MEDIA);
    const und = await withSegmentLanguages(base, MEDIA, URL_, async () => ({ languages: ts.languagesOf(ts.pmtAudioTracks(UND)) }));
    assert.deepEqual(und.languages, []);
    const fail = await withSegmentLanguages(base, MEDIA, URL_, async () => null);
    assert.deepEqual(fail.languages, []);
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nv.m3u8\n';
    const multi = streamFromMaster('Nova', { language: 'English' }, 'https://x/m.m3u8', master);
    let probed = false;
    await withSegmentLanguages(multi, master, 'https://x/m.m3u8', async () => { probed = true; return null; });
    assert.equal(probed, false);
    assert.equal(await withSegmentLanguages(null, MEDIA, URL_, async () => { throw new Error('no'); }), null);
});
