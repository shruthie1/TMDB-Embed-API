'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const sh = require('../lib/media/streamHeaders');

// WHY THIS MODULE EXISTS - measured 2026-09-23 on movie/1290190.
//
// The player's pairSources() posts back {url, provider, quality} only. mapple
// 404s its own 2160p master without Referer/Origin/UA:
//   no-hdr    404  21b   with-hdr  200  853b
// so describeStream returned null for the video side and /hybrid/pair blamed
// a runtime disagreement for what was a missing Referer.

const MAPPLE = {
  'User-Agent': 'Mozilla/5.0 ... Chrome/152.0.0.0 Safari/537.36',
  Referer: 'https://mapple.fun/',
  Origin: 'https://mapple.fun',
};

test('headers recorded at resolve are recoverable by url', () => {
  sh.remember('http://x/a.m3u8', MAPPLE);
  assert.deepEqual(sh.headersFor('http://x/a.m3u8'), MAPPLE);
});

test('an unknown url yields null, never an empty object', () => {
  // null means "we do not know"; {} would read as "it needs no headers" and
  // would suppress the missingHeaders diagnostic in /hybrid/pair.
  assert.equal(sh.headersFor('http://x/never-seen.m3u8'), null);
});

test('a stream with no headers is filled in from the registry', () => {
  sh.remember('http://x/b.m3u8', MAPPLE);
  const filled = sh.withKnownHeaders({ url: 'http://x/b.m3u8', provider: 'mapple' });
  assert.deepEqual(filled.headers, MAPPLE);
  assert.equal(filled.provider, 'mapple', 'the rest of the stream survives');
});

// A caller that went to the trouble of sending headers knows something we may
// not - a fresher signature, say. Never overwrite them.
test('explicit headers on the stream win over the registry', () => {
  sh.remember('http://x/c.m3u8', MAPPLE);
  const mine = { Referer: 'https://other.example/' };
  const out = sh.withKnownHeaders({ url: 'http://x/c.m3u8', headers: mine });
  assert.deepEqual(out.headers, mine);
});

test('a stream we know nothing about is returned untouched', () => {
  const s = { url: 'http://x/unknown.m3u8', provider: 'p' };
  assert.equal(sh.withKnownHeaders(s), s, 'same object, not a needless copy');
});

// Only headers worth having are stored: a provider that needs none must not
// occupy an entry, or the bound evicts real ones to hold empty objects.
test('streams without headers are not recorded', () => {
  const n = sh.rememberStreams([
    { url: 'http://x/d.m3u8', headers: MAPPLE },
    { url: 'http://x/e.m3u8', headers: {} },
    { url: 'http://x/f.m3u8' },
    null,
  ]);
  assert.equal(n, 1);
  assert.equal(sh.headersFor('http://x/e.m3u8'), null);
  assert.equal(sh.headersFor('http://x/f.m3u8'), null);
});

test('rememberStreams tolerates a non-array', () => {
  assert.equal(sh.rememberStreams(null), 0);
  assert.equal(sh.rememberStreams(undefined), 0);
});

// Stored by value: a provider that reuses and mutates its header object must
// not retroactively change what we recorded for an earlier url.
test('a later mutation of the caller\'s object does not change the record', () => {
  const live = { Referer: 'https://a.example/' };
  sh.remember('http://x/g.m3u8', live);
  live.Referer = 'https://b.example/';
  assert.equal(sh.headersFor('http://x/g.m3u8').Referer, 'https://a.example/');
});
