'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const sv = require('../lib/media/segmentVerify');

// Fake fetch: url -> { status, body (Buffer|string), ct, delayMs, throw }.
function fakeFetch(routes, log) {
    return async (url, init) => {
        if (log) log.push({ url, headers: init.headers });
        const r = routes[url];
        if (!r) return resp(404, '');
        if (r.throw) throw new Error(r.throw);
        if (r.delayMs) {
            await new Promise((res, rej) => {
                const t = setTimeout(res, r.delayMs);
                init.signal.addEventListener('abort', () => {
                    clearTimeout(t);
                    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
                });
            });
        }
        return resp(r.status || 200, r.body, r.ct);
    };
}
function resp(status, body, ct) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
    return {
        status, ok: status >= 200 && status < 300,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct || '' : null) },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    };
}
// 4KB of MPEG-TS: sync byte every 188 bytes.
function tsBytes() {
    const b = Buffer.alloc(4096, 0xff);
    for (let i = 0; i < b.length; i += 188) b[i] = 0x47;
    return b;
}
function mp4Bytes() {
    const b = Buffer.alloc(4096, 0);
    b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1');
    return b;
}
const HTML = '<!DOCTYPE html><html><body>Too Many Requests in Short Period of Time</body></html>' + ' '.repeat(2000);
const master = (variant) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n${variant}\n`;
const media = (seg) => `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n${seg}\n#EXT-X-ENDLIST\n`;
const s = (name, url, extra) => ({ name, provider: name, url, languages: ['Telugu'], quality: '1080p', ...extra });

beforeEach(() => sv.clearVerifyCache());

test('a real HLS segment passes: master -> variant -> ranged TS read', async () => {
    const log = [];
    const f = fakeFetch({
        'https://a/m.m3u8': { body: master('v.m3u8') },
        'https://a/v.m3u8': { body: media('seg0.ts') },
        'https://a/seg0.ts': { body: tsBytes() },
    }, log);
    const v = await sv.verifyOne({ url: 'https://a/m.m3u8', headers: { Referer: 'https://a/' } }, { fetchImpl: f });
    assert.equal(v.ok, true, JSON.stringify(v));
    const segReq = log.find((l) => l.url === 'https://a/seg0.ts');
    assert.equal(segReq.headers.Range, 'bytes=0-4095');
    assert.equal(segReq.headers.Referer, 'https://a/', 'stream headers ride on every hop');
});

test('HTML posing as a segment fails; an empty playlist fails', async () => {
    const f = fakeFetch({
        'https://b/m.m3u8': { body: media('seg0.ts') },
        'https://b/seg0.ts': { body: HTML, ct: 'video/mp2t' },
        'https://c/m.m3u8': { body: '#EXTM3U\n#EXT-X-ENDLIST\n' },
    });
    const html = await sv.verifyOne({ url: 'https://b/m.m3u8' }, { fetchImpl: f });
    assert.equal(html.ok, false);
    assert.match(html.reason, /html/);
    const empty = await sv.verifyOne({ url: 'https://c/m.m3u8' }, { fetchImpl: f });
    assert.deepEqual(empty, { ok: false, reason: 'empty-playlist' });
});

test('mp4 needs ftyp; short and HTML bodies fail', async () => {
    const f = fakeFetch({
        'https://d/ok.mp4': { body: mp4Bytes() },
        'https://d/noftyp.mp4': { body: Buffer.alloc(4096, 7) },
        'https://d/short.mp4': { body: Buffer.alloc(200, 7) },
        'https://d/html.mp4': { body: HTML },
    });
    assert.equal((await sv.verifyOne({ url: 'https://d/ok.mp4' }, { fetchImpl: f })).ok, true);
    assert.equal((await sv.verifyOne({ url: 'https://d/noftyp.mp4' }, { fetchImpl: f })).reason, 'no ftyp');
    assert.match((await sv.verifyOne({ url: 'https://d/short.mp4' }, { fetchImpl: f })).reason, /^short/);
    assert.equal((await sv.verifyOne({ url: 'https://d/html.mp4' }, { fetchImpl: f })).reason, 'html');
});

