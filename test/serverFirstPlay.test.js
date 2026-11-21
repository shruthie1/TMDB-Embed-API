'use strict';
const assert = require('node:assert');
const { test, before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const compression = require('compression');
const { execFileSync } = require('child_process');

// Server first-play fixes (2026-11-21):
//  1. castle-demux rebuilds a job the Map lost (restart / deploy) from the store.
//  2. HLS text playlists are gzipped; segments and ranged bodies never are.
//  3. Proxied masters keep upstream CODECS and fill a missing one only from a
//     complete value the server already holds.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const runtime = require('../lib/runtime/environment');
const store = require('../utils/store');
const republish = require('../lib/media/republish');
const { compressFilter } = require('../proxy/playlistCompression');
const { rewriteM3u8, processStreamsForProxy, completeCodecs } = require('../proxy/proxyServer');

let dir;
let muxedTs;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firstplay-'));
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
    '-c:a', 'aac', '-f', 'mpegts', 'muxed.ts', '-y'], { cwd: dir });
  muxedTs = fs.readFileSync(path.join(dir, 'muxed.ts'));
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function listen(app) {
  return new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// ---- 1. castle-demux rebuild-on-miss ---------------------------------------

test('castle-demux: a job lost to a restart is rebuilt from the store; playlist and segment served', async (t) => {
  const feat = runtime.features.castleDemux;
  Object.defineProperty(runtime.features, 'castleDemux', { value: true, configurable: true, writable: true });
  t.after(() => { runtime.features.castleDemux = feat; });

  // Upstream Castle CDN: serves the muxed segment.
  const cdn = await listen(express().get('/c:n.ts', (req, res) => res.type('video/mp2t').send(muxedTs)));
  t.after(() => cdn.close());
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;

  const file = path.join(dir, 'learning.sqlite');
  store._setStore(store.openStore(file));
  const segments = [0, 1].map((i) => `${cdnBase}/c${i}.ts?t=123`);
  const playlistLines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2',
    ...segments.flatMap((s) => ['#EXTINF:2.0,', s]), '#EXT-X-ENDLIST'];
  const id = republish.storeCastleDemux({
    segments, playlistLines, headers: { Referer: 'https://castle.example/' },
    videoIndex: 0, videoWidth: 160, videoHeight: 90,
    audio: [{ index: 1, language: 'tel', codec: 'aac', channels: 1 }],
    videoCodec: 'avc1.64000c',
  });

  // Simulate the restart: memory gone, store closed and re-opened from disk.
  republish.castleDemuxJobs.clear();
  republish._persistedAt.clear();
  store.getStore().close();
  store._setStore(store.openStore(file));
  t.after(() => { store.getStore().close(); store._setStore(null); });

  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
  t.after(() => { console.log = origLog; });

  const app = express();
  republish.registerCastleDemuxRoutes(app);
  const srv = await listen(app);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/castle-demux/${id}`;

  const master = await get(`${base}/master.m3u8`);
  assert.equal(master.status, 200, master.body.toString());
  assert.match(master.body.toString(), /LANGUAGE="tel"/);
  const video = await get(`${base}/video.m3u8`);
  assert.equal(video.status, 200);
  assert.equal(video.body.toString().split('\n').filter((l) => l.includes('/seg/v/')).length, 2);
  const seg = await get(`${base}/seg/a0/1.ts`);
  assert.equal(seg.status, 200, seg.body.toString());
  assert.equal(seg.headers['content-type'], 'video/mp2t');
  assert.equal(seg.body[0], 0x47, 'MPEG-TS sync byte');
  assert.ok(logs.some((l) => l.startsWith(`castle-demux: rebuild-on-miss id=${id} result=rebuilt segments=2`)), logs.join('\n'));
  // One rebuild serves the rest from memory.
  assert.equal(logs.filter((l) => l.startsWith('castle-demux: rebuild-on-miss')).length, 1);
});

test('castle-demux: an id never persisted still 404s and logs the miss', async (t) => {
  store._setStore(store.openStore(':memory:'));
  t.after(() => store._setStore(null));
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  t.after(() => { console.log = origLog; });
  const app = express();
  republish.registerCastleDemuxRoutes(app);
  const srv = await listen(app);
  t.after(() => srv.close());
  const r = await get(`http://127.0.0.1:${srv.address().port}/castle-demux/0123456789abcdef01234567/video.m3u8`);
  assert.equal(r.status, 404);
  assert.ok(logs.some((l) => l === 'castle-demux: rebuild-on-miss id=0123456789abcdef01234567 result=not-persisted'));
});

