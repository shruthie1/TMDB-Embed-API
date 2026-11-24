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
