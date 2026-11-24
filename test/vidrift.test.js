'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vidrift = require('../providers/vidrift');
const { normaliseStream } = require('../utils/streamSchema');
const { routeFor } = require('../lib/routing/providerRoutes');

// Recorded 2026-11-21 (redacted: playbackToken, warmManifests). RRR's page
// lists four Orion masters: Original, Hindi, Telugu, Bangla. Krack's lists none
// (orionStreams null at 18:53; the same page had two masters at 19:21).
const FX = path.join(__dirname, 'fixtures', 'vidrift');
const read = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const RRR_PAGE = read('rrr-page.html');
const KRACK_PAGE = read('krack-page.html');
const MASTER_TE = read('master-telugu.m3u8');
const MASTER_ORIG = read('master-original.m3u8');
const MASTER_NO_AUDIO = read('master-no-audio.m3u8');
const BASE = 'https://embed.vidrift.net';
const MURL = `${BASE}/api/orion/a/master.m3u8`;

const realFetch = global.fetch;
const realDeps = { ...vidrift._deps };
const realConfig = { ...vidrift._config };
afterEach(() => {
    global.fetch = realFetch;
    Object.assign(vidrift._deps, realDeps);
    Object.assign(vidrift._config, realConfig);
});

function text(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => body, body: null };
}

// routes: [predicate(url), handler(url, init)] in order; unknown urls 404.
// originalLanguage: what TMDB says (default 'te', RRR and Krack).
function stubFetch(routes, { calls = [], originalLanguage = 'te' } = {}) {
    global.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, headers: init.headers || {} });
        for (const [match, h] of routes) if (match(u)) return h(u, init);
        return text('nope', 404);
    };
    // The page goes through axios in the provider; route it through the stub.
    vidrift._deps.getPage = async (url, headers, signal) => {
        const r = await global.fetch(url, { headers, signal });
        return { status: r.status, text: await r.text() };
    };
    vidrift._deps.originalLanguage = async () => originalLanguage;
    return calls;
}

const isPage = (host) => (u) => u.startsWith(`https://${host}/embed/`);
const isMaster = (u) => /\/api\/orion\/[0-9a-f]+\/master\.m3u8$/.test(u);
const neverAnswers = (u, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
});

test('RRR: one row per language master; Original stays unlabelled because the page has its own Telugu row', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.languages), [[], ['Hindi'], ['Telugu'], ['Bengali']]);
    assert.match(rows[0].title, /Original/);
    assert.equal(rows.upstreamError, undefined);
    for (const r of rows) {
        assert.equal(r.provider, 'vidrift');
        assert.match(r.url, /^https:\/\/embed\.vidrift\.net\/api\/orion\/[0-9a-f]{32}\/master\.m3u8$/);
    }
});

test('Original with TMDB language unknown stays "Original": no language guessed (page lang ignored)', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]],
        { originalLanguage: null });
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    const orig = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
    const n = normaliseStream(orig);
    assert.deepEqual(n.languages, []);
    assert.match(orig.title, /Original/);
    assert.ok(!n.audio.some((a) => a.language === 'Telugu'));
});

test('Telugu row: labelled Telugu after normalise, audio tagged, own Referer/Origin', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    const te = rows.find((r) => r.url.includes('4160f9215437e11c789d19d826048e8b'));
    const n = normaliseStream(te);
    assert.deepEqual(n.languages, ['Telugu']);
    assert.deepEqual(n.audio.map((a) => a.language), ['Telugu']);
    assert.equal(n.selectableAudio, true);
    assert.equal(n.quality, '1080p');
    assert.equal(te.headers.Referer, `${BASE}/`);
    assert.equal(te.headers.Origin, BASE);
});

