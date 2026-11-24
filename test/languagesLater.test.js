'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Owner 2026-11-24: "we cannot have that delay". File-tag probes (ShowsSt
// ffprobe, CastleTV and vidrock segment PMT) no longer hold a provider's
// answer. A cold file goes out with what is known now and is probed in the
// background; the landed tags reach the next read through the overlay.

const later = require('../lib/media/languagesLater');
const { normaliseStream } = require('../utils/streamSchema');
const tsLang = require('../lib/media/tsLanguages');
const vidrock = require('../providers/vidrock');
const showsst = require('../providers/showsst');
const { _internal: castle } = require('../providers/castletv');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n';
const FIVE = ['Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada'];

test('schema keeps languageSource when the row has languages, drops it otherwise', () => {
    const a = normaliseStream({ url: 'https://x/a.m3u8', provider: 'vidrock', languages: ['Telugu'], languageSource: 'ts-pmt' });
    assert.equal(a.languageSource, 'ts-pmt');
    const b = normaliseStream({ url: 'https://x/b.m3u8', provider: 'vidrock', languages: [], languageSource: 'ts-pmt' });
    assert.equal(b.languageSource, undefined);
});

test('vidrock: a cold segment answers at once unlabelled; the background probe relabels via the overlay', async () => {
    const url = 'https://cdn.vr.test/x/index.m3u8';
    const raw = vidrock.streamFromMaster('Lyra', { language: 'Kannada' }, url, MEDIA);
    const now = vidrock.segmentLanguagesNow(raw, MEDIA, url, () => undefined);
    assert.equal(now.cold, true);
    assert.deepEqual(now.row.languages, []);
    const cached = [normaliseStream({ ...now.row })]; // as the provider cache holds it
    let landed = null;
    later.onChanged((e) => { if (e.tmdbId === '937020') landed = e; });
    const t0 = Date.now();
    const rows = await later.later('vidrock', 937020, vidrock.probeColdRows([{ row: now.row, text: MEDIA, url }],
        async () => ({ tracks: [], languages: tsLang.languagesOf(tsLang.pmtAudioTracks(fixture('vidrock-pmt-hin-tam-tel-mal-kan.ts'))) })));
    assert.equal(rows.length, 1);
    assert.deepEqual(landed, { provider: 'vidrock', tmdbId: '937020' });
    assert.equal(later.landedSince('937020', t0), true);
    const out = later.apply(cached);
    assert.deepEqual(out[0].languages, FIVE);
    assert.equal(out[0].languageSource, 'ts-pmt');
    assert.deepEqual(cached[0].languages, [], 'the cached row object is not mutated');
});

test('vidrock: a cached PMT verdict labels the row now, with languageSource ts-pmt', () => {
    const url = 'https://cdn.vr.test/y/index.m3u8';
    const raw = vidrock.streamFromMaster('Vega', {}, url, MEDIA);
    const now = vidrock.segmentLanguagesNow(raw, MEDIA, url, () => ({ tracks: [], languages: ['Telugu', 'Hindi'] }));
    assert.equal(now.cold, false);
    assert.deepEqual(now.row.languages, ['Telugu', 'Hindi']);
    assert.equal(normaliseStream(now.row).languageSource, 'ts-pmt');
});

test('tsLanguages: cachedSegmentLanguages is undefined until a probe settles', async () => {
    const pl = '#EXTM3U\n#EXTINF:6,\nhttps://seg.test/peek/seg0.ts\n';
    assert.equal(tsLang.cachedSegmentLanguages(pl, 'https://seg.test/peek/i.m3u8'), undefined);
    await tsLang.probeSegmentLanguages(pl, 'https://seg.test/peek/i.m3u8', {}, { fetchHeadFn: async () => fixture('vidrock-pmt-hin-tam-tel-mal-kan.ts') });
    assert.deepEqual(tsLang.cachedSegmentLanguages(pl, 'https://seg.test/peek/i.m3u8').languages, FIVE);
});

test('showsst: never-probed file is undefined now (probe later); background labels it Tamil', async () => {
    assert.equal(showsst.fileAudioNow('https://f.test/a.mp4', { cached: () => undefined }), undefined);
    assert.deepEqual(showsst.fileAudioNow('https://f.test/a.mp4', { cached: () => [{ language: 'tam' }] }).languages, ['Tamil']);
    assert.equal(showsst.fileAudioNow('https://f.test/a.mp4', { cached: () => [] }), null);
    const row = { url: 'https://vm.test/ts-proxy?u=a', provider: 'showsst', languages: [], quality: '720p', container: 'mp4', title: 'showsst · MovieBox' };
    const cached = [normaliseStream({ ...row })];
    const changed = await later.later('showsst', 1234139,
        showsst.probeColdFiles([{ row, url: 'https://f.test/a.mp4' }], {}, { probe: async () => [{ language: 'tam', codec: 'aac', channels: 2 }] }));
    assert.equal(changed.length, 1);
    const out = later.apply(cached);
    assert.deepEqual(out[0].languages, ['Tamil']);
    assert.equal(out[0].languageSource, 'mp4-tag');
});

test('castle: answer-time pass drops "Ost" at once, keeps real labels, and reads the file later', async () => {
    const ost = { name: 'CastleTV [Ost] | 720p', language: 'Ost', url: 'https://img.castle.test/ost/index.m3u8', provider: 'CastleTV', headers: {} };
    const kan = { name: 'CastleTV [Kannada/Malayalam/Telugu/Tamil/Hindi] | 720p', language: 'Kannada/Malayalam/Telugu/Tamil/Hindi',
        url: 'https://img.castle.test/muxed/index.m3u8', provider: 'CastleTV', headers: {} };
    const cold = castle.fileLanguagesNow([ost, kan]);
    assert.equal(cold.length, 2);
    assert.equal(ost.language, undefined);
    assert.equal(kan.language, 'Kannada/Malayalam/Telugu/Tamil/Hindi');
    const cached = [normaliseStream({ ...kan })];
    const probe = async () => {
        const tracks = tsLang.pmtAudioTracks(fixture('vidrock-pmt-hin-tam-tel-mal-kan.ts'));
        return { tracks, languages: tsLang.languagesOf(tracks) };
    };
    const changed = await later.later('castletv', 27205, castle.readColdFiles([kan], { get: async () => ({ status: 200, text: MEDIA }), probe }));
    assert.equal(changed.length, 1);
    const out = later.apply(cached);
    assert.deepEqual(out[0].languages, FIVE);
    assert.equal(out[0].languageSource, 'ts-pmt');
    // The verdict is kept: the next answer-time pass labels at once, nothing cold.
    const again = { ...kan, language: 'Kannada', name: 'CastleTV [Kannada] | 720p' };
    assert.equal(castle.fileLanguagesNow([again]).length, 0);
    assert.equal(again.language, FIVE.join('/'));
    assert.equal(again.languageSource, 'ts-pmt');
});

test('a probe that throws leaves rows as sent and marks nothing landed', async () => {
    const t0 = Date.now();
    const rows = await later.later('showsst', 42, async () => { throw new Error('ffprobe 403'); });
    assert.deepEqual(rows, []);
    assert.equal(later.landedSince('42', t0), false);
});
