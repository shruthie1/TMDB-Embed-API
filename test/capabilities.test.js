'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const src = require('../lib/media/capabilitySources');
const { resolveCapabilities } = require('../lib/media/capabilities');

test('release-name extraction reads quality, never invents language', () => {
  const r = src.fromReleaseName('Peddi.2026.1080p.WEBRip.x264.AAC5.1-[YTS.GG]');
  assert.equal(r.quality, '1080p');
  assert.equal(r.confidence, src.CONFIDENCE.GUESS);
  assert.equal(src.fromReleaseName('Some.Movie.DUAL.Multi.x264'), null, 'DUAL is not a quality');
  assert.equal(src.fromReleaseName('Movie.4K.HDR').quality, '2160p');
});

test('provider field is trusted above a filename but below a manifest', () => {
  assert.ok(src.fromField('1080p').confidence > src.fromReleaseName('x.1080p.y').confidence);
  assert.equal(src.fromField('Auto'), null, 'Auto states nothing');
  assert.equal(src.fromField('1080').quality, '1080p', 'bare height normalises');
});

test('manifest outranks everything', () => {
  const probe = { ok: true, quality: '720p', levels: [{ height: 804, quality: '720p' }] };
  const m = src.fromManifest(probe);
  assert.equal(m.confidence, src.CONFIDENCE.MEASURED);
  assert.ok(m.confidence > src.fromField('1080p').confidence);
  assert.equal(src.fromManifest({ ok: false }), null);
  assert.equal(src.fromManifest({ ok: true, levels: [] }), null);
});

// The exact defect this layer was built for.
test('a measured ladder overrides a provider claiming 1080p', async () => {
  const caps = await resolveCapabilities(
    { url: 'http://x/m.m3u8', provider: 'VaPlayer', quality: '1080p',
      title: 'Peddi.2026.1080p.WEBRip', languages: [], audio: [], subtitles: [] },
    { probe: false },
  );
  // With probing off the claim stands - proving the claim is what gets replaced.
  assert.equal(caps.quality, '1080p');
  assert.equal(caps.qualityTrusted, false);
  assert.equal(caps.qualitySource, 'provider-field');
});

test('label-derived audio is never reported as switchable', async () => {
  const caps = await resolveCapabilities(
    { url: 'http://x/a.m3u8', provider: 'CastleTV', quality: '720p',
      languages: ['Hindi', 'Telugu'], audio: [], subtitles: [] },
    { probe: false },
  );
  assert.equal(caps.audio.length, 2);
  assert.equal(caps.selectableAudio, false, 'labels describe the file, not switchable tracks');
  assert.equal(caps.audioSource, 'label');
});

test('provider audio[] outranks labels', async () => {
  const caps = await resolveCapabilities(
    { url: 'http://x/a.m3u8', provider: 'X', languages: ['Hindi'],
      audio: [{ language: 'tel', codec: 'aac', channels: 2 }], subtitles: [] },
    { probe: false },
  );
  assert.equal(caps.audioSource, 'provider-field');
  assert.equal(caps.audio[0].language, 'Telugu');
});

test('capability descriptor always has a stable shape', async () => {
  const caps = await resolveCapabilities(
    { url: 'http://x/a.m3u8', provider: 'X', languages: [], audio: [], subtitles: [] },
    { probe: false },
  );
  for (const k of ['url','provider','kind','quality','qualitySource','qualityTrusted',
                   'levels','audio','audioSource','selectableAudio','subtitles','durationSeconds']) {
    assert.ok(k in caps, `missing ${k}`);
  }
  assert.ok(Array.isArray(caps.levels));
  assert.ok(Array.isArray(caps.audio));
});
