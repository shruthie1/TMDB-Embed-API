'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const h = require('../utils/hybridStream');

// A 2.39:1 film in a 1920-wide ladder measures 804 tall, not 1080. Measured on
// Devara (811941): showsst's top variant is 1920x804. Labelling that "804p"
// reads wrong to a viewer and sorts below an actual 720p stream.
test('a pixel height snaps to the display tier a viewer recognises', () => {
  assert.equal(h.tierFor(804), '1080p');
  assert.equal(h.tierFor(1080), '1080p');
  assert.equal(h.tierFor(2160), '2160p');
  assert.equal(h.tierFor(1440), '1440p');
  assert.equal(h.tierFor(720), '720p');
  assert.equal(h.tierFor(536), '720p');
  assert.equal(h.tierFor(480), '480p');
  assert.equal(h.tierFor(268), '360p');
  assert.equal(h.tierFor(0), 'Auto');
  assert.equal(h.tierFor(undefined), 'Auto');
});

// Double-proxying was the cause of the 404-on-seek: a castle-demux child got
// wrapped a second time into /ts-proxy?url=...%2Fts-proxy%3Furl%3D..., which
// served the first request and then 404'd once the player jumped elsewhere.
test('a URL already pointing at this server is not proxied again', () => {
  const base = 'http://localhost:8790';
  const local = `${base}/castle-demux/abc123/audio-3.m3u8`;
  assert.equal(h.proxied(base, local, { Referer: 'x' }), local);
});

test('a remote URL is proxied and carries its headers', () => {
  const base = 'http://localhost:8790';
  const out = h.proxied(base, 'https://cdn.example/a.m3u8', { Referer: 'https://p/' });
  assert.ok(out.startsWith(`${base}/m3u8-proxy?url=`));
  assert.ok(out.includes(encodeURIComponent('https://cdn.example/a.m3u8')));
  assert.ok(out.includes('headers='));
  assert.ok(decodeURIComponent(out.split('headers=')[1]).includes('Referer'));
});

test('a remote URL with no headers gets no headers parameter', () => {
  const out = h.proxied('http://localhost:8790', 'https://cdn.example/a.m3u8', {});
  assert.ok(!out.includes('headers='));
});

// The standing requirement is Telugu. It is applied at ranking time so that a
// provider which starts shipping Telugu tomorrow wins with no code change.
test('an audio source carrying the preferred language outranks a richer one without it', () => {
  const withTelugu = { audio: { renditions: [{ name: 'Telugu', language: 'tel' }] } };
  const withoutTelugu = {
    audio: {
      renditions: [
        { name: 'Hindi', language: 'hin' },
        { name: 'Tamil', language: 'tam' },
        { name: 'Kannada', language: 'kan' },
      ],
    },
  };
  assert.ok(h.audioScore(withTelugu) > h.audioScore(withoutTelugu));
});

test('with the preferred language on both sides, more tracks wins', () => {
  const one = { audio: { renditions: [{ name: 'Telugu', language: 'tel' }] } };
  const three = {
    audio: {
      renditions: [
        { name: 'Telugu', language: 'tel' },
        { name: 'Tamil', language: 'tam' },
        { name: 'Hindi', language: 'hin' },
      ],
    },
  };
  assert.ok(h.audioScore(three) > h.audioScore(one));
});

test('a source with no renditions scores zero', () => {
  assert.equal(h.audioScore({}), 0);
  assert.equal(h.audioScore({ audio: { renditions: [] } }), 0);
});

// The duration gate is the wrong-film guard. CastleTV matches by TITLE, so it
// is the one provider that can land on a different film - and a different film
// has a different runtime. Measured on Devara: showsst 10299.6s vs castle
// 10299.6s, drift 0.0s.
test('the duration tolerance is a real, finite number of seconds', () => {
  assert.ok(Number.isFinite(h.DURATION_TOLERANCE_SECONDS));
  assert.ok(h.DURATION_TOLERANCE_SECONDS > 0);
});

test('a plan id is stable for the same pair and differs across pairs', () => {
  const plan = (vUrl, aUrl) => ({
    video: { stream: { provider: 'showsst', url: vUrl } },
    audio: { stream: { provider: 'CastleTV', url: aUrl } },
    height: 804,
  });
  const a = h.planId(plan('v1', 'a1'));
  assert.equal(a, h.planId(plan('v1', 'a1')));
  assert.notEqual(a, h.planId(plan('v1', 'a2')));
  assert.notEqual(a, h.planId(plan('v2', 'a1')));
});

// The audio sync bug, 2026-09-22. showsst video segment 0 starts at PTS
// 0.000000 while CastleTV audio segment 0 starts at 1.478556 - Castle's own
// source baseline, faithfully preserved by our -copyts demux. hls.js aligns
// the two BY PTS, so the borrowed audio played ~1.48s late for the whole film.
test('a rebase is stamped onto an audio rendition url', () => {
  assert.equal(h.withPts('http://x/audio-3.m3u8', -1.478556),
    'http://x/audio-3.m3u8?pts=-1.478556');
  assert.equal(h.withPts('http://x/a.m3u8?v=1', -1.5), 'http://x/a.m3u8?v=1&pts=-1.5');
});

// Standalone Castle playback is self-consistent already - its own video and
// audio sit 47ms apart - so a zero offset must leave the url byte-identical.
test('a zero offset leaves the url untouched', () => {
  assert.equal(h.withPts('http://x/audio-3.m3u8', 0), 'http://x/audio-3.m3u8');
  assert.equal(h.withPts('http://x/audio-3.m3u8', undefined), 'http://x/audio-3.m3u8');
});