test('master fetch carries the host Referer/Origin (Telugu master 403s without)', async () => {
    const calls = stubFetch([
        [isPage('embed.vidrift.net'), () => text(RRR_PAGE)],
        [isMaster, (u, init) => (init.headers.Origin === BASE ? text(MASTER_TE) : text('Forbidden', 403))],
    ]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(rows.length, 4);
    assert.equal(calls.filter((c) => isMaster(c.url)).length, 4);
});

test('HEVC: videoCodec hevc from CODECS, and from the url when CODECS is absent', () => {
    const entry = { name: 'Orion · Telugu' };
    const row = vidrift.streamFromMaster(entry, MASTER_TE, MURL, BASE, null);
    assert.equal(row.videoCodec, 'hevc');
    assert.equal(normaliseStream(row).videoCodec, 'hevc');
    const noCodecs = MASTER_TE.replace(/,CODECS="[^"]*"/g, '');
    assert.equal(vidrift.streamFromMaster(entry, noCodecs, 'https://x.example/dash/1_1080_h265_9/master.m3u8', BASE, null).videoCodec, 'hevc');
    assert.equal(vidrift.streamFromMaster(entry, MASTER_NO_AUDIO, MURL, BASE, null).videoCodec, 'avc');
});

test('master with no AUDIO line: page language kept on the row, audio not selectable', () => {
    const n = normaliseStream(vidrift.streamFromMaster({ name: 'Orion · Telugu' }, MASTER_NO_AUDIO, MURL, BASE, null));
    assert.deepEqual(n.languages, ['Telugu']);
    assert.deepEqual(n.audio, []);
    assert.equal(n.selectableAudio, false);
});

test('a single rendition that states a different LANGUAGE wins over the page', () => {
    const tagged = MASTER_TE.replace('NAME="Audio"', 'NAME="Audio",LANGUAGE="hin"');
    const n = normaliseStream(vidrift.streamFromMaster({ name: 'Orion · Telugu' }, tagged, MURL, BASE, null));
    assert.deepEqual(n.languages, ['Hindi']);
});

test('two AUDIO renditions: each keeps what the master states, page language not stamped', () => {
    const two = MASTER_TE.replace('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="a3.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio 1",LANGUAGE="tel",DEFAULT=YES,URI="a3.m3u8"\n'
        + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio 2",LANGUAGE="hin",URI="a4.m3u8"');
    const n = normaliseStream(vidrift.streamFromMaster({ name: 'Orion · Telugu' }, two, MURL, BASE, null));
    assert.deepEqual(n.audio.map((a) => a.language), ['Telugu', 'Hindi']);
    const untagged = two.replace(',LANGUAGE="tel"', '').replace(',LANGUAGE="hin"', '');
    const u = normaliseStream(vidrift.streamFromMaster({ name: 'Orion · Telugu' }, untagged, MURL, BASE, null));
    assert.ok(!u.audio.some((a) => a.language === 'Telugu'), 'no Telugu stamped on two untagged renditions');
    assert.equal(u.audio.length, 2, 'renditions kept');
});

test('dead first host: the mirror answers, rows carry the mirror host and its headers', async () => {
    stubFetch([
        [isPage('embed.vidrift.net'), () => { throw new TypeError('fetch failed'); }],
        [isPage('embed.vidrift.in'), () => text(RRR_PAGE)],
        [isMaster, () => text(MASTER_TE)],
    ]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(rows.length, 4);
    for (const r of rows) {
        assert.match(r.url, /^https:\/\/embed\.vidrift\.in\//);
        assert.equal(r.headers.Origin, 'https://embed.vidrift.in');
    }
});

test('every host dead: throws (an error, not "no streams")', async () => {
    stubFetch([[(u) => u.includes('/embed/movie/'), () => text('bad gateway', 502)]]);
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'), /vidrift/);
});

test('a page with no embedMeta is a broken host, not an empty title', async () => {
    stubFetch([
        [isPage('embed.vidrift.net'), () => text('<html><body>Just a moment...</body></html>')],
        [isPage('embed.vidrift.in'), () => text('<html></html>')],
    ]);
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'), /no embedMeta/);
});

test('Krack page with orionStreams null on every host: notListed empty, no masters fetched', async () => {
    const calls = stubFetch([[(u) => u.includes('/embed/movie/'), () => text(KRACK_PAGE)]]);
    const rows = await vidrift.getVidriftStreams('784572', 'movie');
    assert.deepEqual([...rows], []);
    assert.equal(rows.notListed, true);
    assert.equal(calls.filter((c) => isMaster(c.url)).length, 0);
});

test('orionStreams [] (page says no masters): empty, no error', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(KRACK_PAGE.replace('"orionStreams":null', '"orionStreams":[]'))]]);
    assert.deepEqual(await vidrift.getVidriftStreams('784572', 'movie'), []);
});

