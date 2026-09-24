'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const m = require('../lib/media/hlsManifest');

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Telugu",LANGUAGE="tel",DEFAULT=NO,AUTOSELECT=YES,URI="a1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hindi",LANGUAGE="hin",DEFAULT=YES,AUTOSELECT=YES,URI="a0.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="eng",URI="s0.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x268,CODECS="avc1.4d401e",AUDIO="aud"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x804,CODECS="avc1.640028",AUDIO="aud"
high.m3u8`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.000,
seg0.ts
#EXTINF:6.000,
seg1.ts
#EXTINF:4.500,
seg2.ts`;

test('isMaster / isMedia discriminate', () => {
  assert.equal(m.isMaster(MASTER), true);
  assert.equal(m.isMedia(MASTER), false);
  assert.equal(m.isMaster(MEDIA), false);
  assert.equal(m.isMedia(MEDIA), true);
});

test('levels are parsed best-first with resolved URLs', () => {
  const lv = m.parseLevels(MASTER, 'https://x.com/p/master.m3u8');
  assert.equal(lv.length, 2);
  assert.equal(lv[0].height, 804, 'highest first');
  assert.equal(lv[0].url, 'https://x.com/p/high.m3u8');
  assert.equal(lv[0].bandwidth, 2400000);
  assert.equal(lv[1].height, 268);
});

// The bug this whole layer exists for: a provider read "1080p" off a filename
// while the real ladder topped out at 804px.
test('heightToTier snaps letterboxed heights to standard tiers', () => {
  assert.equal(m.heightToTier(804), '720p');
  assert.equal(m.heightToTier(1080), '1080p');
  assert.equal(m.heightToTier(268), '240p');
  assert.equal(m.heightToTier(2160), '2160p');
  assert.equal(m.heightToTier(0), null);
  assert.equal(m.heightToTier(null), null);
});

test('audio renditions carry language and default flag', () => {
  const a = m.parseMedia(MASTER, 'https://x.com/p/master.m3u8', 'AUDIO');
  assert.equal(a.length, 2);
  assert.equal(a[0].languageCode, 'tel');
  assert.equal(a[0].isDefault, false);
  assert.equal(a[1].languageCode, 'hin');
  assert.equal(a[1].isDefault, true);
});

test('subtitles are parsed separately from audio', () => {
  assert.equal(m.parseMedia(MASTER, 'https://x.com/', 'SUBTITLES').length, 1);
});

test('media playlist duration and segment count', () => {
  assert.equal(Math.round(m.parseDuration(MEDIA)), 17);
  assert.equal(m.parseSegmentCount(MEDIA), 3);
  assert.equal(m.parseDuration(MASTER), 0, 'a master has no EXTINF');
});

test('malformed input does not throw', () => {
  for (const bad of [null, undefined, '', 'garbage', '#EXTM3U']) {
    assert.doesNotThrow(() => {
      m.parseLevels(bad, 'https://x.com/');
      m.parseMedia(bad, 'https://x.com/', 'AUDIO');
      m.parseDuration(bad);
    });
  }
});
