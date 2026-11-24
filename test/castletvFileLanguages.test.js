'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Measured 2026-11-24 from the VM. CastleTV names each file with the API track
// it was asked for. Inception 27205: three distinct files listed English /
// Tamil / "Ost", first-segment PMT tags eng / und / und. Jailer 937020: one
// muxed file listed Kannada/Malayalam/Telugu/Tamil/Hindi, tagged
// hin/tam/tel/mal/kan. Tags win; untagged keeps real language labels only.

const { _internal: { withFileLanguages } } = require('../providers/castletv');
const tsLang = require('../lib/media/tsLanguages');

const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n';
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));

function row(name, language) {
    return { name, url: `https://img1.example.com/${name.length}/index.m3u8`, provider: 'CastleTV', headers: {}, ...(language ? { language } : {}) };
}
const get = async () => ({ status: 200, text: MEDIA });
const probeWith = (buf) => async () => {
    const tracks = tsLang.pmtAudioTracks(buf);
    return tracks ? { tracks, languages: tsLang.languagesOf(tracks) } : null;
};

test('castle: muxed file takes its PMT tags in file order (Jailer)', async () => {
    const s = row('CastleTV [Kannada/Malayalam/Telugu/Tamil/Hindi] | 720p', 'Kannada/Malayalam/Telugu/Tamil/Hindi');
    await withFileLanguages([s], { get, probe: probeWith(fixture('vidrock-pmt-hin-tam-tel-mal-kan.ts')) });
    assert.equal(s.language, 'Hindi/Tamil/Telugu/Malayalam/Kannada');
    assert.match(s.name, /^CastleTV \[Hindi\/Tamil\/Telugu\/Malayalam\/Kannada\] \| 720p$/);
});

test('castle: a file tag replaces a different API label', async () => {
    const s = row('CastleTV [Tamil] | 720p', 'Tamil');
    await withFileLanguages([s], { get, probe: async () => ({ tracks: [], languages: ['English'] }) });
    assert.equal(s.language, 'English');
});

test('castle: untagged file keeps a real language label (Inception Tamil, und)', async () => {
    const s = row('CastleTV [Tamil] | 720p', 'Tamil');
    await withFileLanguages([s], { get, probe: probeWith(fixture('vidrock-pmt-und.ts')) });
    assert.equal(s.language, 'Tamil');
    assert.match(s.name, /^CastleTV \[Tamil\]/);
});

test('castle: untagged file drops a label that is not a language (Inception "Ost")', async () => {
    const s = row('CastleTV [Ost] | 720p', 'Ost');
    await withFileLanguages([s], { get, probe: probeWith(fixture('vidrock-pmt-und.ts')) });
    assert.equal(s.language, undefined);
    assert.match(s.name, /^CastleTV \| 720p$/);
});

test('castle: unreadable playlist keeps real labels, never guesses', async () => {
    const s = row('CastleTV [Telugu] | 720p', 'Telugu');
    await withFileLanguages([s], { get: async () => { throw new Error('ETIMEDOUT'); }, probe: async () => assert.fail('no probe') });
    assert.equal(s.language, 'Telugu');
});

test('castle: shared-file row (label only in the name) takes file tags too', async () => {
    const s = row('CastleTV [Hindi] | 480p');
    await withFileLanguages([s], { get, probe: async () => ({ tracks: [], languages: ['Telugu'] }) });
    assert.equal(s.language, 'Telugu');
    assert.match(s.name, /^CastleTV \[Telugu\]/);
});