test('one retry on a network error, then a verdict', async () => {
    let n = 0;
    const f = async (url, init) => {
        n++;
        if (n === 1) throw new Error('ECONNRESET');
        return fakeFetch({ 'https://e/x.mp4': { body: mp4Bytes() } })(url, init);
    };
    const v = await sv.verifyOne({ url: 'https://e/x.mp4' }, { fetchImpl: f });
    assert.equal(v.ok, true);
    assert.equal(n, 2);
});

test('HTML stream ranked first is demoted, never dropped, and keeps its language group', async () => {
    const f = fakeFetch({
        'https://bad/m.m3u8': { body: media('s.ts') },
        'https://bad/s.ts': { body: HTML },
        'https://good/m.m3u8': { body: media('s.ts') },
        'https://good/s.ts': { body: tsBytes() },
    });
    const list = [
        s('Bad', 'https://bad/m.m3u8'),
        s('Good', 'https://good/m.m3u8'),
        s('Hindi', 'https://hin/x.mp4', { languages: ['Hindi'] }),
    ];
    const out = await sv.verifyTopStreams(list, { fetchImpl: f });
    assert.equal(out.length, list.length, 'nothing removed');
    assert.deepEqual(out.map((x) => x.name), ['Bad', 'Good', 'Hindi'], 'verify does not reorder by itself');
    assert.equal(out[0].byteCheck.ok, false);
    assert.equal(out[1].byteCheck.ok, true);
    // Canonical comparator rule (mirrors apiServer.js): language, then dead.
    const rank = (x) => [x.languages.includes('Telugu') ? 0 : 1, x.byteCheck && x.byteCheck.ok === false ? 1 : 0];
    const sorted = out.map((x, i) => ({ x, i })).sort((a, b) => {
        const ra = rank(a.x); const rb = rank(b.x);
        return ra[0] - rb[0] || ra[1] - rb[1] || a.i - b.i;
    }).map(({ x }) => x.name);
    assert.deepEqual(sorted, ['Good', 'Bad', 'Hindi'], 'dead Telugu still above live Hindi');
});

test('a timeout demotes, does not drop, and stays inside the attempt cap', async () => {
    const f = fakeFetch({ 'https://slow/x.mp4': { body: mp4Bytes(), delayMs: 5000 } });
    const list = [s('Slow', 'https://slow/x.mp4')];
    const t0 = Date.now();
    const out = await sv.verifyTopStreams(list, { fetchImpl: f, attemptMs: 150, budgetMs: 1000 });
    assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms`);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].byteCheck, { ok: false, reason: 'timeout' });
});

test('a passing top candidate does not wait for slower runners-up', async () => {
    const f = fakeFetch({
        'https://fast/x.mp4': { body: mp4Bytes() },
        'https://slow2/x.mp4': { body: mp4Bytes(), delayMs: 800 },
    });
    const list = [s('Fast', 'https://fast/x.mp4'), s('Slow', 'https://slow2/x.mp4')];
    const t0 = Date.now();
    const out = await sv.verifyTopStreams(list, { fetchImpl: f, attemptMs: 2000, budgetMs: 3000 });
    const took = Date.now() - t0;
    assert.ok(took < 300, `took ${took}ms`);
    assert.equal(out.length, 2);
    assert.equal(out[0].byteCheck.ok, true);
    assert.equal(out[1].byteCheck, undefined, 'still running, so no verdict yet');
});

test('verdicts are cached by URL: a second resolve does not refetch', async () => {
    const log = [];
    const f = fakeFetch({ 'https://c1/x.mp4': { body: mp4Bytes() } }, log);
    await sv.verifyTopStreams([s('A', 'https://c1/x.mp4')], { fetchImpl: f });
    await sv.verifyTopStreams([s('A', 'https://c1/x.mp4')], { fetchImpl: f });
    assert.equal(log.length, 1);
    assert.equal(sv.CACHE_MS, 120000);
});

test('only the top 3 are fetched, own-server urls are skipped, count never changes', async () => {
    const log = [];
    const routes = {};
    for (let i = 0; i < 6; i++) routes[`https://n${i}/x.mp4`] = { body: HTML };
    const f = fakeFetch(routes, log);
    const list = [s('Own', 'http://me:8787/castle-demux/1/master.m3u8'),
        ...[0, 1, 2, 3, 4, 5].map((i) => s(`N${i}`, `https://n${i}/x.mp4`))];
    const out = await sv.verifyTopStreams(list, { fetchImpl: f, skipPrefix: 'http://me:8787' });
    assert.equal(out.length, list.length);
    assert.deepEqual([...new Set(log.map((l) => l.url))], ['https://n0/x.mp4', 'https://n1/x.mp4', 'https://n2/x.mp4']);
    assert.equal(out[0].byteCheck, undefined);
});