// ---------------------------------------------------------------------------
// The runtime-anchored pairing gate.
//
// The strict 15s gate is a WRONG-FILM guard - CastleTV matches by title, so
// two halves that disagree on runtime may be two different films. But runtime
// equality is only a proxy for same-film, and it also refuses the same film
// carrying different ad/intro padding.
//
// Measured 2026-09-23 on movie/1290190 (Lokah Chapter 1: Chandra):
//   mapple  2160p  9376s   Castle 720p 8974s   TMDB runtime 151min = 9060s
// A 402s gap. The strict gate refused, so the only 2160p picture on the title
// could never be paired with the only Telugu audio on it.
//
// These drive planPairings through the describe cache rather than the network:
// the gate is the thing under test, not manifest fetching.
function seedDescribe(stream, desc) {
  h._describeCache.set(`${stream.provider}|${stream.url}`, { at: Date.now(), value: desc });
}
function videoDesc(seconds, height) {
  return { seconds, headers: {}, video: { height, text: '', url: 'http://v/' }, audio: null };
}
function audioDesc(seconds, names) {
  return {
    seconds, headers: {},
    video: null,
    audio: { renditions: names.map((n, i) => ({ name: n, url: `http://a/${i}.m3u8` })) },
  };
}
// The real 1290190 numbers, so a change to the constants that would have
// re-broken this title fails here rather than in the player.
const LOKAH_VIDEO = 9376;
const LOKAH_AUDIO = 8974;
const LOKAH_RUNTIME = 151 * 60;

function lokahStreams() {
  const v = { provider: 'mapple', url: `http://v/${Math.random()}.m3u8` };
  const a = { provider: 'CastleTV', url: `http://a/${Math.random()}.m3u8` };
  seedDescribe(v, videoDesc(LOKAH_VIDEO, 2160));
  seedDescribe(a, audioDesc(LOKAH_AUDIO, ['Hindi', 'Tamil', 'Telugu']));
  return [v, a];
}

test('without a runtime, a padded pairing is still refused', async () => {
  const plans = await h.planPairings(lokahStreams());
  assert.equal(plans.length, 0,
    'the strict gate must keep working when no runtime is available');
});

test('a TMDB runtime lets the same film pair despite different padding', async () => {
  const plans = await h.planPairings(lokahStreams(), { runtimeSeconds: LOKAH_RUNTIME });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].height, 2160, 'the 2160p mapple picture must be the video side');
  assert.equal(plans[0].padded, true, 'the caller must be told the gap is padding');
  assert.ok(plans[0].languages.includes('Telugu'));
  assert.ok(Math.abs(plans[0].delta - (LOKAH_VIDEO - LOKAH_AUDIO)) < 1);
});

// The runtime is the SAME-FILM arbiter, so it must vouch for BOTH halves
// individually. Two sides that merely differ from each other by a plausible
// amount are not evidence of anything.
test('a side far from the stated runtime is refused even with a runtime', async () => {
  const v = { provider: 'mapple', url: 'http://v/ep.m3u8' };
  const a = { provider: 'CastleTV', url: 'http://a/film.m3u8' };
  seedDescribe(v, videoDesc(45 * 60, 1080));       // an episode
  seedDescribe(a, audioDesc(151 * 60, ['Telugu'])); // the film
  const plans = await h.planPairings([v, a], { runtimeSeconds: LOKAH_RUNTIME });
  assert.equal(plans.length, 0, 'a 45min reel must not pair with a 151min film');
});

// Even with both sides near the runtime, the gap itself has a ceiling.
test('padding beyond the ceiling is refused', async () => {
  const v = { provider: 'mapple', url: 'http://v/long.m3u8' };
  const a = { provider: 'CastleTV', url: 'http://a/short.m3u8' };
  // Both within RUNTIME_MATCH_SECONDS (600) of runtime, but 1200s apart -
  // over PADDED_TOLERANCE_SECONDS (900).
  seedDescribe(v, videoDesc(LOKAH_RUNTIME + 600, 2160));
  seedDescribe(a, audioDesc(LOKAH_RUNTIME - 600, ['Telugu']));
  const plans = await h.planPairings([v, a], { runtimeSeconds: LOKAH_RUNTIME });
  assert.equal(plans.length, 0);
});

// An exactly-matching pairing is not "padded", and must not carry the flag -
// the UI shows a timing warning off the back of it.
test('a pairing inside the strict gate is not flagged as padded', async () => {
  const v = { provider: 'mapple', url: 'http://v/exact.m3u8' };
  const a = { provider: 'CastleTV', url: 'http://a/exact.m3u8' };
  seedDescribe(v, videoDesc(LOKAH_RUNTIME + 2, 2160));
  seedDescribe(a, audioDesc(LOKAH_RUNTIME, ['Telugu']));
  const plans = await h.planPairings([v, a], { runtimeSeconds: LOKAH_RUNTIME });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].padded, false);
});

// Ranking: an exact pairing is the safer bet, since a padded one may still
// need a manual nudge. Same height and same audio score, so `padded` decides.
test('an exact pairing outranks a padded one of equal height', async () => {
  const vExact = { provider: 'showsst', url: 'http://v/ex.m3u8' };
  const vPad = { provider: 'mapple', url: 'http://v/pad.m3u8' };
  const a = { provider: 'CastleTV', url: 'http://a/one.m3u8' };
  seedDescribe(vExact, videoDesc(LOKAH_AUDIO + 3, 2160));
  seedDescribe(vPad, videoDesc(LOKAH_VIDEO, 2160));
  seedDescribe(a, audioDesc(LOKAH_AUDIO, ['Telugu']));
  const plans = await h.planPairings([vExact, vPad, a], { runtimeSeconds: LOKAH_RUNTIME });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].padded, false, 'the exact pairing must rank first');
  assert.equal(plans[1].padded, true);
});
