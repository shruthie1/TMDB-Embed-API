'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const s = require('../utils/streamSchema');

// Each audio[] entry carries rendition identity, not only language and codec.
test('audio entry carries rendition identity', () => {
  const r = s.normaliseStream({
    url: 'u', provider: 'X',
    audio: [{ language: 'tel', name: 'Telugu', uri: 'https://x/a.m3u8', codec: 'mp4a', channels: 2, default: true }],
  });
  assert.deepEqual(r.audio, [{
    language: 'Telugu', languageCode: 'tel', name: 'Telugu', uri: 'https://x/a.m3u8',
    channels: 2, codec: 'mp4a', default: true,
  }]);
});

test('absent rendition fields become null or false', () => {
  const r = s.normaliseStream({ url: 'u', provider: 'X', audio: [{ language: 'en' }] });
  assert.equal(r.audio[0].language, 'English');
  assert.equal(r.audio[0].languageCode, 'en');
  assert.equal(r.audio[0].name, null);
  assert.equal(r.audio[0].uri, null);
  assert.equal(r.audio[0].codec, null);
  assert.equal(r.audio[0].channels, null);
  assert.equal(r.audio[0].default, false);
});

test('uri falls back to url and isDefault to default', () => {
  const r = s.normaliseStream({
    url: 'u', provider: 'X',
    audio: [{ lang: 'hin', url: 'https://x/h.m3u8', isDefault: true }],
  });
  assert.equal(r.audio[0].uri, 'https://x/h.m3u8');
  assert.equal(r.audio[0].default, true);
  assert.equal(r.audio[0].languageCode, 'hin');
});
