'use strict';
const assert = require('node:assert');
const { test } = require('node:test');

// Step 2 Task 1: POST /hybrid/pair takes an optional `language`. With it the
// donor must carry that language (else 409) and the master defaults to it.
// Without it, behaviour is exactly as before (APK 1.2.37 and web send none).

const h = require('../utils/hybridStream');
const { registerPairRoute, getJob } = require('../lib/media/hybridRoutes');

const realFetch = global.fetch;

function media(seconds, prefix) {
  const n = Math.round(seconds / 10);
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10'];
  for (let i = 0; i < n; i++) lines.push('#EXTINF:10.0,', `${prefix}/${i}.ts`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function stubFetch(routes) {
  global.fetch = async (url) => {
    const body = routes[String(url)];
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

// A video-only source and a donor whose master lists the given renditions.
// Each test uses its own host so the describe cache cannot leak between them.
function setup(host, renditions) {
  const V = `https://v.${host}.test/master.m3u8`;
  const A = `https://a.${host}.test/master.m3u8`;
  const routes = {
    [V]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080.m3u8\n',
    [`https://v.${host}.test/1080.m3u8`]: media(600, 'v'),
    [A]: '#EXTM3U\n'
      + renditions.map(([name, lang, uri]) =>
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${name}",LANGUAGE="${lang}",URI="${uri}"\n`).join('')
      + '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,AUDIO="a"\n360.m3u8\n',
    [`https://a.${host}.test/360.m3u8`]: media(600, 'n'),
  };
  for (const [, , uri] of renditions) routes[`https://a.${host}.test/${uri}`] = media(600, uri);
  stubFetch(routes);
  const app = fakeApp();
  registerPairRoute(app);
  const body = (extra = {}) => ({
    video: { url: V, provider: 'mapple', headers: { Referer: 'r' } },
    audio: { url: A, provider: 'NetMirror', headers: { Referer: 'r' } },
    ...extra,
  });
  return { app, body };
}

function mediaLines(playlist) {
  return String(playlist).split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:'));
}

function jobOf(res) {
  const id = res.body.url.match(/hybrid\/([^/]+)\/master/)[1];
  return { id, job: getJob(id) };
}

test('(a) language Hindi: 200, Hindi is DEFAULT=YES, Telugu NO, all renditions kept', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('pla', [['Telugu', 'tel', 'tel.m3u8'], ['Hindi', 'hin', 'hin.m3u8']]);
  const res = await postPair(app, body({ language: 'Hindi' }));
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const lines = mediaLines(jobOf(res).job.playlist);
  assert.equal(lines.length, 2, 'every rendition still present');
  const hindi = lines.find((l) => l.includes('NAME="Hindi"'));
  const telugu = lines.find((l) => l.includes('NAME="Telugu"'));
  assert.match(hindi, /DEFAULT=YES/);
  assert.match(telugu, /DEFAULT=NO/);
});

test('(b) language Hindi on a Telugu+Tamil donor: 409 naming Hindi', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('plb', [['Telugu', 'tel', 'tel.m3u8'], ['Tamil', 'tam', 'tam.m3u8']]);
  const res = await postPair(app, body({ language: 'Hindi' }));
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, 'not pairable');
  assert.match(res.body.reason, /no Hindi audio/);
  assert.equal(res.body.reason, 'the audio source has no Hindi audio track');
  assert.equal(res.body.audioRenditions, 2);
});

test('(c) language code te matches a LANGUAGE="tel" rendition', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('plc', [['Hindi', 'hin', 'hin.m3u8'], ['Track 2', 'tel', 'tel.m3u8']]);
  const res = await postPair(app, body({ language: 'te' }));
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const { job } = jobOf(res);
  // Telugu is also the no-language default, so the canonical language on the
  // plan is what proves 'te' was matched rather than ignored.
  assert.equal(job.plan.language, 'Telugu');
  const tel = mediaLines(job.playlist).find((l) => l.includes('LANGUAGE="tel"'));
  assert.match(tel, /DEFAULT=YES/);
});

test('(d) no language: Telugu default and the planId is unchanged', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('pld', [['Hindi', 'hin', 'hin.m3u8'], ['Telugu', 'tel', 'tel.m3u8']]);
  const res = await postPair(app, body());
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const { id, job } = jobOf(res);
  const tel = mediaLines(job.playlist).find((l) => l.includes('NAME="Telugu"'));
  assert.match(tel, /DEFAULT=YES/);
  // The pre-Step-2 hash: video|audio|nudge, nothing appended.
  const crypto = require('crypto');
  const legacy = crypto.createHash('sha1')
    .update(`${job.plan.video.stream.url}|${job.plan.audio.stream.url}|0`)
    .digest('hex').slice(0, 24);
  assert.equal(id, legacy);
});

