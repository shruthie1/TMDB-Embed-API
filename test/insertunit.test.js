'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const iu = require('../providers/insertunit');
const { normaliseStream } = require('../utils/streamSchema');
const { routeFor } = require('../lib/routing/providerRoutes');

// Recorded 2026-11-24 from the Mac (multimovies-servers.md), signatures
// stripped (?sig=REDACTED). RRR (tt8178634): 6 Russian dubs, tel6 te, hin7 hi,
// DEFAULT=YES on rus0, every rendition listed twice (audio0 and the failover
// group). Pushpa 2: page label "Original" is tagged hi, no Telugu at all.
const FX = path.join(__dirname, 'fixtures', 'insertunit');
const read = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const RRR_PAGE = read('rrr-page.html');
const P2_PAGE = read('pushpa2-page.html');
const TV_PAGE = read('tv-page.html');
const RRR_MASTER = read('rrr-master.m3u8');
const P2_MASTER = read('pushpa2-master.m3u8');
const MURL = 'https://hye1eaipby4w.interkh.com/08_07_22/08/07/03/A47E2JHN/5TE334TV.mp4/master.m3u8?sig=REDACTED';

const realDeps = { ...iu._deps };
afterEach(() => { Object.assign(iu._deps, realDeps); });

// 185.2 min of 10 s segments, like the real RRR variant.
function variant(minutes) {
    const n = Math.round((minutes * 60) / 10);
    return `#EXTM3U\n#EXT-X-TARGETDURATION:10\n${Array.from({ length: n }, (_, i) => `#EXTINF:10.000,\nseg-${i + 1}-v1.ts`).join('\n')}\n#EXT-X-ENDLIST\n`;
}

function stub({ page = RRR_PAGE, pageStatus = 200, master = RRR_MASTER, minutes = 185.2, runtime = 187, imdb = 'tt8178634', calls = [] } = {}) {
    iu._deps.imdbOf = async () => imdb;
    iu._deps.runtimeMinutes = async () => runtime;
    iu._deps.fetchText = async (url, headers) => {
        calls.push({ url, headers });
        if (url.startsWith('https://api.insertunit.ws/')) return { status: pageStatus, text: page };
        if (url.includes('/master.m3u8')) return { status: 200, text: master };
        if (url.includes('index-v')) return { status: 200, text: variant(minutes) };
        return { status: 404, text: '' };
    };
    return calls;
}

test('movie page: the hls literal is the master', () => {
    assert.equal(iu.masterFromPage(RRR_PAGE, 'movie'), MURL);
    assert.equal(iu.masterFromPage('<html>no player</html>', 'movie'), null);
});

test('tv page: the episode hls from the seasons playlist, null when absent', () => {
    const e2 = iu.masterFromPage(TV_PAGE, 'tv', 1, 2);
    assert.match(e2, /^https:\/\/[a-z0-9]+\.interkh\.com\/.+\/master\.m3u8\?sig=REDACTED$/);
    assert.notEqual(e2, iu.masterFromPage(TV_PAGE, 'tv', 1, 1));
    assert.equal(iu.masterFromPage(TV_PAGE, 'tv', 1, 99), null);
    assert.equal(iu.masterFromPage(TV_PAGE, 'tv', 9, 1), null);
});

test('embed url: movie by IMDb id; tv by IMDb id too (the page lists seasons)', () => {
    assert.equal(iu.embedUrl('tt8178634'), 'https://api.insertunit.ws/embed/imdb/tt8178634');
});

