'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createCipheriv } = require('crypto');

// A provider that hits an HTTP error, a timeout or a throttle must say so
// (throw, or mark `upstreamError` on partial rows) instead of returning the
// same [] it returns for a title it really lacks. The aggregator caches a
// clean [] as "no streams" for minutes; it never caches a failure.

process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
process.env.NETMIRROR_API_BASE = 'https://nm.test';
process.env.NEWTV_DOMAINS = 'https://disc.test';

const tmdbId = require.resolve(path.join(__dirname, '..', 'utils/tmdb.js'));
const realTmdb = require(tmdbId);
require.cache[tmdbId].exports = {
    ...realTmdb,
    getDetails: async (type, id) => ({ title: `Film ${id}`, release_date: '2024-01-01', name: `Film ${id}` }),
    resolveImdbId: async () => 'tt1',
};
const fresh = (rel) => {
    // NetMirror's guard (N7) is process-wide: each test starts from a clean one.
    if (rel === 'netmirror') require('../utils/netmirrorGuard').guard.reset();
    delete require.cache[require.resolve(`../providers/${rel}`)];
    return require(`../providers/${rel}`);
};
const realFetch = global.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------- VaPlayer ----------
function vaFetch(apiBody, apiStatus = 200) {
    return async (url) => {
        const u = String(url);
        if (u.includes('va_src.php')) return json({ src: 'https://player.test/embed/movie/tt1?va=x' });
        if (u.startsWith('https://player.test/')) return new Response('<script>var C={"apiToken":"TOK"}</script>');
        if (u.includes('api.php')) return json(apiBody, apiStatus);
        return new Response('', { status: 500 });
    };
}

test('vaplayer: api status_code 404 (measured "not here") is a clean empty', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = vaFetch({ status_code: 404 });
    const { getVaplayerStreams } = fresh('vaplayer');
    assert.deepEqual(await getVaplayerStreams('1', 'movie'), []);
});

test('vaplayer: HTTP 403 invalid token throws instead of returning []', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = vaFetch({ status_code: '403', error: 'invalid api token' }, 403);
    const { getVaplayerStreams } = fresh('vaplayer');
    await assert.rejects(getVaplayerStreams('1', 'movie'), /HTTP 403/);
});

test('vaplayer: a timeout on the wrapper throws', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
    const { getVaplayerStreams } = fresh('vaplayer');
    await assert.rejects(getVaplayerStreams('1', 'movie'), /timeout/);
});

// ---------- showsst ----------
test('showsst: every mirror failing throws; a null source stays []', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async () => new Response('busy', { status: 503 });
    let { getShowsstStreams } = fresh('showsst');
    await assert.rejects(getShowsstStreams('1', 'movie'), /mirrors failed/);

    global.fetch = async () => json({ source: null });
    ({ getShowsstStreams } = fresh('showsst'));
    assert.deepEqual(await getShowsstStreams('1', 'movie'), []);
});

// ---------- mapple ----------
test('mapple: a failed session handshake throws instead of returning []', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
    const { getMappleStreams } = fresh('mapple');
    await assert.rejects(getMappleStreams('1', 'movie'));
});

// ---------- NetMirror ----------
const DECOY = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nhttps://cdn.test/files/220884/1080p/1080p.m3u8?in=unknown::ni\n';
function nmFetch({ embed, search, master }) {
    const seen = [];
    const fn = async (url) => {
        const u = String(url);
        seen.push(u);
        if (u.startsWith('https://nm.test/api/embed-tmdb/')) return embed();
        if (u.startsWith('https://disc.test/checknewtv.php')) return json({ token_hash: Buffer.from('https://newtv.test').toString('base64') });
        if (u.includes('/newtv/ott.php')) return json({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) });
        if (u.includes('/newtv/search.php')) return search(u);
        if (u.includes('/newtv/post.php')) return json({ lang: [{ l: 'Telugu' }], main_id: 'REAL1' });
        if (u.includes('/newtv/otp.php')) return json({ status: 'ok', usertoken: 'fixture-token' });
        if (u.includes('/newtv/player.php')) return json({ status: 'ok', video_link: 'https://cdn.test/hls/REAL1.m3u8' });
        if (u.startsWith('https://cdn.test/hls/')) return new Response(master);
        return new Response('', { status: 404 });
    };
    fn.seen = seen;
    return fn;
}