test('(e) same urls, two languages: different planId', () => {
  const base = { video: { stream: { url: 'https://v/x' } }, audio: { stream: { url: 'https://a/y' } } };
  const te = h.planId({ ...base, language: 'Telugu' });
  const hi = h.planId({ ...base, language: 'Hindi' });
  const none = h.planId(base);
  assert.notEqual(te, hi);
  assert.notEqual(te, none);
});

test('defaultAudioIndex takes an explicit language and keeps the Telugu default', () => {
  const r = [{ name: 'Telugu', language: 'tel' }, { name: 'Hindi', language: 'hin' }];
  assert.equal(h.defaultAudioIndex(r), 0);
  assert.equal(h.defaultAudioIndex(r, 'Hindi'), 1);
  assert.equal(h.defaultAudioIndex(r, 'hi'), 1);
});

test('an asked language also matches a parsed track name; the default does not', () => {
  const r = [{ name: 'Tamil', language: 'tam' }, { name: 'Hindi AAC 2.0', language: 'und' }];
  assert.equal(h.defaultAudioIndex(r, 'Hindi'), 1);
  assert.equal(h.languageRenditionIndex(r, 'Hindi'), -1, 'exact-only without byTrackName');
  const t = [{ name: 'Hindi', language: 'hin' }, { name: 'Telugu 5.1', language: '' }];
  assert.equal(h.defaultAudioIndex(t), 0, 'no-language default unchanged');
});

// Fix round 1: the LANGUAGE tag beats the name; the name counts only when the
// tag is empty, und or not a language (Step 1 rule, web languageSources.js).
test('asked language: a real tag beats a contradicting name', () => {
  assert.equal(h.defaultAudioIndex([{ name: 'Hindi', language: 'tel' }, { name: 'Track 2', language: 'hin' }], 'Hindi'), 1);
  assert.equal(h.languageRenditionIndex([{ name: 'Hindi', language: 'tel' }, { name: 'Track 2', language: 'hin' }], 'Hindi', { byTrackName: true }), 1);
});

test('asked language: a Telugu-tagged track named Hindi is not Hindi', () => {
  assert.equal(h.languageRenditionIndex([{ name: 'Hindi', language: 'tel' }], 'Hindi', { byTrackName: true }), -1);
});

test('asked language: a 409 when the only Hindi-named track is tagged Telugu', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('plf', [['Hindi', 'tel', 'tel.m3u8']]);
  const res = await postPair(app, body({ language: 'Hindi' }));
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'the audio source has no Hindi audio track');
});

test('asked language: an und-tagged track named Hindi AAC 2.0 still matches', () => {
  assert.equal(h.languageRenditionIndex([{ name: 'Tamil', language: 'tam' }, { name: 'Hindi AAC 2.0', language: 'und' }], 'Hindi', { byTrackName: true }), 1);
  assert.equal(h.languageRenditionIndex([{ name: 'Hindi AAC 2.0', language: 'xyz' }], 'Hindi', { byTrackName: true }), 0);
});

test('asked non-language: fixed 409 reason, the value is not echoed', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('plg', [['Telugu', 'tel', 'tel.m3u8']]);
  const res = await postPair(app, body({ language: 'xyz<script>' }));
  assert.equal(res.code, 409, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'the audio source has no audio track in the asked language');
});