test('a dead master on both hosts: row dropped, upstreamError set (no full-hit cache)', async () => {
    stubFetch([
        [isPage('embed.vidrift.net'), () => text(RRR_PAGE)],
        [(u) => u.includes('4160f9215437e11c789d19d826048e8b'), () => text('Forbidden', 403)],
        [isMaster, () => text(MASTER_TE)],
    ]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    // The page still names Telugu, so Original stays unlabelled even though
    // the Telugu master died: unknown, never a guessed Telugu.
    assert.deepEqual(rows.map((r) => r.languages[0]), [undefined, 'Hindi', 'Bengali']);
    assert.match(rows.upstreamError || '', /Orion · Telugu/);
});

test('a master dead on .net is retried on the mirror with the mirror headers', async () => {
    stubFetch([
        [isPage('embed.vidrift.net'), () => text(RRR_PAGE)],
        [(u) => u.startsWith('https://embed.vidrift.net/') && u.includes('4160f9215437e11c789d19d826048e8b'), () => text('Forbidden', 403)],
        [isMaster, (u, init) => text(MASTER_TE)],
    ]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    const te = rows.find((r) => r.url.includes('4160f9215437e11c789d19d826048e8b'));
    assert.match(te.url, /^https:\/\/embed\.vidrift\.in\//);
    assert.equal(te.headers.Origin, 'https://embed.vidrift.in');
    assert.equal(rows.length, 4);
    assert.equal(rows.upstreamError, undefined);
});

test('page OK but every master dead: throws, not an empty', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text('Forbidden', 403)]]);
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'), /every master failed/);
});

test('hard total budget: a hung .net page cannot push the call past the budget', async () => {
    vidrift._config.budgetMs = 300;
    vidrift._config.pageTimeoutMs = 5000;
    vidrift._config.masterTimeoutMs = 5000;
    stubFetch([[isPage('embed.vidrift.net'), neverAnswers], [isPage('embed.vidrift.in'), neverAnswers]]);
    const t0 = Date.now();
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'));
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

test('a hung .net page leaves budget for the mirror', async () => {
    vidrift._config.budgetMs = 2000;
    vidrift._config.pageTimeoutMs = 200;
    stubFetch([
        [isPage('embed.vidrift.net'), neverAnswers],
        [isPage('embed.vidrift.in'), () => text(RRR_PAGE)],
        [isMaster, () => text(MASTER_TE)],
    ]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(rows.length, 4);
});

test('default budget sits under the 20 s registry deadline', () => {
    const { PROVIDER_DEADLINE_MS } = require('../providers/registry');
    assert.ok(vidrift._config.budgetMs < PROVIDER_DEADLINE_MS);
});

test('TV with no season/episode: no rows, no request (never S1E1)', async () => {
    const calls = stubFetch([[() => true, () => text(RRR_PAGE)]]);
    assert.deepEqual(await vidrift.getVidriftStreams('1396', 'tv', null, null), []);
    assert.equal(calls.length, 0);
});

test('quality: 21:9 2592x1080 is 1080p, letterboxed 1920x800 is 1080p', () => {
    const wide = MASTER_TE.replace('RESOLUTION=2050x1080', 'RESOLUTION=2592x1080');
    assert.equal(vidrift.streamFromMaster({ name: 'Orion · Hindi' }, wide, 'https://h/m.m3u8', 'https://h', null).quality, '1080p');
    const lb = MASTER_TE.replace('RESOLUTION=2050x1080', 'RESOLUTION=1920x800');
    assert.equal(vidrift.streamFromMaster({ name: 'Orion · Hindi' }, lb, 'https://h/m.m3u8', 'https://h', null).quality, '1080p');
});

test('"Original" streamFromMaster without TMDB language: title keeps Original, no language', () => {
    const row = vidrift.streamFromMaster({ name: 'Orion · Original' }, MASTER_ORIG, MURL, BASE, null);
    assert.deepEqual(normaliseStream(row).languages, []);
    assert.match(row.name, /Original/);
});

// Round 2 N1: a hung TMDB call must not eat the budget and drop every row.
test('RRR: masters fetched, rows survive, Original unlabelled', async () => {
    vidrift._config.budgetMs = 800;
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    const t0 = Date.now();
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
    assert.equal(rows.length, 4);
    const orig = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
    assert.deepEqual(orig.languages, []);
    assert.match(orig.title, /Original/);
    assert.deepEqual(rows.find((r) => r.url.includes('4160f9215437e11c789d19d826048e8b')).languages, ['Telugu']);
});

test('a short budget (300 ms) still returns every row', async () => {
    vidrift._config.budgetMs = 300;
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    const t0 = Date.now();
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
    assert.equal(rows.length, 4);
});

test('no TMDB lookup: "Original" never waits on or asks TMDB', async () => {
    let asked = 0;
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    vidrift._deps.originalLanguage = async () => { asked += 1; return 'te'; };
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(asked, 0);
    assert.equal(vidrift._config.tmdbWaitMs, undefined);
    assert.deepEqual(rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b')).languages, []);
});

test('N4: an unknown TMDB code keeps "Original" (no title-cased guess)', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]],
        { originalLanguage: 'xx' });
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    const orig = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
    assert.deepEqual(orig.languages, []);
    assert.match(orig.title, /Original/);
});

