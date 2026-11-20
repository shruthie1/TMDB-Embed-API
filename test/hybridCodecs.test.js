'use strict';
const assert = require('node:assert');
const { test, before, after } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Castle/NetMirror Telugu audio over more video types.
// One test per bug in docs/PENDING-WORK.md H6-H9, each written to fail first.
// Fixtures are real media cut by ffmpeg, because the bugs live in how ffprobe
// and the codec readers treat real bytes.

const h = require('../utils/hybridStream');
const ptsRebase = require('../utils/ptsRebase');
const { registerPairRoute, getJob } = require('../lib/media/hybridRoutes');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const BASE = 'http://localhost:8790';
const realFetch = global.fetch;

let dir;
const fx = {};
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyb-codecs-'));
  const run = (args) => execFileSync(FFMPEG, ['-v', 'error', ...args, '-y'], { cwd: dir });
  // fMP4 HLS, picture starting at PTS 3.0 (mapple-style EXT-X-MAP playlist).
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
    '-g', '24', '-output_ts_offset', '3', '-f', 'hls', '-hls_segment_type', 'fmp4',
    '-hls_time', '2', '-hls_playlist_type', 'vod', 'v.m3u8']);
  // An AC-3 audio TS segment (a donor whose master states no CODECS).
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'ac3', '-f', 'mpegts', 'ac3.ts']);
  // A plain AAC audio TS segment.
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-f', 'mpegts', 'aac.ts']);
  for (const f of ['v.m3u8', 'init.mp4', 'v0.m4s', 'v1.m4s', 'ac3.ts', 'aac.ts']) {
    fx[f] = fs.readFileSync(path.join(dir, f));
  }
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); global.fetch = realFetch; });

