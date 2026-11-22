'use strict';
// MultiMovies dash-direct (P21, 2026-11-22): sacdn index.mpd -> VM HLS
// playlists. Fixtures: the KGF 2 Telugu source's real MPD (SegmentTimeline,
// 3 hev1 video reps + tel audio, captured 2026-11-22, no signature inside)
// and its rep-0 init segment; the Salaar MPD (fixed @duration template).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');

const FIX = path.join(__dirname, 'fixtures', 'multimovies');
const KGF_MPD = fs.readFileSync(path.join(FIX, 'kgf2-68264836194533344-index.mpd'), 'utf8');
const KGF_INIT0 = fs.readFileSync(path.join(FIX, 'kgf2-init-stream0.m4s'));
const SALAAR_MPD = fs.readFileSync(path.join(FIX, 'salaar-7844085959171131184-index.mpd'), 'utf8');

// A CloudFront custom policy in the URL-safe encoding sacdn uses.
function policy(expSec) {
    const json = JSON.stringify({ Statement: [{ Resource: 'https://sacdn.hakunaymatata.com/dash/68264836194533344_0_0_1080_h265_168/*',
        Condition: { DateLessThan: { 'AWS:EpochTime': expSec } } }] });
    return Buffer.from(json).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
}
const FOLDER = 'https://sacdn.hakunaymatata.com/dash/68264836194533344_0_0_1080_h265_168/';
function signedMpd(expSec) {
    return `${FOLDER}index.mpd?Policy=${encodeURIComponent(policy(expSec))}&Signature=SIG~abc&Key-Pair-Id=KPID`;
}
const query = (u) => u.split('?')[1];

test('converter KGF 2: 1,660 segments per video rep and 1,987 audio, signed query on every line, EXT-X-MAP', () => {
    const { parseMpd, mediaPlaylist } = require('../lib/media/mpdHls');
    const p = parseMpd(KGF_MPD);
    assert.deepEqual(p.reps.map((r) => `${r.kind}:${r.id}:${r.segments.length}`),
        ['video:0:1660', 'video:1:1660', 'video:2:1660', 'audio:3:1987']);
    assert.equal(p.reps[3].lang, 'tel');
    assert.equal(p.reps[3].channels, '2');
    const q = query(signedMpd(2000000000));
    const text = mediaPlaylist(p.reps[0], FOLDER, q);
    const lines = text.trim().split('\n');
    const uris = lines.filter((l) => l && !l.startsWith('#'));
    assert.equal(uris.length, 1660);
    assert.equal(lines.filter((l) => l.startsWith('#EXTINF:')).length, 1660);
    assert.ok(uris.every((u) => u.startsWith(FOLDER) && u.endsWith(`?${q}`)), 'every segment absolute on sacdn and signed');
    assert.equal(uris[0], `${FOLDER}chunk-stream0-00001.m4s?${q}`);
    assert.equal(uris[1659], `${FOLDER}chunk-stream0-01660.m4s?${q}`);
    assert.ok(lines.includes(`#EXT-X-MAP:URI="${FOLDER}init-stream0.m4s?${q}"`));
    assert.ok(lines.includes('#EXT-X-ENDLIST'));
    const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)[1]);
    const durs = lines.filter((l) => l.startsWith('#EXTINF:')).map((l) => Number(l.slice(8, -1)));
    assert.ok(durs.every((d) => Math.round(d) <= target), `target ${target}`);
    // PT2H45M57.2S = 9957.2 s.
    assert.ok(Math.abs(durs.reduce((a, b) => a + b, 0) - 9957.2) < 1, String(durs.reduce((a, b) => a + b, 0)));
    // Byte size as measured by conv.py: about 1.2 MB, gzip about 11 KB.
    assert.ok(zlib.gzipSync(text).length < 20000, String(zlib.gzipSync(text).length));
});

