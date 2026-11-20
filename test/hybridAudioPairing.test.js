'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');

// Castle and NetMirror Telugu audio over another provider's HLS video.
// One test per bug in docs/PENDING-WORK.md H1-H5, each written to fail first.

const h = require('../utils/hybridStream');
const streamHeaders = require('../lib/media/streamHeaders');
const { registerPairRoute, getJob } = require('../lib/media/hybridRoutes');

const BASE = 'http://localhost:8790';
const realFetch = global.fetch;
const enc = encodeURIComponent;

function proxyUrl(target, headers) {
  return `${BASE}/m3u8-proxy?url=${enc(target)}`
    + (headers ? `&headers=${enc(JSON.stringify(headers))}` : '');
}

function media(seconds, prefix) {
  const n = Math.round(seconds / 10);
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:10.0,', `${prefix}/${i}.ts`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

// A fetch stub over a url -> body map. A body may be a function of the
// request headers, which lets a test insist on a Referer.
function stubFetch(routes, seen = []) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    seen.push({ url: u, headers: opts.headers || {} });
    const body = routes[u];
    const text = typeof body === 'function' ? body(opts.headers || {}) : body;
    if (text == null) return new Response('', { status: 404 });
    return new Response(text);
  };
  return seen;
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

// ---------- H1 ----------
// The web posts an already-proxied NetMirror master, so the rendition urls in
// the plan are this server's /m3u8-proxy urls. buildMaster treated those as
// LOCAL and dropped rebase=1, and the proxy honours `pts` only with rebase=1:
// the measured offset was silently thrown away.
test('H1: a proxied remote audio rendition keeps rebase=1 with its pts', () => {
  const target = 'https://nm.cdn.test/files/X/a/3/3.m3u8';
  const plan = {
    height: 1080,
    video: { stream: { provider: 'showsst' }, desc: { headers: {}, video: { url: 'https://v.test/1080.m3u8', ladder: [] } } },
    audio: {
      stream: { provider: 'NetMirror' },
      desc: {
        headers: {},
        audio: { renditions: [{ name: 'Telugu', language: 'tel', url: proxyUrl(target, { Referer: 'https://nm.test/' }) }] },
      },
    },
  };
  const master = h.buildMaster(plan, BASE, 'avc1.640028', 1.5);
  const uri = master.match(/#EXT-X-MEDIA:[^\n]*URI="([^"]+)"/)[1];
  assert.match(uri, /[?&]pts=1\.5(&|$)/, uri);
  assert.match(uri, /[?&]rebase=1(&|$)/, `rebase=1 missing: ${uri}`);
  // Unwrapped and re-wrapped once: no proxy inside a proxy.
  assert.equal(uri.split('m3u8-proxy').length - 1, 1, uri);
  assert.ok(uri.includes(enc(target)), uri);
  // The wrapper's Referer must survive the unwrap.
  assert.ok(decodeURIComponent(uri).includes('https://nm.test/'), uri);
});

test('H1: a castle-demux audio rendition stays local and takes pts without rebase', () => {
  const local = `${BASE}/castle-demux/abc/audio-0.m3u8`;
  const plan = {
    height: 1080,
    video: { stream: { provider: 'showsst' }, desc: { headers: {}, video: { url: 'https://v.test/1080.m3u8', ladder: [] } } },
    audio: { stream: { provider: 'CastleTV' }, desc: { headers: {}, audio: { renditions: [{ name: 'Telugu', language: 'tel', url: local }] } } },
  };
  const uri = h.buildMaster(plan, BASE, 'avc1.640028', 2).match(/URI="([^"]+)"/)[1];
  assert.equal(uri, `${local}?pts=2`);
});

