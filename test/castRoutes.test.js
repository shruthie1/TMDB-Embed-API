'use strict';
const assert = require('node:assert');
const { test, before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { execFileSync } = require('child_process');

// C1/C2 (docs/PENDING-WORK.md): casting to a TV through Web Video Caster.
// The TV fetches ONE url and plays it for the length of the film, so the cast
// master must outlive the 20-minute hybrid job, survive an API restart, offer
// one Telugu rendition, and give the receiver a video-only variant (a receiver
// that ignores the audio group then has no other audio to fall back to).

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const realFetch = global.fetch;

let dir;
let muxedTs;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-'));
  const run = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y'], { cwd: dir });
  // A muxed segment like OneTouchTV's: h264 + one AAC track.
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', 'muxed.ts']);
  muxedTs = fs.readFileSync(path.join(dir, 'muxed.ts'));
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); global.fetch = realFetch; });

function media(seconds, prefix) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
  for (let i = 0; i < Math.round(seconds / 10); i++) lines.push('#EXTINF:10.0,', `${prefix}/${i}.ts`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// Upstream stub: the cast code and hybridStream both fetch through global
// fetch. Requests to our own test server go through untouched.
function stubUpstream(routes) {
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
    const body = typeof routes === 'function' ? routes(u) : routes[u];
    if (body == null) return new Response('', { status: 404 });
    return new Response(body);
  };
}