test('castle-demux: a stored spec whose content does not hash to the id is refused', () => {
  const s = store.openStore(':memory:');
  store._setStore(s);
  try {
    s.putDemuxJob('ffffffffffffffffffffffff', { playlistLines: ['#EXTM3U', 'https://x/a.ts'], audio: [], videoIndex: 0 },
      Date.now() + 60000);
    assert.equal(republish.rebuildCastleDemux('ffffffffffffffffffffffff'), null);
  } finally { store._setStore(null); }
});

test('castle-demux: an expired persisted spec is not served', () => {
  const s = store.openStore(':memory:');
  s.putDemuxJob('a', { x: 1 }, Date.now() - 1);
  assert.equal(s.getDemuxJob('a'), null);
  assert.equal(s.pruneDemuxJobs(), 1);
  const j = store.openStore(':memory:', { backend: 'json' });
  j.putDemuxJob('b', { x: 2 }, Date.now() + 60000);
  assert.deepEqual(j.getDemuxJob('b'), { x: 2 });
});

// ---- 2. playlist compression ------------------------------------------------

async function compressionApp(t) {
  const app = express();
  app.use(compression({ filter: compressFilter(compression) }));
  const big = '#EXTM3U\n' + Array.from({ length: 3000 }, (_, i) => `#EXTINF:4.0,\nhttps://cdn.example/seg-${i}.ts`).join('\n');
  const send = (type) => (req, res) => { res.set('Content-Type', type); res.send(big); };
  app.get('/vnd.m3u8', send('application/vnd.apple.mpegurl'));
  app.get('/x.m3u8', send('application/x-mpegURL'));
  app.get('/audio.m3u8', send('audio/mpegurl'));
  app.get('/json', (req, res) => res.json({ big }));
  app.get('/seg.ts', send('video/mp2t'));
  app.get('/seg.m4s', send('video/mp4'));
  app.get('/seg.aac', send('audio/aac'));
  app.get('/ranged.m3u8', (req, res) => {
    res.status(206).set('Content-Type', 'application/vnd.apple.mpegurl')
      .set('Content-Range', `bytes 0-${big.length - 1}/${big.length}`).send(big);
  });
  app.get('/notransform.m3u8', (req, res) => {
    res.set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-transform').send(big);
  });
  const srv = await listen(app);
  t.after(() => srv.close());
  return { base: `http://127.0.0.1:${srv.address().port}`, rawLen: Buffer.byteLength(big) };
}