test('unwrapProxied reads the inner target and its headers, and leaves plain urls alone', () => {
  const inner = 'https://cdn.test/a.m3u8?x=1&y=2';
  assert.deepEqual(h.unwrapProxied(proxyUrl(inner, { Referer: 'R' })), { url: inner, headers: { Referer: 'R' } });
  assert.deepEqual(h.unwrapProxied(proxyUrl(inner)), { url: inner, headers: {} });
  assert.deepEqual(h.unwrapProxied(inner), { url: inner, headers: {} });
  assert.deepEqual(h.unwrapProxied(`${BASE}/castle-demux/a/master.m3u8`),
    { url: `${BASE}/castle-demux/a/master.m3u8`, headers: {} });
});

// ---------- H2 ----------
// The viewer chose showsst's 720p picture and Castle's Telugu. Castle's demux
// master is taller (1080p) and showsst also lists one audio rendition, so the
// SWAPPED pairing (Castle video + showsst audio) sorted first by height and the
// route served it.
test('H2: /hybrid/pair keeps the viewer\'s video as video and the donor as audio', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const V = 'https://v.h2.test/master.m3u8';
  const A = 'https://a.h2.test/master.m3u8';
  stubFetch({
    [V]: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Hindi",LANGUAGE="hin",URI="hin.m3u8"\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="a"\n720.m3u8\n',
    'https://v.h2.test/720.m3u8': media(600, 'v'),
    'https://v.h2.test/hin.m3u8': media(600, 'h'),
    [A]: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="c",NAME="Telugu",LANGUAGE="tel",URI="tel.m3u8"\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="c"\n1080.m3u8\n',
    'https://a.h2.test/1080.m3u8': media(600, 'c'),
    'https://a.h2.test/tel.m3u8': media(600, 't'),
  });
  const app = fakeApp();
  registerPairRoute(app);
  const res = await postPair(app, {
    video: { url: V, provider: 'showsst', headers: { Referer: 'r' } },
    audio: { url: A, provider: 'CastleTV', headers: { Referer: 'r' } },
  });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const id = res.body.url.match(/hybrid\/([^/]+)\/master/)[1];
  const { plan } = getJob(id);
  assert.equal(plan.video.stream.provider, 'showsst', 'video role swapped');
  assert.equal(plan.audio.stream.provider, 'CastleTV', 'audio role swapped');
});