test('RRR master: one row, Telugu from LANGUAGE="te", every real language, no page label', () => {
    const row = iu.rowFromMaster(RRR_MASTER, MURL);
    assert.equal(row.provider, 'insertunit');
    assert.equal(row.container, 'hls');
    assert.equal(row.url, MURL);
    assert.deepStrictEqual(row.languages, ['Russian', 'Telugu', 'Hindi']);
    // One audio group only (the failover group repeats the same eight).
    assert.equal(row.audio.length, 8);
    assert.equal(row.audio.filter((a) => a.language === 'Telugu').length, 1);
    assert.equal(row.audio.find((a) => a.default).language, 'Russian');
    assert.equal(row.selectableAudio, true);
    assert.equal(row.quality, '720p');
    assert.ok(!/original/i.test(`${row.name} ${row.title}`), 'page label "Original" never on the row');
    // Segments are bound to the User-Agent that fetched the page; a Referer
    // from insertunit answered 400 (2026-11-24). UA only.
    assert.deepStrictEqual(Object.keys(row.headers), ['User-Agent']);
    assert.equal(row.headers['User-Agent'], iu.UA);
});

test('Pushpa 2 master: "Original" is hi there, so no Telugu is claimed', () => {
    const row = iu.rowFromMaster(P2_MASTER, MURL);
    assert.deepStrictEqual(row.languages, ['Russian', 'Hindi', 'Tamil']);
    assert.ok(!row.languages.includes('Telugu'));
});

test('normalised RRR row keeps Telugu and Russian (ru is a known code)', () => {
    const n = normaliseStream(iu.rowFromMaster(RRR_MASTER, MURL));
    assert.deepStrictEqual(n.languages, ['Russian', 'Telugu', 'Hindi']);
    assert.ok(n.audio.some((a) => a.language === 'Telugu' && a.languageCode === 'te'));
    assert.ok(n.audio.some((a) => a.language === 'Russian'));
});

test('getInsertunitStreams: RRR resolves to one Telugu row, page fetched with the row UA', async () => {
    const calls = stub();
    const rows = await iu.getInsertunitStreams('579974', 'movie');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].languages.includes('Telugu'));
    assert.equal(calls[0].url, 'https://api.insertunit.ws/embed/imdb/tt8178634');
    assert.equal(calls[0].headers['User-Agent'], rows[0].headers['User-Agent']);
    assert.ok(!('Referer' in calls[0].headers));
});

test('getInsertunitStreams: a cut far shorter than the TMDB runtime is dropped', async () => {
    stub({ minutes: 10 });
    const rows = await iu.getInsertunitStreams('579974', 'movie');
    assert.deepStrictEqual(rows, []);
});

test('getInsertunitStreams: an unknown runtime keeps the row', async () => {
    stub({ runtime: null });
    const rows = await iu.getInsertunitStreams('579974', 'movie');
    assert.equal(rows.length, 1);
});

test('getInsertunitStreams: no IMDb id or a page without a player is no rows, not an error', async () => {
    stub({ imdb: null });
    assert.deepStrictEqual(await iu.getInsertunitStreams('1', 'movie'), []);
    stub({ page: '<html>Видео не найдено</html>' });
    assert.deepStrictEqual(await iu.getInsertunitStreams('579974', 'movie'), []);
    stub({ pageStatus: 404, page: 'not found' });
    const out = await iu.getInsertunitStreams('579974', 'movie');
    assert.deepStrictEqual([...out], []);
    assert.equal(out.notListed, true);
});

test('getInsertunitStreams: a 5xx page throws so the fan-out does not cache it', async () => {
    stub({ pageStatus: 503, page: 'down' });
    await assert.rejects(() => iu.getInsertunitStreams('579974', 'movie'), /HTTP 503/);
});

test('getInsertunitStreams: tv without season/episode never guesses', async () => {
    const calls = stub();
    assert.deepStrictEqual(await iu.getInsertunitStreams('1399', 'tv'), []);
    assert.equal(calls.length, 0);
});

test('route: web through the proxy (UA-bound segments), APK direct with the row UA', () => {
    assert.deepStrictEqual(routeFor('insertunit', MURL), { web: 'proxy', apk: 'direct' });
});

test('canary: insertunit validates on RRR and gets the runtime check', () => {
    const { verifyTitleOf } = require('../providers/registry');
    assert.equal(verifyTitleOf('insertunit').tmdbId, '579974');
    assert.ok(require('../lib/selfheal/canary').RUNTIME_CHECK.has('insertunit'));
});
