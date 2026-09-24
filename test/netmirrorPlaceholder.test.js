'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const { masterMatchesTitle } = require('../providers/netmirror');

// NetMirror returns a well-formed master whose AUDIO renditions carry the
// correct per-title id and real languages, while the VIDEO rungs point at one
// shared decoy. Playing it gives the viewer the wrong film's picture with the
// right film's audio metadata, which is worse than returning nothing.
//
// Captured verbatim 2026-09-22 from
//   https://tv.imgcdn.kim/newtv/hls/pv/0QSTXR0EXWWYI4D3UGMLFM4A0Q.m3u8
// requested for tmdb 155 (The Dark Knight). 693134 (Dune: Part Two) produced
// the same decoy id, 220884, from a different platform path.
const DECOY_MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="eng",NAME="[1] English",DEFAULT=YES,URI="https://s14.freecdn2.top/files/0QSTXR0EXWWYI4D3UGMLFM4A0Q/a/0/0.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tel",NAME="[4] Telugu",DEFAULT=NO,URI="https://s14.freecdn2.top/files/0QSTXR0EXWWYI4D3UGMLFM4A0Q/a/3/3.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aac",RESOLUTION=1920x800
https://s21.freecdn4.top/files/220884/1080p/1080p.m3u8?in=unknown::ni
#EXT-X-STREAM-INF:BANDWIDTH=600000,AUDIO="aac",RESOLUTION=1280x528
https://s21.freecdn4.top/files/220884/720p/720p.m3u8?in=unknown::ni
`;

const GOOD_MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tel",NAME="Telugu",DEFAULT=NO,URI="https://cdn.example/files/WANTED123/a/0/0.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aac",RESOLUTION=1920x1080
https://cdn.example/files/WANTED123/1080p/1080p.m3u8
`;

function stubFetch(body, { ok = true } = {}) {
  const real = global.fetch;
  global.fetch = async () => ({ ok, text: async () => body });
  return () => { global.fetch = real; };
}

test('a master whose video rungs point at another file id is rejected', async () => {
  const restore = stubFetch(DECOY_MASTER);
  try {
    const ok = await masterMatchesTitle('https://x/m.m3u8', '0QSTXR0EXWWYI4D3UGMLFM4A0Q', 'https://r/');
    assert.equal(ok, false, 'decoy master must be rejected');
  } finally { restore(); }
});

// The audio renditions DO carry the wanted id. Reading the URI="" attributes as
// if they were variants would wrongly accept the decoy, so only bare URI lines
// count as video.
test('audio rendition ids do not count as video ids', async () => {
  const restore = stubFetch(DECOY_MASTER);
  try {
    assert.equal(await masterMatchesTitle('https://x/m.m3u8', '220884', 'https://r/'), true,
      'the decoy id IS the video id, so a request for it legitimately matches');
  } finally { restore(); }
});

test('a master serving its own id is accepted', async () => {
  const restore = stubFetch(GOOD_MASTER);
  try {
    assert.equal(await masterMatchesTitle('https://x/m.m3u8', 'WANTED123', 'https://r/'), true);
  } finally { restore(); }
});

// This is a guard against one known decoy, not a general validator. A flaky
// fetch or a non-master body must never drop a stream that might be fine.
test('network failure and non-master bodies fail open', async () => {
  let restore = stubFetch('', { ok: false });
  try {
    assert.equal(await masterMatchesTitle('https://x/m.m3u8', 'ANY', ''), true, 'HTTP error fails open');
  } finally { restore(); }

  restore = stubFetch('#EXTM3U\n#EXTINF:4,\nseg0.ts\n');
  try {
    assert.equal(await masterMatchesTitle('https://x/m.m3u8', 'ANY', ''), true, 'media playlist fails open');
  } finally { restore(); }

  const real = global.fetch;
  global.fetch = async () => { throw new Error('boom'); };
  try {
    assert.equal(await masterMatchesTitle('https://x/m.m3u8', 'ANY', ''), true, 'thrown fetch fails open');
  } finally { global.fetch = real; }
});