// Fix wave I3 (2026-11-21): every language a client can offer must resolve.
// Clients send the display name (web languageName, APK JVM display name:
// "Bangla" on JDK 17) and donors tag renditions with any ISO 639-1/639-2 code.
test('asked language: Marathi "mr" with a generic name matches', () => {
  assert.equal(h.languageRenditionIndex([{ name: 'Audio 1', language: 'te' }, { name: 'Audio 2', language: 'mr' }], 'Marathi', { byTrackName: true }), 1);
  assert.equal(h.languageRenditionIndex([{ name: 'Audio 2', language: 'mr' }], 'mr', { byTrackName: true }), 0);
});

test('asked language: Bengali "bn" matches Bengali and Bangla', () => {
  const r = [{ name: 'Track 1', language: 'bn' }];
  assert.equal(h.languageRenditionIndex(r, 'Bengali', { byTrackName: true }), 0);
  assert.equal(h.languageRenditionIndex(r, 'Bangla', { byTrackName: true }), 0);
  assert.equal(h.languageRenditionIndex([{ name: 'Track 1', language: 'ben' }], 'Bangla', { byTrackName: true }), 0);
});

test('asked language: Spanish "es" named Español matches', () => {
  assert.equal(h.languageRenditionIndex([{ name: 'Español', language: 'es' }], 'Spanish', { byTrackName: true }), 0);
  assert.equal(h.languageRenditionIndex([{ name: 'Español', language: 'spa' }], 'es', { byTrackName: true }), 0);
});

test('asked language: Bhojpuri "bho" by tag, and by name when the tag is und', () => {
  assert.equal(h.languageRenditionIndex([{ name: 'Audio 1', language: 'hi' }, { name: 'Audio 2', language: 'bho' }], 'Bhojpuri', { byTrackName: true }), 1);
  assert.equal(h.languageRenditionIndex([{ name: 'Bhojpuri', language: 'und' }], 'Bhojpuri', { byTrackName: true }), 0);
  assert.equal(h.languageRenditionIndex([{ name: 'Bhojpuri', language: 'und' }], 'BHO', { byTrackName: true }), 0);
});

test('asked language: the tag still beats the name for a wider language set', () => {
  assert.equal(h.languageRenditionIndex([{ name: 'Marathi', language: 'hi' }], 'Marathi', { byTrackName: true }), -1);
  assert.equal(h.languageRenditionIndex([{ name: 'Audio', language: 'tel-hin' }], 'Telugu', { byTrackName: true }), -1);
  assert.equal(h.languageRenditionIndex([{ name: 'AAC', language: 'und' }], 'aac', { byTrackName: true }), -1);
});

test('asked language: Telugu "te" is still index 0', () => {
  const r = [{ name: 'Audio 1', language: 'te' }, { name: 'Audio 2', language: 'mr' }];
  assert.equal(h.languageRenditionIndex(r, 'Telugu', { byTrackName: true }), 0);
  assert.equal(h.defaultAudioIndex(r, 'Telugu'), 0);
  assert.equal(h.defaultAudioIndex(r), 0, 'no-language default unchanged');
  assert.equal(h.defaultAudioIndex(r, 'Marathi'), 1);
});

test('POST /hybrid/pair with Marathi resolves an "mr" rendition named Audio 2', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('plmr', [['Audio 1', 'te', 'te.m3u8'], ['Audio 2', 'mr', 'mr.m3u8']]);
  const res = await postPair(app, body({ language: 'Marathi' }));
  assert.equal(res.code, 200, JSON.stringify(res.body));
});

test('POST /hybrid/pair with Bangla resolves a "bn" rendition', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  const { app, body } = setup('plbn', [['Track 1', 'bn', 'bn.m3u8']]);
  const res = await postPair(app, body({ language: 'Bangla' }));
  assert.equal(res.code, 200, JSON.stringify(res.body));
});

test('every name a client can offer resolves (web NAMES table, JDK Locale names)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../web/lib/subtitles.js'), 'utf8');
  const names = [...src.match(/const NAMES = \{([\s\S]*?)\};/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length > 40);
  const jdk = ['Bangla', 'Bihari', 'Odia', 'Oriya', 'Fulah', 'Maori', 'Moldavian', 'Tagalog', 'Norwegian Bokmål', 'Bhojpuri'];
  assert.deepEqual([...names, ...jdk].filter((n) => h.languageDisplayName(n) == null), []);
});
