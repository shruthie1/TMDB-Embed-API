'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const r = require('../utils/ptsRebase');

// Measured 2026-09-22 on Devara (811941): showsst video segment 0 starts at
// PTS 0.000000, CastleTV audio segment 0 at 1.478556. hls.js aligns BY PTS, so
// the borrowed audio ran 1.48s late for the whole film.
test('the offset puts the audio baseline onto the video baseline', () => {
  assert.equal(r.offsetFor(0, 1.478556), -1.478556);
  assert.equal(r.offsetFor(1.478556, 0), 1.478556);
});

// A wrong shift breaks a pairing that might have been fine; an unshifted one
// is merely as wrong as it already was. So an unreadable probe means no shift.
test('an unreadable probe yields no shift rather than a guess', () => {
  assert.equal(r.offsetFor(null, 1.478556), 0);
  assert.equal(r.offsetFor(0, null), 0);
  assert.equal(r.offsetFor(undefined, undefined), 0);
  assert.equal(r.offsetFor(NaN, 1), 0);
});

// One frame at 24fps is 41ms, and Castle's own video and audio sit 47ms apart
// in the source with nobody noticing. Below the threshold a rebase costs an
// ffmpeg run per segment to fix something invisible.
test('a sub-frame difference is not worth an ffmpeg run', () => {
  assert.equal(r.offsetFor(0, 0.02), 0);
  assert.equal(r.offsetFor(0, 0.049), 0);
  assert.notEqual(r.offsetFor(0, 0.06), 0);
  assert.ok(r.NEGLIGIBLE_SECONDS > 0 && r.NEGLIGIBLE_SECONDS < 0.125);
});

test('a measured offset is stamped onto a url', () => {
  assert.equal(r.withPts('http://x/a.m3u8', -1.478556), 'http://x/a.m3u8?pts=-1.478556');
  assert.equal(r.withPts('http://x/a.m3u8?v=1', -1.5), 'http://x/a.m3u8?v=1&pts=-1.5');
});

test('a zero offset leaves the url untouched', () => {
  assert.equal(r.withPts('http://x/a.m3u8', 0), 'http://x/a.m3u8');
  assert.equal(r.withPts('http://x/a.m3u8'), 'http://x/a.m3u8');
});

test('an offset survives the round trip through a querystring', () => {
  const offset = r.offsetFor(0, 1.478556);
  const url = new URL(r.withPts('http://x/a.m3u8', offset));
  assert.equal(r.ptsFromQuery(Object.fromEntries(url.searchParams)), offset);
});

test('a missing or malformed pts reads as no shift', () => {
  assert.equal(r.ptsFromQuery({}), 0);
  assert.equal(r.ptsFromQuery({ pts: 'abc' }), 0);
  assert.equal(r.ptsFromQuery(null), 0);
});

// No ffmpeg run, no temp files - so putting the rebase on a path that does not
// need it costs nothing and cannot corrupt the bytes.
test('rebasing by zero returns the very same buffer', async () => {
  const buf = Buffer.from([0x47, 0x40, 0x00, 0x10]);
  assert.strictEqual(await r.rebaseSegment(buf, 0), buf);
});

// A segment we cannot shift is still a segment: serving it unshifted keeps
// playback going with bad sync, whereas failing the request stalls it.
test('an unshiftable segment is returned rather than failing', async () => {
  const notMpegTs = Buffer.from('this is not a transport stream');
  const out = await r.rebaseSegment(notMpegTs, -1.5);
  assert.ok(Buffer.isBuffer(out));
});