test('subtitles: HLS playlist URLs are not emitted, real vtt is kept', () => {
    const withSubs = MASTER_TE.replace('#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="s_en.m3u8"\n'
        + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Telugu",LANGUAGE="te",URI="s_te.vtt"');
    const row = vidrift.streamFromMaster({ name: 'Orion · Telugu' }, withSubs, MURL, BASE, null);
    assert.deepEqual(row.subtitles.map((s) => s.url.replace(/^.*\//, '')), ['s_te.vtt']);
});

test('"Original" is never labelled from TMDB, whatever the code (te, ta, mr, pa, bn, xx)', async () => {
    for (const code of ['te', 'ta', 'mr', 'pa', 'bn', 'xx']) {
        stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]],
            { originalLanguage: code });
        const rows = await vidrift.getVidriftStreams('579974', 'movie');
        const orig = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
        assert.deepEqual(normaliseStream(orig).languages, [], code);
        assert.match(orig.title, /Original/, code);
    }
});

// Don't Trouble the Trouble (1261763, TMDB te), live 2026-11-21. Page lists
// Original, Hindi, Tamil, Telugu, Malayalam, Kannada. The Original audio is
// the Tamil track (owner heard Tamil; audio segments byte-identical to the
// Tamil row's), and prod labelled it Telugu: two "Telugu" rows on the web.
const DTTT_PAGE = read('dttt-page.html');
const DTTT_ORIG = '7986230982bb6809d7a2b9e62553bf96';
const DTTT_TE = '2fc41d4bd36ca36378d03459dba7791b';

test('1261763: Original is NOT labelled Telugu when the page has its own Telugu row; one Telugu row only', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(DTTT_PAGE)], [isMaster, () => text(MASTER_ORIG)]]);
    const rows = await vidrift.getVidriftStreams('1261763', 'movie');
    assert.equal(rows.length, 6);
    const n = rows.map(normaliseStream);
    assert.deepEqual(n.map((r) => r.languages), [[], ['Hindi'], ['Tamil'], ['Telugu'], ['Malayalam'], ['Kannada']]);
    const orig = rows.find((r) => r.url.includes(DTTT_ORIG));
    assert.match(orig.title, /Original/);
    assert.ok(!normaliseStream(orig).audio.some((a) => a.language), 'Original audio carries no language');
    assert.equal(n.filter((r) => r.languages.includes('Telugu')).length, 1);
    assert.ok(rows.find((r) => r.url.includes(DTTT_TE)).languages.includes('Telugu'));
});

test('teluguClaimWinner: index of the last Telugu entry when two or more say Telugu', () => {
    const names = (...l) => l.map((x) => ({ name: `Orion · ${x}` }));
    assert.equal(vidrift.teluguClaimWinner(names('Telugu', 'Hindi', 'Telugu')), 2);
    assert.equal(vidrift.teluguClaimWinner(names('Original', 'Hindi', 'Telugu')), null);
    assert.equal(vidrift.teluguClaimWinner(names('Telugu', 'Telugu Sub')), null);
    assert.equal(vidrift.teluguClaimWinner(names('Tamil', 'Tamil')), null, 'Telugu only');
});

