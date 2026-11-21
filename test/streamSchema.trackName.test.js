'use strict';
// Final-review I1 (2026-11-21): providers copy an und rendition's NAME into
// `language` (vidrock.js:84, multimovies.js:80, netmirror.js:667). The server
// must read that name, so "Telugu 5.1" is Telugu, not a language of its own.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const s = require('../utils/streamSchema');

const row = (audio, extra = {}) => s.normaliseStream({ url: 'u', provider: 'X', audio, ...extra });

test('a name copied into language resolves through the name parser', () => {
  for (const [value, want] of [['Telugu 5.1', 'Telugu'], ['Hindi AAC 2.0', 'Hindi'], ['TEL', 'Telugu']]) {
    const r = row([{ language: value }]);
    assert.equal(r.audio[0].language, want, value);
  }
});

test('the raw text survives in name when name was empty', () => {
  const r = row([{ language: 'Telugu 5.1' }]);
  assert.equal(r.audio[0].name, 'Telugu 5.1');
  const kept = row([{ language: 'Telugu 5.1', name: 'Main' }]);
  assert.equal(kept.audio[0].name, 'Main');
});

test('an und tag reads the name', () => {
  const r = row([{ language: 'und', name: 'Telugu 5.1' }, { language: 'und', name: 'AAC 5.1' }]);
  assert.equal(r.audio[0].language, 'Telugu');
  assert.equal(r.audio[1].language, null);
});

test('a codec-only label never becomes a language; raw value kept as before', () => {
  const r = row([{ language: 'AAC 5.1' }]);
  assert.equal(r.audio[0].language, 'Aac 5.1');
  assert.equal(r.audio[0].name, null);
});

test('a compound tag naming two languages is not narrowed to one', () => {
  const r = row([{ language: 'Telugu-Hindi' }]);
  assert.equal(r.audio[0].language, 'Telugu-hindi');
});

test('source-level languages[] resolve the same way (vidrock row)', () => {
  const r = s.normaliseStream({ url: 'u', provider: 'X', languages: ['Telugu 5.1', 'Hindi', 'AAC 5.1'] });
  assert.deepEqual(r.languages, ['Telugu', 'Hindi', 'Aac 5.1']);
  const j = s.normaliseStream({ url: 'u', provider: 'X', language: 'Telugu 5.1/Hindi' });
  assert.deepEqual(j.languages, ['Telugu', 'Hindi']);
});

test('mul and zxx are not languages (parity with the APK)', () => {
  for (const v of ['mul', 'zxx', 'MUL']) assert.equal(s.canonicalLanguage(v), null, v);
  const r = row([{ language: 'mul' }]);
  assert.equal(r.audio[0].language, null);
  assert.equal(r.audio[0].languageCode, 'mul');
});

test('trackNameLanguage: one language or null', () => {
  assert.equal(s.trackNameLanguage('[2] Telugu (AAC)'), 'Telugu');
  assert.equal(s.trackNameLanguage('HE-AAC 5.1'), null);
  assert.equal(s.trackNameLanguage('DD 2.0'), null);
  assert.equal(s.trackNameLanguage('per it'), null);
  assert.equal(s.trackNameLanguage('Telugu / Hindi'), null);
  assert.equal(s.trackNameLanguage(''), null);
  assert.equal(s.trackNameLanguage('Telugu Stereo'), 'Telugu');
});

test('a label with any other word is left as given (no lost region or role)', () => {
  assert.equal(s.trackNameLanguage('Portuguese (Brazil)'), null);
  assert.equal(s.trackNameLanguage('Spanish LAT'), null);
  assert.equal(s.trackNameLanguage('Telugu Commentary'), null);
  const r = s.normaliseStream({ url: 'u', provider: 'X', languages: ['Portuguese (Brazil)'] });
  assert.deepEqual(r.languages, ['Portuguese (brazil)']);
});
