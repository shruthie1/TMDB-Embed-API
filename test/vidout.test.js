'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vo = require('../providers/vidout');
const { normaliseStream } = require('../utils/streamSchema');
const { routeFor } = require('../lib/routing/providerRoutes');

// Recorded 2026-11-24 (multimovies-servers.md). The catalogue is a public
// GitHub repo keyed by TMDB id. Pushpa 2 (857598): 4 tagged renditions
// hi (DEFAULT), ml, ta, te; 480/720/1080. RRR (579974): one 1080p variant,
// audio muxed, no tag at all. Segments are MPEG-TS named .woff2.
const FX = path.join(__dirname, 'fixtures', 'vidout');
const read = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const P2_MASTER = read('pushpa2-master.txt');
const RRR_MASTER = read('rrr-master.txt');
const P2_URL = 'https://1hyahuwewhyvwmq.mortgagerefinance.cfd/ihrtneyo46au6bsv/hls3/01/03731/owi58j9atsun_,l,n,h,.urlset/master.txt';
const RRR_URL = 'https://wpvsahsvl0yo.smartcheckout.shop/Qt9MDOYehjgb/hls3/01/08671/uqfhh6om24q6_h/master.txt';

const realDeps = { ...vo._deps };
afterEach(() => { Object.assign(vo._deps, realDeps); });

function variant(minutes) {
    const n = Math.round((minutes * 60) / 10);
    return `#EXTM3U\n#EXT-X-TARGETDURATION:10\n${Array.from({ length: n }, (_, i) => `#EXTINF:10.000,\n/x/seg-${i + 1}-v1-a1.woff2`).join('\n')}\n#EXT-X-ENDLIST\n`;
}

function stub({ link = P2_URL, ghStatus = 200, master = P2_MASTER, minutes = 200, runtime = 200, calls = [] } = {}) {
    vo._deps.runtimeMinutes = async () => runtime;
    vo._deps.fetchText = async (url, headers) => {
        calls.push({ url, headers });
        if (url.startsWith('https://raw.githubusercontent.com/')) return { status: ghStatus, text: typeof link === 'string' ? `${link}\n` : JSON.stringify(link) };
        if (url.endsWith('/master.txt')) return { status: 200, text: master };
        if (/index-.*\.txt$/.test(url)) return { status: 200, text: variant(minutes) };
        return { status: 404, text: '' };
    };
    return calls;
}

test('catalogue urls: movie by TMDB id, tv by season file', () => {
    assert.equal(vo.catalogueUrl('857598', 'movie'),
        'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/movie/857598');
    assert.equal(vo.catalogueUrl('1399', 'tv', 2),
        'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/tv/1399/S2.json');
});

test('Pushpa 2 master: Telugu from LANGUAGE="te" among hi/ml/ta, 1080p, Referer row', () => {
    const row = vo.rowFromMaster(P2_MASTER, P2_URL);
    assert.equal(row.provider, 'vidout');
    assert.equal(row.container, 'hls');
    assert.deepStrictEqual(row.languages, ['Hindi', 'Malayalam', 'Tamil', 'Telugu']);
    assert.equal(row.audio.find((a) => a.default).language, 'Hindi');
    assert.equal(row.selectableAudio, true);
    assert.equal(row.quality, '1080p');
    assert.equal(row.headers.Referer, 'https://vidout.pages.dev/');
});

test('RRR master: untagged audio stays unknown, no language word anywhere on the row', () => {
    const row = vo.rowFromMaster(RRR_MASTER, RRR_URL);
    assert.deepStrictEqual(row.languages, []);
    const n = normaliseStream(row);
    assert.deepStrictEqual(n.languages, []);
    assert.equal(n.selectableAudio, false);
});

test('catalogue link checks: only a direct master is used', () => {
    assert.equal(vo.usableLink(` ${P2_URL}\n`), P2_URL);
    assert.equal(vo.usableLink(''), null);
    assert.equal(vo.usableLink('https://x.example/embed#frag'), null);
    assert.equal(vo.usableLink('https://streamhg.example/e/abc123'), null);
    assert.equal(vo.usableLink('404: Not Found'), null);
});

test('getVidoutStreams: Pushpa 2 -> one Telugu row, master fetched with the Referer', async () => {
    const calls = stub();
    const rows = await vo.getVidoutStreams('857598', 'movie');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].languages.includes('Telugu'));
    const m = calls.find((c) => c.url === P2_URL);
    assert.equal(m.headers.Referer, 'https://vidout.pages.dev/');
});

test('getVidoutStreams: not in the catalogue (404) is no rows, not an error', async () => {
    stub({ ghStatus: 404, link: '404: Not Found' });
    const out = await vo.getVidoutStreams('27205', 'movie');
    assert.deepStrictEqual([...out], []);
    // Marked so the fan-out keeps it out of the breaker (prod 2026-11-24).
    assert.equal(out.notListed, true);
});

// Audit 11-24: 82 not-in-catalogue vidout empties; plain [] counted toward the
// breaker. A catalogue entry with no direct master is still "no title here".
test('getVidoutStreams: a catalogue entry without a direct master is notListed (out of the breaker)', async () => {
    stub({ link: 'https://vidout.pages.dev/e/abc123' });
    const out = await vo.getVidoutStreams('27205', 'movie');
    assert.deepStrictEqual([...out], []);
    assert.equal(out.notListed, true);
});

test('getVidoutStreams: GitHub 5xx throws so the fan-out does not cache it', async () => {
    stub({ ghStatus: 502, link: '' });
    await assert.rejects(() => vo.getVidoutStreams('857598', 'movie'), /HTTP 502/);
});

test('getVidoutStreams: wrong-cut runtime drops the row', async () => {
    stub({ minutes: 20 });
    const out = await vo.getVidoutStreams('857598', 'movie');
    assert.deepStrictEqual([...out], []);
    assert.equal(out.notListed, true, 'a wrong cut is not a provider failure');
});

test('getVidoutStreams: tv reads the season file entry for the episode', async () => {
    const calls = stub({ link: { 1: P2_URL } });
    const rows = await vo.getVidoutStreams('1399', 'tv', 2, 1);
    assert.equal(rows.length, 1);
    assert.match(calls[0].url, /hls\/tv\/1399\/S2\.json$/);
    stub({ link: { 1: P2_URL } });
    const missing = await vo.getVidoutStreams('1399', 'tv', 2, 5);
    assert.deepStrictEqual([...missing], []);
    assert.equal(missing.notListed, true, 'episode not in the season file');
});

test('route: web through the proxy (Referer-gated), APK direct', () => {
    assert.deepStrictEqual(routeFor('vidout', P2_URL), { web: 'proxy', apk: 'direct' });
});

test('canary: vidout validates on Pushpa 2 and gets the runtime check', () => {
    const { verifyTitleOf } = require('../providers/registry');
    assert.equal(verifyTitleOf('vidout').tmdbId, '857598');
    assert.ok(require('../lib/selfheal/canary').RUNTIME_CHECK.has('vidout'));
});
