'use strict';
const assert = require('node:assert');
const { test } = require('node:test');

// C2 (docs/PENDING-WORK.md): a cast master offers ONE audio rendition, the
// preferred language, DEFAULT=YES. A TV receiver may show no audio menu at all,
// so any second rendition is a chance to play the wrong language.

const h = require('../utils/hybridStream');

const BASE = 'http://localhost:8790';

function devaraPlan() {
  // Castle track 0 is Kannada on Devara (811941); Telugu is track 3.
  const demux = `${BASE}/castle-demux/abc`;
  return {
    height: 720,
    video: { stream: { provider: 'OneTouchTV' },
      desc: { headers: {}, video: { url: 'https://v.test/720.m3u8', ladder: [] } } },
    audio: { stream: { provider: 'CastleTV' },
      desc: { headers: {}, audio: { renditions: [
        { name: 'Kannada', language: 'kan', url: `${demux}/audio-0.m3u8` },
        { name: 'Malayalam', language: 'mal', url: `${demux}/audio-1.m3u8` },
        { name: 'Tamil', language: 'tam', url: `${demux}/audio-2.m3u8` },
        { name: 'Telugu', language: 'tel', url: `${demux}/audio-3.m3u8` },
      ] } } },
  };
}

const mediaLines = (m) => m.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:'));

test('C2: castSingleAudio keeps only the Telugu rendition, DEFAULT=YES', () => {
  const m = h.buildMaster(devaraPlan(), BASE, 'avc1.64001f', 1.5, 'mp4a.40.2', { castSingleAudio: true });
  const media = mediaLines(m);
  assert.equal(media.length, 1, m);
  assert.match(media[0], /NAME="Telugu"/);
  assert.match(media[0], /LANGUAGE="tel"/);
  assert.match(media[0], /DEFAULT=YES/);
  assert.match(media[0], /AUTOSELECT=YES/);
  assert.match(media[0], /URI="http:\/\/localhost:8790\/castle-demux\/abc\/audio-3\.m3u8\?pts=1\.5"/);
  // The variant still binds to that group.
  assert.match(m, /#EXT-X-STREAM-INF:[^\n]*AUDIO="hybrid-audio"/);
});

test('C2: without the option every rendition is still listed (hybrid unchanged)', () => {
  const m = h.buildMaster(devaraPlan(), BASE, 'avc1.64001f', 0, 'mp4a.40.2');
  assert.equal(mediaLines(m).length, 4);
  assert.equal(mediaLines(m).filter((l) => l.includes('DEFAULT=YES')).length, 1);
});

test('C2: no Telugu rendition: the single rendition is the first one, still DEFAULT=YES', () => {
  const plan = devaraPlan();
  plan.audio.desc.audio.renditions = plan.audio.desc.audio.renditions.slice(0, 2);
  const media = mediaLines(h.buildMaster(plan, BASE, 'avc1.64001f', 0, null, { castSingleAudio: true }));
  assert.equal(media.length, 1);
  assert.match(media[0], /NAME="Kannada"/);
  assert.match(media[0], /DEFAULT=YES/);
});

test('C2: realisePlan passes castSingleAudio through to buildMaster', async () => {
  // Probes fail (no network): realisePlan falls back to defaults but still builds.
  const realFetch = global.fetch;
  global.fetch = async () => new Response('', { status: 404 });
  try {
    const plan = { ...devaraPlan(), delta: 0, languages: ['Kannada', 'Malayalam', 'Tamil', 'Telugu'] };
    plan.video.desc.video.text = '#EXTM3U\n#EXTINF:10,\nhttps://v.test/0.ts\n';
    const out = await h.realisePlan(plan, BASE, { castSingleAudio: true });
    assert.equal(mediaLines(out.playlist).length, 1, out.playlist);
    assert.match(mediaLines(out.playlist)[0], /NAME="Telugu"/);
  } finally {
    global.fetch = realFetch;
  }
});