test('prewarmTopStreams starts the top 3 checks at once and does not wait for them', async () => {
    const log = [];
    const routes = {};
    for (let i = 0; i < 5; i++) routes[`https://p${i}/x.mp4`] = { body: mp4Bytes(), delayMs: 300 };
    const f = fakeFetch(routes, log);
    const list = [s('Own', 'http://me:8787/castle-demux/1/master.m3u8'),
        ...[0, 1, 2, 3, 4].map((i) => s(`P${i}`, `https://p${i}/x.mp4`))];
    const t0 = Date.now();
    const started = sv.prewarmTopStreams(list, { fetchImpl: f, skipPrefix: 'http://me:8787' });
    assert.ok(Date.now() - t0 < 50, 'prewarm returns at once');
    assert.deepEqual(started, ['https://p0/x.mp4', 'https://p1/x.mp4', 'https://p2/x.mp4']);
    assert.deepEqual([...new Set(log.map((l) => l.url))], started);
});

test('verifyTopStreams after a prewarm joins the running checks: same verdicts, no refetch, no full wait', async () => {
    const log = [];
    const f = fakeFetch({
        'https://w0/x.mp4': { body: mp4Bytes(), delayMs: 600 },
        'https://w1/x.mp4': { body: HTML, delayMs: 600 },
    }, log);
    const list = [s('W0', 'https://w0/x.mp4'), s('W1', 'https://w1/x.mp4')];
    sv.prewarmTopStreams(list, { fetchImpl: f, attemptMs: 2000 });
    await new Promise((r) => setTimeout(r, 450));
    const t0 = Date.now();
    const out = await sv.verifyTopStreams(list, { fetchImpl: f, attemptMs: 2000, budgetMs: 3000 });
    const took = Date.now() - t0;
    assert.ok(took < 400, `final verify took ${took}ms after a 450 ms head start`);
    assert.equal(log.length, 2, 'each url fetched once');
    assert.equal(out[0].byteCheck.ok, true);
});

test('prewarmTopStreams with an empty or unverifiable list starts nothing', () => {
    assert.deepEqual(sv.prewarmTopStreams([], {}), []);
    assert.deepEqual(sv.prewarmTopStreams([s('Own', 'http://me:8787/a.m3u8')], { skipPrefix: 'http://me:8787', fetchImpl: async () => { throw new Error('no'); } }), []);
});