test('1261763 without its Telugu entry: Original is still not Telugu', async () => {
    const page = DTTT_PAGE.replace(/\{"index":3,[^{}]*"name":"Orion · Telugu"[^{}]*"rungs":\[[^\]]*\][^{}]*\},/, '');
    assert.ok(!page.includes('Orion · Telugu'), 'fixture edit removed the Telugu entry');
    stubFetch([[isPage('embed.vidrift.net'), () => text(page)], [isMaster, () => text(MASTER_ORIG)]]);
    const rows = await vidrift.getVidriftStreams('1261763', 'movie');
    const orig = rows.find((r) => r.url.includes(DTTT_ORIG));
    assert.deepEqual(normaliseStream(orig).languages, []);
});

test('R1: knownLanguage covers 2- and 3-letter Indian codes', () => {
    const { knownLanguage } = require('../utils/streamSchema');
    const want = { bn: 'Bengali', ben: 'Bengali', mr: 'Marathi', mar: 'Marathi', pa: 'Punjabi', pan: 'Punjabi',
        gu: 'Gujarati', guj: 'Gujarati', or: 'Odia', ori: 'Odia', oriya: 'Odia', as: 'Assamese', asm: 'Assamese',
        ur: 'Urdu', urd: 'Urdu' };
    for (const [k, v] of Object.entries(want)) assert.equal(knownLanguage(k), v, k);
});

test('"<lang> sub/subs/subbed/subtitles" is never an audio language (multimovies and APK rule)', () => {
    for (const l of ['Telugu Sub', 'Telugu subs', 'Hindi Subbed', 'English subtitles', 'Tamil SUB']) {
        assert.deepEqual(vidrift.pageLanguage({ name: `Orion · ${l}` }, 'te'), { language: null, label: null }, l);
    }
    assert.equal(vidrift.pageLanguage({ name: 'Orion · Telugu' }, null).language, 'Telugu');
    assert.equal(vidrift.pageLanguage({ name: 'Orion · Bangla' }, null).language, 'Bengali');
    assert.equal(vidrift.pageLanguage({ name: 'Orion · Subramanian' }, null).language, 'Subramanian');
});

test('a muxed master under a "Telugu Sub" page label: row has no audio language', () => {
    const n = normaliseStream(vidrift.streamFromMaster({ name: 'Orion · Telugu Sub' }, MASTER_NO_AUDIO, MURL, BASE, 'te'));
    assert.ok(!(n.languages || []).includes('Telugu Sub'), JSON.stringify(n.languages));
    assert.ok(!(n.languages || []).includes('Telugu'), JSON.stringify(n.languages));
});

test('tv embed path', () => {
    assert.equal(vidrift.embedUrl(BASE, '1396', 'tv', 2, 3), `${BASE}/embed/tv/1396/2/3`);
    assert.equal(vidrift.embedUrl(BASE, '579974', 'movie'), `${BASE}/embed/movie/579974`);
});

test('bases list carries both hosts, .net first', () => {
    assert.deepEqual(vidrift.BASES.slice(-2), [BASE, 'https://embed.vidrift.in']);
});

test('route: web proxy, apk direct, on both hosts', () => {
    assert.deepEqual(routeFor('vidrift', `${BASE}/api/orion/a/master.m3u8`), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('vidrift', 'https://embed.vidrift.in/api/orion/a/master.m3u8'), { web: 'proxy', apk: 'direct' });
});

// Soak 1 (VM 2026-11-22 09:12:54Z): title 1496785 answered `orionStreams null`
// on .net and .in. The page and embedMeta parse fine, so the title has no
// rows; the host is fine. The error says so (titleEmpty) so the registry
// does not feed the host fail streak with it.
// 2026-11-24: /api/health showed vidrift down after 11 such answers. Every
// host saying null is now notListed (as vidout/insertunit, b5ab4e6): no error,
// so it never feeds the hub down streak or the breaker.
test('orionStreams null on every host: notListed, not an error', async () => {
    stubFetch([[(u) => u.includes('/embed/movie/'), () => text(KRACK_PAGE)]]);
    const rows = await vidrift.getVidriftStreams('1496785', 'movie');
    assert.equal(rows.length, 0);
    assert.equal(rows.notListed, true);
});

test('.net answers 502, .in answers orionStreams null: still titleEmpty (a host that answered says no rows)', async () => {
    stubFetch([
        [isPage('embed.vidrift.net'), () => text('bad gateway', 502)],
        [isPage('embed.vidrift.in'), () => text(KRACK_PAGE)],
    ]);
    await assert.rejects(vidrift.getVidriftStreams('1496785', 'movie'), (e) => e.titleEmpty === true);
});