test('compression: HLS text playlists are gzipped and decode byte-identical', async (t) => {
  const { base, rawLen } = await compressionApp(t);
  for (const p of ['/vnd.m3u8', '/x.m3u8', '/audio.m3u8', '/json']) {
    const r = await get(base + p, { 'Accept-Encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip', p);
    if (p !== '/json') {
      assert.equal(zlib.gunzipSync(r.body).length, rawLen, p);
      assert.ok(r.body.length < rawLen / 4, `${p} wire ${r.body.length} raw ${rawLen}`);
    }
  }
});

test('compression: segments, ranged and no-transform responses are never gzipped', async (t) => {
  const { base, rawLen } = await compressionApp(t);
  for (const p of ['/seg.ts', '/seg.m4s', '/seg.aac', '/ranged.m3u8', '/notransform.m3u8']) {
    const r = await get(base + p, { 'Accept-Encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], undefined, p);
    assert.equal(r.body.length, rawLen, p);
  }
  // A Range request for a playlist is not compressed either.
  const r = await get(`${base}/vnd.m3u8`, { 'Accept-Encoding': 'gzip', Range: 'bytes=0-99' });
  assert.equal(r.headers['content-encoding'], undefined);
});

// ---- 3. CODECS in proxied masters -------------------------------------------

const BASE = 'https://api.example';
const NO_CODECS = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"\nv1080.m3u8\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"\nv720.m3u8\n';

test('codecs: upstream CODECS is preserved verbatim', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="hvc1.1.6.L120.90,mp4a.40.2"\nv.m3u8\n';
  const out = rewriteM3u8(master, 'https://up.example/m.m3u8', BASE, {}, 0, { knownCodecs: 'avc1.640028,mp4a.40.2' });
  const inf = out.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
  assert.deepEqual(inf, ['#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="hvc1.1.6.L120.90,mp4a.40.2"']);
});

test('codecs: a missing CODECS is filled from a complete known value on every variant', () => {
  const out = rewriteM3u8(NO_CODECS, 'https://up.example/m.m3u8', BASE, {}, 0, { knownCodecs: 'hvc1.1.6.L120.90,mp4a.40.2' });
  const inf = out.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
  assert.equal(inf.length, 2);
  for (const l of inf) assert.ok(l.endsWith(',CODECS="hvc1.1.6.L120.90,mp4a.40.2"'), l);
});

test('codecs: nothing is invented when the server does not know a complete value', () => {
  for (const known of [undefined, null, '', 'hevc', 'avc1.640028', 'mp4a.40.2', 'avc1"bad,mp4a.40.2']) {
    const out = rewriteM3u8(NO_CODECS, 'https://up.example/m.m3u8', BASE, {}, 0, { knownCodecs: known });
    assert.ok(!/CODECS=/.test(out), `known=${known}: ${out}`);
  }
  assert.equal(completeCodecs('avc1.640028, mp4a.40.2'), 'avc1.640028,mp4a.40.2');
});

test('codecs: processStreamsForProxy carries only a complete row codecs onto the proxied master url', () => {
  const [withC, videoOnly, none] = processStreamsForProxy([
    { url: 'https://up.example/a.m3u8', headers: { Referer: 'https://r/' }, codecs: 'avc1.640028,mp4a.40.2' },
    { url: 'https://up.example/b.m3u8', codecs: 'avc1.640028' },
    { url: 'https://up.example/c.m3u8', videoCodec: 'hevc' },
  ], BASE);
  assert.equal(new URL(withC.url).searchParams.get('codecs'), 'avc1.640028,mp4a.40.2');
  assert.equal(new URL(videoOnly.url).searchParams.get('codecs'), null);
  assert.equal(new URL(none.url).searchParams.get('codecs'), null);
});

test('compression: the real /m3u8-proxy route gzips its playlist (it mounts before the app-wide middleware)', async (t) => {
  const { createProxyRoutes } = require('../proxy/proxyServer');
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n'
    + Array.from({ length: 2000 }, (_, i) => `#EXTINF:4.0,\nseg-${i}.ts`).join('\n') + '\n#EXT-X-ENDLIST\n';
  const up = await listen(express().get('/media.m3u8', (req, res) => res.type('application/vnd.apple.mpegurl').send(body)));
  t.after(() => up.close());
  const app = express();
  createProxyRoutes(app);
  const srv = await listen(app);
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/m3u8-proxy?url=${encodeURIComponent(`http://127.0.0.1:${up.address().port}/media.m3u8`)}`;
  const gz = await get(url, { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  const raw = zlib.gunzipSync(gz.body);
  assert.ok(gz.body.length < raw.length / 4, `wire ${gz.body.length} raw ${raw.length}`);
  const plain = await get(url);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.length, raw.length);
});
