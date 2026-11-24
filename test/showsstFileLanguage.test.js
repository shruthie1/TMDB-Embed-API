'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Measured 2026-11-24 from the VM: Jailer 937020's ShowsSt MovieBox MP4 has
// one AAC track tagged `tam` (ffprobe), and the row shipped languages [].
// The row takes the file's own tag; `und`/untagged stays unknown; a probe that
// fails leaves the row unlabelled, never guessed.

const { fileAudio } = require('../providers/showsst');

test('showsst row takes the MP4 audio tag (Jailer: tam -> Tamil)', async () => {
    const got = await fileAudio('https://x/f.mp4', {}, {
        probe: async () => [{ language: 'tam', codec: 'aac', channels: 2 }],
    });
    assert.deepEqual(got.languages, ['Tamil']);
    assert.equal(got.audio.length, 1);
});

test('showsst row stays unknown when the track is untagged (und)', async () => {
    // mp4AudioProbe maps und -> language null.
    const got = await fileAudio('https://x/f.mp4', {}, {
        probe: async () => [{ language: null, codec: 'aac', channels: 2 }],
    });
    assert.deepEqual(got.languages, []);
});

test('showsst row stays unknown when the probe fails', async () => {
    const got = await fileAudio('https://x/f.mp4', {}, { probe: async () => { throw new Error('ffprobe 403'); } });
    assert.equal(got, null);
});

test('showsst keeps several tagged tracks in file order', async () => {
    const got = await fileAudio('https://x/f.mp4', {}, {
        probe: async () => [{ language: 'Telugu' }, { language: 'Hindi' }, { language: null }],
    });
    assert.deepEqual(got.languages, ['Telugu', 'Hindi']);
});

// VM 2026-11-24: MovieBox serves every film from prism.surrealviews.com/api
// with the file in the query. The probe cache keyed host+path, so RRR's und
// answered for Inception's eng file. The query now names the file there.
test('mp4 probe cache: one endpoint, different query = different file', () => {
    const { _cacheKey } = require('../lib/media/mp4AudioProbe');
    const a = _cacheKey('https://prism.surrealviews.com/api?d=AAA&token=1');
    const b = _cacheKey('https://prism.surrealviews.com/api?d=BBB&token=1');
    assert.notEqual(a, b);
    assert.equal(a, _cacheKey('https://prism.surrealviews.com/api?d=AAA&token=1'));
    // A real file path keeps ignoring its signature query.
    assert.equal(_cacheKey('https://cdn.x/v/film.mp4?sig=1'), _cacheKey('https://cdn.x/v/film.mp4?sig=2'));
});