async function start(opts = {}) {
  const app = express();
  app.use(express.json());
  const demux = require('../lib/media/republish');
  demux.registerCastleDemuxRoutes(app);
  const cast = require('../lib/media/castRoutes');
  const store = opts.storePath || path.join(dir, `jobs-${Math.random().toString(16).slice(2)}.json`);
  const handle = cast.registerCastRoutes(app, {
    storePath: store,
    keepaliveMs: 0,
    now: opts.now,
    tmdb: { getDetails: async () => ({ runtime: opts.runtimeMin ?? 120 }) },
    playlistHosts: opts.playlistHosts,
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
  return { base, store, handle, close: () => new Promise((r) => server.close(r)) };
}

const post = (url, body, type = 'application/json') => realFetch(url, {
  method: 'POST', headers: { 'Content-Type': type },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// A castle-demux job for Devara's layout: Kannada first, Telugu last.
function mintDemux(segPrefix) {
  const { storeCastleDemux } = require('../lib/media/republish');
  const segments = [0, 1, 2].map((i) => `${segPrefix}/c${i}.ts`);
  const playlistLines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10',
    ...segments.flatMap((s) => ['#EXTINF:10.0,', s]), '#EXT-X-ENDLIST'];
  return storeCastleDemux({
    segments, playlistLines, headers: {}, videoIndex: 0, videoWidth: 1280, videoHeight: 720,
    audio: [{ index: 1, language: 'kan' }, { index: 2, language: 'tam' }, { index: 3, language: 'tel' }],
    videoCodec: 'avc1.64001f',
  });
}

test('C1: pair cast: one Telugu audio-only rendition, video-only variant, TTL runtime+1h', async () => {
  const srv = await start({ runtimeMin: 120 });
  try {
    const demuxId = mintDemux('https://castle.test');
    stubUpstream((u) => {
      if (u === 'https://otv.test/master.m3u8') return media(7200, 'https://otv.test/s');
      if (/^https:\/\/otv\.test\/s\/\d+\.ts$/.test(u)) return muxedTs;
      if (/^https:\/\/castle\.test\/c\d+\.ts$/.test(u)) return muxedTs;
      return null;
    });
    // castle-demux media playlists are served by our own app: 3 x 10s is far
    // shorter than the video, so give the describe a full-length audio side.
    const { castleDemuxJobs } = require('../lib/media/republish');
    const job = castleDemuxJobs.get(demuxId);
    const segs = Array.from({ length: 720 }, (_, i) => `https://castle.test/c${i}.ts`);
    job.segments = segs;
    job.playlistLines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', ...segs.flatMap((s) => ['#EXTINF:10.0,', s]), '#EXT-X-ENDLIST'];

    const t0 = Date.now();
    const r = await post(`${srv.base}/cast`, {
      pair: { video: { url: 'https://otv.test/master.m3u8', provider: 'OneTouchTV' },
        audio: { url: `${srv.base}/castle-demux/${demuxId}/master.m3u8`, provider: 'CastleTV' } },
      tmdbId: 811941, type: 'movie', title: 'Devara',
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.match(body.url, new RegExp(`^${srv.base}/cast/[0-9a-f]{24}\\.m3u8$`));
    assert.equal(body.audio.language, 'tel');
    // runtime 120 min + 1h
    assert.ok(Math.abs(body.expiresAt - (t0 + 3 * 3600 * 1000)) < 60_000, String(body.expiresAt - t0));

    const m = await (await realFetch(body.url)).text();
    const mediaLines = m.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:'));
    assert.equal(mediaLines.length, 1, m);
    assert.match(mediaLines[0], /LANGUAGE="tel"/);
    assert.match(mediaLines[0], /DEFAULT=YES/);
    assert.match(mediaLines[0], new RegExp(`/castle-demux/${demuxId}/audio-2\\.m3u8`));
    // The variant is our own video-only playlist, not the muxed upstream.
    const variant = m.split('\n').find((l) => l && !l.startsWith('#'));
    assert.equal(variant, `${body.url.replace(/\.m3u8$/, '')}/video.m3u8`);

    const vpl = await (await realFetch(variant)).text();
    const seg0 = vpl.split('\n').find((l) => l && !l.startsWith('#'));
    assert.match(seg0, /\/cast\/[0-9a-f]{24}\/v\/0\.ts$/);
    const vr = await realFetch(seg0);
    assert.equal(vr.status, 200);
    const out = path.join(dir, 'v0.ts');
    fs.writeFileSync(out, Buffer.from(await vr.arrayBuffer()));
    const types = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', out])
      .toString()).streams.map((s) => s.codec_type);
    assert.deepEqual(types, ['video'], 'cast video segment must carry no audio');
  } finally { await srv.close(); }
});

test('C2: a remote audio rendition that carries video is refused', async () => {
  const srv = await start();
  try {
    stubUpstream((u) => {
      if (u === 'https://v.test/master.m3u8') return media(7200, 'https://v.test/s');
      if (u === 'https://nm.test/master.m3u8') {
        return '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Telugu",LANGUAGE="tel",URI="https://nm.test/te.m3u8"\n'
          + '#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttps://nm.test/v.m3u8\n';
      }
      if (u === 'https://nm.test/te.m3u8' || u === 'https://nm.test/v.m3u8') return media(7200, 'https://nm.test/a');
      if (/\.ts$/.test(u)) return muxedTs;
      return null;
    });
    const r = await post(`${srv.base}/cast`, {
      pair: { video: { url: 'https://v.test/master.m3u8', provider: 'X' },
        audio: { url: 'https://nm.test/master.m3u8', provider: 'NetMirror' } },
    });
    assert.equal(r.status, 409);
    assert.match((await r.json()).reason, /audio rendition carries video/);
  } finally { await srv.close(); }
});

test('C1: plain HLS url: master wraps the proxied media playlist', async () => {
  const srv = await start();
  try {
    stubUpstream({ 'https://plain.test/index.m3u8': media(5400, 'https://plain.test/s') });
    const r = await post(`${srv.base}/cast`, { url: 'https://plain.test/index.m3u8', title: 'X' });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const m = await (await realFetch(body.url)).text();
    assert.match(m, /^#EXTM3U/);
    assert.match(m, /#EXT-X-STREAM-INF:BANDWIDTH=\d+/);
    assert.ok(m.includes(`${srv.base}/m3u8-proxy?url=${encodeURIComponent('https://plain.test/index.m3u8')}`), m);
  } finally { await srv.close(); }
});

test('C1: plain castle-demux url: one Telugu rendition kept, the demux job is kept alive', async () => {
  const srv = await start({ runtimeMin: 0 });
  try {
    stubUpstream({});
    const demuxId = mintDemux('https://castle2.test');
    const r = await post(`${srv.base}/cast`, { url: `${srv.base}/castle-demux/${demuxId}/master.m3u8` });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const m = await (await realFetch(body.url)).text();
    const mediaLines = m.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:'));
    assert.equal(mediaLines.length, 1, m);
    assert.match(mediaLines[0], /NAME="Telugu".*DEFAULT=YES/);
    assert.ok(m.includes(`/castle-demux/${demuxId}/video.m3u8`));

    // castle-demux's own TTL is 30 min and dies on restart; the cast must not.
    const { castleDemuxJobs } = require('../lib/media/republish');
    castleDemuxJobs.delete(demuxId);
    srv.handle.keepalive();
    const back = castleDemuxJobs.get(demuxId);
    assert.ok(back, 'demux job re-stored under the same id');
    assert.ok(back.expiresAt >= body.expiresAt);
  } finally { await srv.close(); }
});

test('C1: jobs persist to disk and load on the next start; expired jobs 404', async () => {
  let clock = Date.now();
  const storePath = path.join(dir, 'persist.json');
  const a = await start({ storePath, now: () => clock });
  let url;
  try {
    stubUpstream({ 'https://p.test/i.m3u8': media(3600, 'https://p.test/s') });
    const body = await (await post(`${a.base}/cast`, { url: 'https://p.test/i.m3u8' })).json();
    url = new URL(body.url).pathname;
  } finally { await a.close(); }
  assert.ok(fs.existsSync(storePath));

  const b = await start({ storePath, now: () => clock });
  try {
    assert.equal((await realFetch(`${b.base}${url}`)).status, 200);
    clock += 3 * 3600 * 1000; // runtime unknown on a plain url: duration 1h + 1h
    const gone = await realFetch(`${b.base}${url}`);
    assert.equal(gone.status, 404);
  } finally { await b.close(); }
});

test('C1: POST /cast/playlist: allowlisted hosts only, 2 MB cap', async () => {
  const srv = await start({ playlistHosts: ['cdn.allowed.test'] });
  try {
    const ok = media(600, 'https://cdn.allowed.test/s');
    const r = await post(`${srv.base}/cast/playlist`, ok, 'application/vnd.apple.mpegurl');
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const served = await realFetch(body.url);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), ok);
    assert.ok(body.expiresAt - Date.now() <= 4 * 3600 * 1000 + 1000);

    const bad = await post(`${srv.base}/cast/playlist`, media(600, 'https://evil.test/s'), 'application/vnd.apple.mpegurl');
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /evil\.test/);

    const big = '#EXTM3U\n' + `#${'x'.repeat(100)}\n`.repeat(21000);
    const tooBig = await post(`${srv.base}/cast/playlist`, big, 'application/vnd.apple.mpegurl');
    assert.equal(tooBig.status, 413);
  } finally { await srv.close(); }
});

test('C1: bad input is a 400, unknown id a 404', async () => {
  const srv = await start();
  try {
    assert.equal((await post(`${srv.base}/cast`, {})).status, 400);
    assert.equal((await post(`${srv.base}/cast`, { url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await realFetch(`${srv.base}/cast/0123456789abcdef01234567.m3u8`)).status, 404);
  } finally { await srv.close(); }
});