// Route level: the real sortStreamsCanonically in apiServer.js, real wiring.
test('/api/streams demotes an HTML-serving Telugu stream below a live one and drops nothing', async () => {
    const path = require('path');
    const stub = (rel, exports) => {
        const id = require.resolve(path.join(__dirname, '..', rel));
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    const mk = (provider, lang, url) => ({ provider, name: provider, title: `${provider} ${lang}`, quality: '1080p',
        url, container: 'mp4', languages: [lang] });
    const fake = {
        castletv: { name: 'castletv', enabled: true,
            fetch: async () => [mk('CastleTV', 'Telugu', 'https://dead.example/a.mp4'),
                mk('Other', 'Telugu', 'https://live.example/b.mp4')] },
        netmirror: { name: 'netmirror', enabled: true,
            fetch: async () => [mk('NetMirror', 'Hindi', 'https://hindi.example/c.mp4')] },
    };
    stub('providers/registry.js', {
        listProviders: () => Object.keys(fake).map((name) => ({ name, enabled: true })),
        getProvider: (n) => fake[String(n).toLowerCase()] || null,
        getCookieStats: () => ({}),
        PROVIDER_DEADLINE_MS: 20000,
    });
    process.env.PRIMARY_PROVIDERS = 'castletv,netmirror';
    process.env.PREFERRED_AUDIO_LANGUAGE = 'Telugu';
    const realTmdb = require('../utils/tmdb');
    stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });

    const realFetch = globalThis.fetch;
    const upstream = fakeFetch({
        'https://dead.example/a.mp4': { body: HTML, ct: 'text/html' },
        'https://live.example/b.mp4': { body: mp4Bytes() },
        'https://hindi.example/c.mp4': { body: mp4Bytes() },
    });
    globalThis.fetch = (url, init) => (String(url).startsWith('http://127.0.0.1') ? realFetch(url, init) : upstream(url, init));
    const app = require('../apiServer');
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((r) => server.once('listening', r));
        const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/streams/movie/4242`);
        const d = await r.json();
        assert.equal(d.count, 3, 'nothing removed');
        assert.deepEqual(d.streams.map((x) => x.provider), ['Other', 'CastleTV', 'NetMirror']);
        assert.deepEqual(d.streams[1].byteCheck, { ok: false, reason: 'html' });
        assert.equal(d.streams[0].byteCheck.ok, true);
    } finally {
        server.close();
        globalThis.fetch = realFetch;
    }
});

// 2026-11-24 ShowsSt movie/1359490: every HLS segment on p16-sg.tiktokcdn.com
// is a 70 B 1x1 PNG served 200 image/png. That first segment fails the check.
test('a 70 B PNG placeholder segment fails as short', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408d76360606060000000050001'
        + '5ef32a3a0000000049454e44ae426082', 'hex');
    const f = fakeFetch({
        'https://cdn.ngcloud.app/movie/x': { body: '#EXTM3U\n#EXTINF:6.44,\nhttps://p16-sg.tiktokcdn.com/obj/s0\n', ct: 'application/vnd.apple.mpegurl' },
        'https://p16-sg.tiktokcdn.com/obj/s0': { body: png, ct: 'image/png' },
    });
    const v = await sv.verifyOne({ url: 'https://cdn.ngcloud.app/movie/x', container: 'hls' }, { fetchImpl: f });
    assert.equal(png.length, 70);
    assert.equal(v.ok, false);
    assert.match(v.reason, /^segment short 70b/);
});

// Cold RRR 2026-11-24: the last-known-good check and verify-top read the same
// master + segment back to back (+1751 ms on the first answer). The LKG check
// now goes through cachedVerify, so verify-top reuses its verdict.
test('a cachedVerify verdict (LKG check) is reused by verifyTopStreams: no refetch', async () => {
    const log = [];
    const f = fakeFetch({
        'https://a/m.m3u8': { body: master('v.m3u8') },
        'https://a/v.m3u8': { body: media('seg0.ts') },
        'https://a/seg0.ts': { body: tsBytes() },
    }, log);
    const row = s('insertunit', 'https://a/m.m3u8');
    const v = await sv.cachedVerify(row, { fetchImpl: f });
    assert.equal(v.ok, true);
    const n = log.length;
    const out = await sv.verifyTopStreams([row], { fetchImpl: f });
    assert.equal(log.length, n, 'no second read');
    assert.equal(out[0].byteCheck.ok, true);
});

test('lastKnownGood checks through the shared verdict cache', () => {
    const src = require('fs').readFileSync(require.resolve('../lib/mmhub/lastKnownGood'), 'utf8');
    assert.match(src, /cachedVerify\(row/);
});