test('converter Salaar: fixed @duration template gives ceil(10444.2/5) = 2,089 segments, last one 4.2 s', () => {
    const { parseMpd, mediaPlaylist } = require('../lib/media/mpdHls');
    const p = parseMpd(SALAAR_MPD);
    assert.deepEqual(p.reps.map((r) => r.segments.length), [2089, 2089, 2089, 2089]);
    const last = p.reps[0].segments[2088];
    assert.equal(last.uri, 'chunk-stream0-02089.m4s');
    assert.ok(Math.abs(last.dur - 4.2) < 1e-6, String(last.dur));
    assert.match(mediaPlaylist(p.reps[3], FOLDER, 'a=1'), /#EXT-X-MAP:URI="[^"]+init-stream3\.m4s\?a=1"/);
});

test('converter master: LANGUAGE from the MPD lang (tel -> te), und gives none, full CODECS only when known', () => {
    const { parseMpd, masterPlaylist, hlsLanguage } = require('../lib/media/mpdHls');
    const url = (r) => `https://vm.test/mm/hls/1/${r.id}.m3u8`;
    const p = parseMpd(KGF_MPD);
    const withCodecs = masterPlaylist(p, url, { videoCodecs: { 0: 'hev1.1.6.L150.90', 1: 'hev1.1.6.L120.90', 2: 'hev1.1.6.L93.90' } });
    assert.match(withCodecs, /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="te",NAME="Telugu",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="https:\/\/vm\.test\/mm\/hls\/1\/3\.m3u8"/);
    assert.match(withCodecs, /#EXT-X-STREAM-INF:BANDWIDTH=2328000,RESOLUTION=2542x1080,CODECS="hev1\.1\.6\.L150\.90,mp4a\.40\.2",FRAME-RATE=24\.000,AUDIO="audio"\nhttps:\/\/vm\.test\/mm\/hls\/1\/0\.m3u8/);
    assert.equal((withCodecs.match(/#EXT-X-STREAM-INF/g) || []).length, 3);
    // A bare "hev1" fails MediaSource.isTypeSupported in Chrome: no CODECS at all.
    const noCodecs = masterPlaylist(p, url, { videoCodecs: { 0: 'hev1.1.6.L150.90' } });
    assert.ok(!/CODECS=/.test(noCodecs), noCodecs);
    const und = masterPlaylist(parseMpd(KGF_MPD.replace('lang="tel"', 'lang="und"')), url);
    assert.ok(!/LANGUAGE=/.test(und));
    assert.match(und, /NAME="Audio"/);
    const plan = masterPlaylist(p, url, { language: { code: null, name: 'Audio' } });
    assert.ok(!/LANGUAGE=/.test(plan), 'the plan may withhold the tag (unverified)');
    assert.deepEqual(['tel', 'tam', 'kan', 'hin', 'mal', 'eng', 'und', 'te', ''].map(hlsLanguage),
        ['te', 'ta', 'kn', 'hi', 'ml', 'en', null, 'te', null]);
});

test('init segment hvcC -> hev1.1.6.L150.90 (KGF 2 rep 0)', () => {
    const { codecFromInit } = require('../utils/hybridStream');
    assert.equal(codecFromInit(KGF_INIT0), 'hev1.1.6.L150.90');
});

test('expiry cap: the MPD cache lives 30 min, or less when the signed URL expires sooner; e= carries the expiry', (t) => {
    const mm = require('../lib/media/mmDash');
    const { urlExpiresAt } = require('../lib/urlExpiry');
    const now = 1_800_000_000_000;
    const saved = mm._deps.now;
    mm._deps.now = () => now;
    t.after(() => { mm._deps.now = saved; mm._clear(); });
    mm._clear();
    const far = signedMpd(now / 1000 + 3 * 3600);
    const near = signedMpd(now / 1000 + 10 * 60);
    const gone = signedMpd(now / 1000 + 30);
    mm.rememberMpd(far, KGF_MPD);
    mm.rememberMpd(near, KGF_MPD);
    mm.rememberMpd(gone, KGF_MPD);
    assert.equal(mm._cached(far).until, now + 30 * 60 * 1000);
    assert.equal(mm._cached(near).until, now + 10 * 60 * 1000 - 60 * 1000);
    assert.equal(mm._cached(gone), null, 'inside the 60 s skew: not cached');
    const vm = mm.masterUrlFor('https://vm.test', near, 'Telugu');
    assert.match(vm, /^https:\/\/vm\.test\/mm\/hls\/68264836194533344\/master\.m3u8\?s=[\w-]+&e=\d+&l=Telugu$/);
    assert.equal(urlExpiresAt(vm, now), now + 10 * 60 * 1000, 'urlExpiry caps the /api/streams cache by e=');
    assert.ok(!vm.includes('SIG~abc'), 'the signature is not in the URL as plain text');
    assert.equal(mm.parseMpdUrl(`${FOLDER}index.mpd?Policy=x`), null, 'unsigned');
    assert.equal(mm.parseMpdUrl('https://evil.test/dash/1_a/index.mpd?Policy=a&Signature=b&Key-Pair-Id=c'), null, 'other host');
});

async function serve(t) {
    const express = require('express');
    const compression = require('compression');
    const { compressFilter } = require('../proxy/playlistCompression');
    const mm = require('../lib/media/mmDash');
    const app = express();
    app.use(compression({ filter: compressFilter(compression) }));
    mm.registerMmDashRoutes(app);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const calls = [];
    const savedFetch = mm._deps.fetch;
    mm._deps.fetch = async (u) => {
        calls.push(String(u));
        if (/index\.mpd/.test(u)) return new Response(KGF_MPD, { status: 200 });
        if (/init-stream\d\.m4s/.test(u)) return new Response(KGF_INIT0, { status: 200 });
        return new Response('', { status: 404 });
    };
    const lines = [];
    t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
    t.after(() => { mm._deps.fetch = savedFetch; mm._clear(); server.close(); });
    mm._clear();
    return { base, calls, lines, mm };
}

function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get(url, { headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let body = Buffer.concat(chunks);
                if (res.headers['content-encoding'] === 'gzip') body = zlib.gunzipSync(body);
                resolve({ status: res.statusCode, headers: res.headers, body: body.toString('utf8'), raw: Buffer.concat(chunks).length });
            });
        }).on('error', reject);
    });
}