test('dead hosts or a page without embedMeta: not titleEmpty (host fault)', async () => {
    stubFetch([[(u) => u.includes('/embed/movie/'), () => text('bad gateway', 502)]]);
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'), (e) => !e.titleEmpty);
    stubFetch([[(u) => u.includes('/embed/movie/'), () => text('<html></html>')]]);
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'), (e) => !e.titleEmpty);
    stubFetch([[(u) => u.includes('/embed/movie/'), () => text(KRACK_PAGE.replace('"orionStreams":null,', '').replace(',"orionStreams":null', ''))]]);
    await assert.rejects(vidrift.getVidriftStreams('579974', 'movie'), (e) => /orionStreams missing|no embedMeta/.test(e.message) && !e.titleEmpty);
});

// Live 2026-11-22 (telugu-label.md). Vidrift's page for RRR (579974, TMDB te)
// listed ONE entry, "Orion · Original". It was labelled Telugu from TMDB.
// Its audio segments are byte-identical to MultiMovies' "English" RRR source
// (cmp: 0 differing bytes of 666,405) and speech ID says ta/hi, not te; the
// phone played it as lang=und. Jailer (937020, TMDB ta): "Original" was
// labelled Tamil, but its audio is byte-identical to MovieBox's Malayalam
// source (speech ID ml 1.00). "Original" names no language: it stays Original.
test('live 11-22 RRR: a page with only "Orion · Original" is NOT Telugu (TMDB te ignored)', async () => {
    const page = RRR_PAGE.replace(/,\{"index":[123],[^{}]*"name":"Orion · (Hindi|Telugu|Bangla)","rungs":\[[^\]]*\][^{}]*\}/g, '');
    assert.ok(!/Orion · (Hindi|Telugu|Bangla)/.test(page), 'fixture edit left only Original');
    stubFetch([[isPage('embed.vidrift.net'), () => text(page)], [isMaster, () => text(MASTER_ORIG)]], { originalLanguage: 'te' });
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(rows.length, 1);
    const n = normaliseStream(rows[0]);
    assert.deepEqual(n.languages, []);
    assert.ok(!n.audio.some((a) => a.language), JSON.stringify(n.audio));
    assert.match(rows[0].title, /Original/);
});

test('live 11-22 Jailer: "Original" with TMDB ta is not labelled Tamil (it plays Malayalam)', () => {
    assert.deepEqual(vidrift.pageLanguage({ name: 'Orion · Original' }, 'ta'), { language: null, label: 'Original' });
    assert.deepEqual(vidrift.pageLanguage({ name: 'Orion · Original' }, 'te'), { language: null, label: 'Original' });
});

test('two page entries both say Telugu: only the last listed keeps Telugu; the other is unlabelled', async () => {
    const page = RRR_PAGE.replace('"name":"Orion · Original"', '"name":"Orion · Telugu"');
    stubFetch([[isPage('embed.vidrift.net'), () => text(page)], [isMaster, () => text(MASTER_ORIG)]]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    const n = rows.map(normaliseStream);
    assert.equal(n.filter((r) => r.languages.includes('Telugu')).length, 1, JSON.stringify(n.map((r) => r.languages)));
    const first = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
    const last = rows.find((r) => r.url.includes('4160f9215437e11c789d19d826048e8b'));
    assert.deepEqual(normaliseStream(first).languages, []);
    assert.match(first.title, /duplicate listing/);
    assert.doesNotMatch(`${first.name} ${first.title}`, /telugu/i);
    assert.deepEqual(normaliseStream(last).languages, ['Telugu']);
});

test('a master LANGUAGE tag still wins over a duplicate page label', () => {
    const tagged = MASTER_ORIG.replace(/(#EXT-X-MEDIA:TYPE=AUDIO[^\n]*?)NAME=/, '$1LANGUAGE="tel",NAME=');
    assert.ok(tagged.includes('LANGUAGE="tel"'), 'fixture edit tagged the rendition');
    const row = vidrift.streamFromMaster({ name: 'Orion · Telugu' }, tagged, MURL, BASE, { dropLabel: true });
    assert.deepEqual(normaliseStream(row).languages, ['Telugu']);
});