// ---------- H3 ----------
// The browser posts the PROXIED url. The registry holds headers under the
// upstream url, so the raw lookup missed and the upstream was fetched bare.
test('H3: headers are refilled for a proxied url from the upstream url\'s entry', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const vUp = 'https://v.h3.test/master.m3u8';
  const aUp = 'https://a.h3.test/master.m3u8';
  streamHeaders.remember(vUp, { Referer: 'https://mapple.h3/' });
  streamHeaders.remember(aUp, { Referer: 'https://nm.h3/' });
  const needs = (ref, body) => (hdrs) => (hdrs.Referer === ref ? body : null);
  const seen = stubFetch({
    [vUp]: needs('https://mapple.h3/', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080.m3u8\n'),
    'https://v.h3.test/1080.m3u8': needs('https://mapple.h3/', media(600, 'v')),
    [aUp]: needs('https://nm.h3/', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Telugu",LANGUAGE="tel",URI="tel.m3u8"\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="a"\n360.m3u8\n'),
    'https://a.h3.test/360.m3u8': needs('https://nm.h3/', media(600, 'n')),
    'https://a.h3.test/tel.m3u8': needs('https://nm.h3/', media(600, 't')),
  });
  const app = fakeApp();
  registerPairRoute(app);
  const res = await postPair(app, {
    video: { url: proxyUrl(vUp), provider: 'mapple' },
    audio: { url: proxyUrl(aUp), provider: 'NetMirror' },
  });
  assert.equal(res.code, 200, `${JSON.stringify(res.body)} fetched: ${seen.map((s) => s.url).join(' ')}`);
  const up = seen.find((s) => s.url === vUp);
  assert.ok(up, 'upstream video master fetched directly');
  assert.equal(up.headers.Referer, 'https://mapple.h3/');
});

// ---------- H4 ----------
// Castle ships one file per language on many titles. The demux used only the
// FIRST Castle row and needed 2+ audio tracks, so a Hindi file listed before a
// Telugu-only file meant Castle could never donate Telugu at all.
const runtime = require('../lib/runtime/environment');
const castleDemux = require('../utils/castleDemux');
const { buildCastleDemuxEntry } = require('../lib/media/republish');

function castleFixture(t, probes) {
  const feat = runtime.features.castleDemux;
  Object.defineProperty(runtime.features, 'castleDemux', { value: true, configurable: true, writable: true });
  const realGet = castleDemux.getProbe;
  castleDemux.getProbe = (u) => probes[u] || null;
  t.after(() => {
    runtime.features.castleDemux = feat;
    castleDemux.getProbe = realGet;
    global.fetch = realFetch;
  });
  const routes = {};
  for (const u of Object.keys(probes)) routes[u] = media(60, u.replace(/\.m3u8$/, ''));
  return stubFetch(routes);
}
const track = (language) => ({ index: 1, language, codec: 'aac', channels: 2 });

test('H4: a Telugu-only Castle file after a Hindi one donates Telugu', async (t) => {
  const hin = 'https://castle.h4.test/hin.m3u8';
  const tel = 'https://castle.h4.test/tel.m3u8';
  castleFixture(t, {
    [hin]: { videoIndex: 0, audio: [track('hin')] },
    [tel]: { videoIndex: 0, audio: [track('tel')] },
  });
  const out = await buildCastleDemuxEntry([
    { provider: 'CastleTV', url: hin, language: 'Hindi' },
    { provider: 'CastleTV', url: tel, language: 'Telugu' },
  ], BASE);
  assert.ok(out, 'no demux entry');
  assert.deepEqual(out.languages, ['Telugu']);
  assert.equal(out.selectableAudio, true);
});

test('H4: a single und-tagged track on a Telugu-labelled row is labelled Telugu', async (t) => {
  const tel = 'https://castle.h4b.test/tel.m3u8';
  castleFixture(t, { [tel]: { videoIndex: 0, audio: [track('und')] } });
  const out = await buildCastleDemuxEntry([{ provider: 'CastleTV', url: tel, language: 'Telugu' }], BASE);
  assert.ok(out, 'no demux entry');
  assert.deepEqual(out.languages, ['Telugu']);
});

test('H4: a single track in another language is still not demuxed', async (t) => {
  const hin = 'https://castle.h4c.test/hin.m3u8';
  castleFixture(t, { [hin]: { videoIndex: 0, audio: [track('hin')] } });
  const out = await buildCastleDemuxEntry([{ provider: 'CastleTV', url: hin, language: 'Hindi' }], BASE);
  assert.equal(out, null);
});

test('H4: a multi-track first row that already has Telugu costs one probe only', async (t) => {
  const multi = 'https://castle.h4d.test/multi.m3u8';
  const tel = 'https://castle.h4d.test/tel.m3u8';
  const seen = castleFixture(t, {
    [multi]: { videoIndex: 0, audio: [track('hin'), track('tel'), track('tam')] },
    [tel]: { videoIndex: 0, audio: [track('tel')] },
  });
  const out = await buildCastleDemuxEntry([
    { provider: 'CastleTV', url: multi, language: 'Hindi' },
    { provider: 'CastleTV', url: tel, language: 'Telugu' },
  ], BASE);
  assert.deepEqual(out.languages, ['Hindi', 'Telugu', 'Tamil']);
  assert.ok(!seen.some((s) => s.url === tel), 'second row fetched needlessly');
});

// ---------- H5 ----------
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_API_BASE = 'https://nm.test';
process.env.NEWTV_DOMAINS = 'https://disc.test';
const tmdbPath = require.resolve(path.join(__dirname, '..', 'utils/tmdb.js'));
const realTmdb = require(tmdbPath);

function freshNetmirror(t) {
  const saved = require.cache[tmdbPath].exports;
  require.cache[tmdbPath].exports = {
    ...realTmdb,
    getDetails: async (type, id) => ({ title: `Film ${id}`, release_date: '2024-01-01', name: `Film ${id}` }),
    resolveImdbId: async () => 'tt1',
  };
  t.after(() => { require.cache[tmdbPath].exports = saved; global.fetch = realFetch; });
  delete require.cache[require.resolve('../providers/netmirror')];
  return require('../providers/netmirror');
}

function nmFetch(master) {
  const json = (b) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://nm.test/api/embed-tmdb/')) return json({ ok: true, streams: [] });
    if (u.startsWith('https://disc.test/checknewtv.php')) return json({ token_hash: Buffer.from('https://newtv.test').toString('base64') });
    if (u.includes('/newtv/search.php')) return json({ searchResult: [{ id: 'REAL1', t: u.match(/s=([^&]+)/) ? decodeURIComponent(u.match(/s=([^&]+)/)[1]) : '' }] });
    if (u.includes('/newtv/post.php')) return json({ lang: [{ l: 'Hindi', s: 'hin' }, { l: 'Telugu', s: 'tel' }], main_id: 'REAL1' });
    if (u.includes('/newtv/player.php')) return json({ status: 'ok', video_link: 'https://cdn.test/hls/REAL1.m3u8' });
    if (u.startsWith('https://cdn.test/hls/')) return new Response(master);
    return new Response('', { status: 404 });
  };
}

