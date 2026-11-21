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

test('RRR: one row per language master; Original takes TMDB original_language', async () => {
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.languages), [['Telugu'], ['Hindi'], ['Telugu'], ['Bengali']]);
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

test('Krack page with orionStreams null: transient error, not a cached empty', async () => {
    const calls = stubFetch([[(u) => u.includes('/embed/movie/'), () => text(KRACK_PAGE)]]);
    await assert.rejects(vidrift.getVidriftStreams('784572', 'movie'), /orionStreams/);
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
    assert.deepEqual(rows.map((r) => r.languages[0]), ['Telugu', 'Hindi', 'Bengali']);
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
test('TMDB hangs: masters still fetched, rows survive, Original unlabelled, wait capped', async () => {
    vidrift._config.budgetMs = 800;
    vidrift._config.tmdbWaitMs = 100;
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    vidrift._deps.originalLanguage = () => new Promise(() => {});
    const t0 = Date.now();
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
    assert.equal(rows.length, 4);
    const orig = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
    assert.deepEqual(orig.languages, []);
    assert.match(orig.title, /Original/);
    assert.deepEqual(rows.find((r) => r.url.includes('4160f9215437e11c789d19d826048e8b')).languages, ['Telugu']);
});

test('TMDB wait also ends with the budget (budget 300 ms < 2 s wait)', async () => {
    vidrift._config.budgetMs = 300;
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    vidrift._deps.originalLanguage = () => new Promise(() => {});
    const t0 = Date.now();
    const rows = await vidrift.getVidriftStreams('579974', 'movie');
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
    assert.equal(rows.length, 4);
});

test('default TMDB wait is 2 s', () => {
    assert.equal(vidrift._config.tmdbWaitMs, 2000);
});

test('N3: the TMDB wait timer is cleared once TMDB answers', async () => {
    vidrift._config.tmdbWaitMs = 60000;
    vidrift._config.budgetMs = 10 * 60000; // so the wait is exactly tmdbWaitMs
    stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]]);
    const realSet = global.setTimeout; const realClear = global.clearTimeout;
    const waits = new Set(); const cleared = new Set();
    global.setTimeout = (fn, ms, ...a) => { const h = realSet(fn, ms, ...a); if (ms === 60000) waits.add(h); return h; };
    global.clearTimeout = (h) => { cleared.add(h); return realClear(h); };
    try {
        await vidrift.getVidriftStreams('579974', 'movie');
    } finally {
        global.setTimeout = realSet; global.clearTimeout = realClear;
    }
    assert.equal(waits.size, 1, 'one capped TMDB wait');
    for (const h of waits) assert.ok(cleared.has(h), 'wait timer cleared');
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

test('R1: "Original" with TMDB bn / mr is Bengali / Marathi (not left as Original)', async () => {
    for (const [code, name] of [['bn', 'Bengali'], ['mr', 'Marathi']]) {
        stubFetch([[isPage('embed.vidrift.net'), () => text(RRR_PAGE)], [isMaster, () => text(MASTER_TE)]],
            { originalLanguage: code });
        const rows = await vidrift.getVidriftStreams('579974', 'movie');
        const orig = rows.find((r) => r.url.includes('36c0c00732d43d2df373f8c4e10e971b'));
        assert.deepEqual(normaliseStream(orig).languages, [name], code);
    }
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