test('route: gzipped master with LANGUAGE te and the init-derived CODECS; media playlist signed on sacdn; 1 MPD GET', async (t) => {
    const { base, calls, lines, mm } = await serve(t);
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const masterUrl = mm.masterUrlFor(base, signedMpd(exp), 'Telugu');
    const m = await get(masterUrl, { 'accept-encoding': 'gzip' });
    assert.equal(m.status, 200);
    assert.equal(m.headers['content-encoding'], 'gzip');
    assert.match(m.headers['content-type'], /application\/vnd\.apple\.mpegurl/);
    assert.match(m.body, /LANGUAGE="te",NAME="Telugu",DEFAULT=YES/);
    assert.match(m.body, /CODECS="hev1\.1\.6\.L150\.90,mp4a\.40\.2"/);
    const audioUri = /URI="([^"]+)"/.exec(m.body)[1];
    assert.ok(audioUri.startsWith(`${base}/mm/hls/68264836194533344/3.m3u8?s=`), audioUri);
    const a = await get(audioUri, { 'accept-encoding': 'gzip' });
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-encoding'], 'gzip');
    const segs = a.body.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(segs.length, 1987);
    assert.ok(segs.every((s) => s.startsWith(FOLDER) && s.includes('Signature=SIG~abc')), 'direct sacdn, signed');
    assert.ok(a.raw < 30000, `gzip ${a.raw} B`);
    const v = await get(m.body.split('\n').find((l) => l.startsWith(`${base}/mm/hls/68264836194533344/2.m3u8`)));
    assert.equal(v.status, 200);
    assert.match(v.body, /#EXT-X-MAP:URI="https:\/\/sacdn\.hakunaymatata\.com\/dash\/[^"]+init-stream2\.m4s\?Policy=/);
    assert.equal(calls.filter((u) => /index\.mpd/.test(u)).length, 1, 'MPD fetched once, then cached');
    assert.equal(calls.filter((u) => /init-stream/.test(u)).length, 3, 'one init per video rep, once');
    assert.ok(lines.some((l) => /^\[mm-dash\] master 68264836194533344 video=3 audio=tel lang=te codecs=hev1\.1\.6\.L150\.90/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('SIG~abc'), 'no signature in logs');
});

test('route: l=- withholds LANGUAGE; bad, foreign or expired sources are refused without a fetch', async (t) => {
    const { base, calls, mm } = await serve(t);
    const exp = Math.floor(Date.now() / 1000) + 7200;
    const unverified = await get(mm.masterUrlFor(base, signedMpd(exp), '-'));
    assert.equal(unverified.status, 200);
    assert.ok(!/LANGUAGE=/.test(unverified.body));
    const n = calls.length;
    assert.equal((await get(`${base}/mm/hls/68264836194533344/master.m3u8?s=bm9wZQ`)).status, 400);
    const foreign = Buffer.from('https://evil.test/dash/68264836194533344_x/index.mpd?Policy=a&Signature=b&Key-Pair-Id=c').toString('base64url');
    assert.equal((await get(`${base}/mm/hls/68264836194533344/master.m3u8?s=${foreign}`)).status, 400);
    const wrongId = mm.masterUrlFor(base, signedMpd(exp), 'Telugu').replace('/68264836194533344/', '/123/');
    assert.equal((await get(wrongId)).status, 400);
    const expired = mm.masterUrlFor(base, signedMpd(Math.floor(Date.now() / 1000) - 10), 'Telugu');
    assert.equal((await get(expired)).status, 410);
    assert.equal(calls.length, n, 'no upstream fetch for a refused source');
});