test('netmirror: Netflix 503 + newtv refused -> throws, then backs off without re-arming', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = nmFetch({
        embed: () => new Response('down', { status: 503 }),
        search: () => new Response('Page Not Found', { status: 403 }),
        master: '',
    });
    const { getNetmirrorStreams } = fresh('netmirror');
    await assert.rejects(getNetmirrorStreams('5001', 'movie'), /HTTP 503|search|JSON|Unexpected|refused/);
    const before = global.fetch.seen.length;
    await assert.rejects(getNetmirrorStreams('5001', 'movie'), /backing off/);
    assert.equal(global.fetch.seen.length, before, 'backoff served from the netmirror cache, no new upstream calls');
});

test('netmirror: placeholder master (throttle) is still rejected AND reported as a failure', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = nmFetch({
        embed: () => json({ ok: true, streams: [] }),
        search: () => json({ searchResult: [{ id: 'REAL1', t: 'Film 5002' }] }),
        master: DECOY,
    });
    const { getNetmirrorStreams } = fresh('netmirror');
    await assert.rejects(getNetmirrorStreams('5002', 'movie'), /placeholder|throttled/);
});

test('netmirror: Netflix ok with nothing + no title match on newtv is a clean empty', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = nmFetch({
        embed: () => json({ ok: true, streams: [] }),
        search: () => json({ searchResult: [] }),
        master: '',
    });
    const { getNetmirrorStreams } = fresh('netmirror');
    const out = await getNetmirrorStreams('5003', 'movie');
    assert.deepEqual([...out], []);
    assert.equal(out.upstreamError, undefined);
});

// ---------- CastleTV ----------
const SEC = Buffer.from('0123456789').toString('base64');
function enc(obj) {
    const key = Buffer.concat([Buffer.from(SEC, 'base64'), Buffer.from('T!BgJB')]).subarray(0, 16);
    const c = createCipheriv('aes-128-cbc', key, key);
    return Buffer.concat([c.update(JSON.stringify(obj)), c.final()]).toString('base64');
}
function castleFetch({ failLang, seasons = [] }) {
    return async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('getSecurityKey')) return json({ code: 200, data: SEC });
        if (u.includes('searchByKeyword')) return new Response(enc({ data: { rows: [{ id: 77, title: 'Film 6001' }] } }));
        if (u.includes('/movie?')) {
            return new Response(enc({ data: { seasons, episodes: [{ id: 9, number: 1, tracks: [
                { languageId: 1, languageName: 'Hindi' }, { languageId: 2, languageName: 'Telugu' }] }] } }));
        }
        if (u.includes('getVideo2')) {
            const body = JSON.parse(opts.body);
            if (body.languageId === failLang) return new Response('busy', { status: 503, statusText: 'Service Unavailable' });
            return new Response(enc({ data: { videoUrl: `https://castle.test/${body.languageId}/index.m3u8` } }));
        }
        return new Response('', { status: 404 });
    };
}

test('castletv: a language track whose calls all failed marks the answer partial', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = castleFetch({ failLang: '2' });
    const { getCastletvStreams } = fresh('castletv');
    const out = await getCastletvStreams('6001', 'movie');
    assert.equal(out.length, 1, 'the Hindi row is still served');
    assert.match(out.upstreamError || '', /Telugu/);
});

test('castletv: every track healthy -> no upstreamError', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = castleFetch({ failLang: null });
    const { getCastletvStreams } = fresh('castletv');
    const out = await getCastletvStreams('6001', 'movie');
    assert.equal(out.length, 2);
    assert.equal(out.upstreamError, undefined);
});

test('castletv: a season Castle does not list is not served from another season', async (t) => {
    t.after(() => { global.fetch = realFetch; });
    global.fetch = castleFetch({ failLang: null, seasons: [{ number: 1, movieId: 77 }] });
    const { getCastletvStreams } = fresh('castletv');
    assert.deepEqual(await getCastletvStreams('6001', 'tv', 2, 1), []);
    const s1 = await getCastletvStreams('6001', 'tv', 1, 1);
    assert.equal(s1.length, 2, 'the listed season still resolves');
});