function media(seconds, prefix, ext = 'ts') {
  const n = Math.round(seconds / 10);
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:10.0,', `${prefix}/${i}.${ext}`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

// An fMP4 media playlist the length of a film, every segment the same bytes.
function fmp4Playlist(seconds) {
  const n = Math.round(seconds / 10);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:10.0,', `s${i}.m4s`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function stubFetch(routes) {
  global.fetch = async (url) => {
    const u = String(url);
    let body = routes[u];
    if (body == null && /\/s\d+\.m4s$/.test(u)) body = routes['*.m4s'];
    if (body == null) return new Response('', { status: 404 });
    return new Response(body);
  };
}

function fakeApp() {
  const app = { routes: {} };
  app.post = (p, fn) => { app.routes[p] = fn; };
  return app;
}

async function postPair(app, body) {
  const req = { body, protocol: 'http', get: () => 'localhost:8790', headers: {} };
  const res = {
    code: 200,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await app.routes['/hybrid/pair'](req, res);
  return res;
}

function variantCodecs(master) {
  return [...master.matchAll(/#EXT-X-STREAM-INF:[^\n]*CODECS="([^"]+)"/g)].map((m) => m[1]);
}
function renditionCodecs(master) {
  return [...master.matchAll(/#EXT-X-MEDIA:[^\n]*CODECS="([^"]+)"/g)].map((m) => m[1]);
}

// A mapple fMP4 HEVC pair: the video url is a media playlist (no ladder, no
// CODECS line), the donor is a Castle-style Telugu rendition.
function fmp4Routes(tag) {
  const V = `https://v.${tag}.test/1080/index.m3u8`;
  const A = `https://a.${tag}.test/master.m3u8`;
  return {
    V, A,
    routes: {
      [V]: fmp4Playlist(600),
      [`https://v.${tag}.test/1080/init.mp4`]: fx['init.mp4'],
      '*.m4s': fx['v0.m4s'],
      [A]: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="c",NAME="Telugu",LANGUAGE="tel",URI="tel.m3u8"\n',
      [`https://a.${tag}.test/tel.m3u8`]: media(600, 't'),
      [`https://a.${tag}.test/t/0.ts`]: fx['aac.ts'],
    },
  };
}

// ---------- H6 ----------
// The PTS probe fed ffprobe a bare .m4s; without the init segment ffprobe
// cannot read it ("no tfhd was found"), so the offset silently fell to 0.
test('H6: an fMP4 playlist\'s start PTS is read from init + first segment', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const url = 'https://v.h6pts.test/1080/index.m3u8';
  stubFetch({
    [url]: fmp4Playlist(20),
    'https://v.h6pts.test/1080/init.mp4': fx['init.mp4'],
    '*.m4s': fx['v0.m4s'],
  });
  const pts = await h.probeStartPts(null, url, {}, 'v');
  assert.equal(pts, 3);
});

// The probe reads only TS H.264 SPS, so an HEVC fMP4 source with no CODECS on
// its variant was declared avc1.640032 and MSE built the wrong SourceBuffer.
// The provider had already measured the real CODECS (stream.codecs).
test('H6: the provider\'s stated codecs beat the avc1 default for an fMP4 video', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { V, A, routes } = fmp4Routes('h6codec');
  stubFetch(routes);
  const app = fakeApp();
  registerPairRoute(app);
  const res = await postPair(app, {
    video: { url: V, provider: 'mapple', codecs: 'hvc1.1.6.L150.90,mp4a.40.2' },
    audio: { url: A, provider: 'CastleTV' },
  });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const id = res.body.url.match(/hybrid\/([^/]+)\/master/)[1];
  const real = await h.realisePlan(getJob(id).plan, BASE);
  assert.deepEqual(variantCodecs(real.playlist), ['hvc1.1.6.L150.90']);
  // Measured PTS on both sides: video 3.0 from init+segment, so a shift exists.
  assert.notEqual(real.ptsOffset, 0, 'fMP4 video PTS was not measured');
});

test('H6: a codecs value that is not an RFC 6381 list is ignored', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { V, A, routes } = fmp4Routes('h6bad');
  stubFetch(routes);
  const app = fakeApp();
  registerPairRoute(app);
  const res = await postPair(app, {
    video: { url: V, provider: 'mapple', codecs: 'hvc1"\n#EXT-X-ENDLIST' },
    audio: { url: A, provider: 'CastleTV' },
  });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const id = res.body.url.match(/hybrid\/([^/]+)\/master/)[1];
  const real = await h.realisePlan(getJob(id).plan, BASE);
  assert.ok(!real.playlist.includes('hvc1"'), real.playlist);
  // avcC read from the init segment, not the blind default. ffmpeg's own
  // master writes avc1.64000a for this fixture.
  assert.deepEqual(variantCodecs(real.playlist), ['avc1.64000a']);
});

// With no stated codecs, an HEVC fMP4 source is read from its hvcC box.
// Oracle: ffmpeg's own master for the same encode says hvc1.1.6.L30.90.
test('H6: an HEVC fMP4 init segment yields its hvc1 codec string', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hyb-hevc-'));
  try {
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-t', '1',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=none',
      '-f', 'hls', '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod', 'v.m3u8', '-y'], { cwd: d });
    assert.equal(h.codecFromInit(fs.readFileSync(path.join(d, 'init.mp4'))), 'hvc1.1.6.L30.90');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---------- H7 ----------
// Every rendition was declared mp4a.40.2. An AC-3/EC-3 donor then gets an AAC
// SourceBuffer and the audio never decodes.
function donorPlan(audioMaster, tag) {
  return {
    height: 720,
    languages: ['Telugu'],
    delta: 0,
    video: { stream: { provider: 'showsst' }, desc: { headers: {}, video: { url: `https://v.${tag}.test/720.m3u8`, text: media(600, 'v'), ladder: [] } } },
    audio: { stream: { provider: 'NetMirror' }, desc: { headers: {}, audio: { renditions: h.parseAudioRenditions(audioMaster, `https://a.${tag}.test/master.m3u8`) } } },
  };
}

test('H7: the donor master\'s CODECS audio entry labels the renditions', () => {
  const master = '#EXTM3U\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Telugu",LANGUAGE="tel",URI="tel.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,ec-3",AUDIO="aud"\n1080.m3u8\n';
  const plan = donorPlan(master, 'h7m');
  const out = h.buildMaster(plan, BASE, 'avc1.640028', 0);
  assert.deepEqual(renditionCodecs(out), ['ec-3']);
});

test('H7: a donor with no CODECS is labelled from its probed segment (AC-3)', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="c",NAME="Telugu",LANGUAGE="tel",URI="tel.m3u8"\n';
  const plan = donorPlan(master, 'h7p');
  stubFetch({
    'https://a.h7p.test/tel.m3u8': media(600, 't'),
    'https://a.h7p.test/t/0.ts': fx['ac3.ts'],
    'https://v.h7p.test/v/0.ts': fx['aac.ts'],
  });
  const real = await h.realisePlan(plan, BASE);
  assert.deepEqual(renditionCodecs(real.playlist), ['ac-3']);
  assert.equal(real.audioCodec, 'ac-3');
});

test('H7: an AAC donor stays mp4a.40.2', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="c",NAME="Telugu",LANGUAGE="tel",URI="tel.m3u8"\n';
  const plan = donorPlan(master, 'h7a');
  stubFetch({
    'https://a.h7a.test/tel.m3u8': media(600, 't'),
    'https://a.h7a.test/t/0.ts': fx['aac.ts'],
  });
  const real = await h.realisePlan(plan, BASE);
  assert.deepEqual(renditionCodecs(real.playlist), ['mp4a.40.2']);
});

// ---------- H8 ----------
// The pair answered 200 with no word on what it would decode as, so the
// browser switched into a stream it could not play.
test('H8: /hybrid/pair states the final video and audio codecs', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { V, A, routes } = fmp4Routes('h8');
  stubFetch(routes);
  const app = fakeApp();
  registerPairRoute(app);
  const res = await postPair(app, {
    video: { url: V, provider: 'mapple', codecs: 'hvc1.1.6.L150.90,mp4a.40.2' },
    audio: { url: A, provider: 'CastleTV' },
  });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.codecs, { video: ['hvc1.1.6.L150.90'], audio: 'mp4a.40.2' });
  // The master was realised to answer that, so it is served from the job.
  const id = res.body.url.match(/hybrid\/([^/]+)\/master/)[1];
  assert.match(getJob(id).playlist, /CODECS="hvc1\.1\.6\.L150\.90"/);
});

// ---------- H9 ----------
// A segment ffmpeg cannot shift was served unshifted with no trace at all.
test('H9: a failed rebase logs a greppable line and counts it, still serving the bytes', async (t) => {
  const lines = [];
  const realWarn = console.warn;
  console.warn = (...a) => { lines.push(a.join(' ')); };
  t.after(() => { console.warn = realWarn; });
  const before = ptsRebase.stats.failures;
  const junk = Buffer.from('not a transport stream');
  const out = await ptsRebase.rebaseSegment(junk, 1.5, { url: 'https://a.h9.test/t/0.ts' });
  assert.strictEqual(out, junk, 'fallback must stay: unshifted bytes');
  assert.equal(ptsRebase.stats.failures, before + 1);
  const hit = lines.find((l) => l.startsWith('[pts-rebase] FAILED'));
  assert.ok(hit, `no [pts-rebase] FAILED line in ${JSON.stringify(lines)}`);
  assert.match(hit, /url=https:\/\/a\.h9\.test\/t\/0\.ts/);
  assert.match(hit, /reason=/);
});