test('H5: a NetMirror HLS row whose master lists EXT-X-MEDIA audio says so', async (t) => {
  const { getNetmirrorStreams } = freshNetmirror(t);
  nmFetch('#EXTM3U\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="hin",NAME="[1] Hindi",DEFAULT=YES,URI="https://cdn.test/files/REAL1/a/0/0.m3u8"\n'
    + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="und",NAME="[2] Telugu",DEFAULT=NO,URI="https://cdn.test/files/REAL1/a/1/1.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aac",RESOLUTION=1920x1080\nhttps://cdn.test/files/REAL1/1080p/1080p.m3u8\n');
  const out = await getNetmirrorStreams('5101', 'movie');
  const row = [...out].find((r) => /cdn\.test\/hls/.test(r.url));
  assert.ok(row, `no HLS row: ${JSON.stringify(out)}`);
  assert.equal(row.selectableAudio, true);
  assert.deepEqual(row.audio.map((a) => a.language), ['Hindi', 'Telugu']);
});

test('H5: a NetMirror master without EXT-X-MEDIA audio claims nothing', async (t) => {
  const { getNetmirrorStreams } = freshNetmirror(t);
  nmFetch('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\nhttps://cdn.test/files/REAL1/1080p/1080p.m3u8\n');
  const out = await getNetmirrorStreams('5102', 'movie');
  const row = [...out].find((r) => /cdn\.test\/hls/.test(r.url));
  assert.ok(row, `no HLS row: ${JSON.stringify(out)}`);
  assert.equal(row.selectableAudio, undefined);
  assert.equal(row.audio, undefined);
});

test('H1: a castle-demux url that arrived proxied stays local (pts, no rebase)', () => {
  const local = `${BASE}/castle-demux/abc/audio-1.m3u8`;
  const plan = {
    height: 1080,
    video: { stream: { provider: 'showsst' }, desc: { headers: {}, video: { url: 'https://v.test/1080.m3u8', ladder: [] } } },
    audio: { stream: { provider: 'CastleTV' }, desc: { headers: {}, audio: { renditions: [{ name: 'Telugu', language: 'tel', url: proxyUrl(local) }] } } },
  };
  const uri = h.buildMaster(plan, BASE, 'avc1.640028', 2).match(/URI="([^"]+)"/)[1];
  assert.equal(uri, `${local}?pts=2`);
});
