'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Prod 2026-11-19, The Paradise (1376856): mapple served an HEVC ladder and
// Chrome on Android (no hvc1 in MediaSource) played audio over a black screen.
// The row must say its codec so the player can skip it.
const hls = require('../lib/media/hlsManifest');
const { normaliseStream } = require('../utils/streamSchema');
function stub(masters, calls) {
    return async (url, opts = {}) => {
        const u = new URL(String(url));
        calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
        const headers = { get: () => null, getSetCookie: () => [] };
        const res = (o, status = 200, raw) => ({
            ok: status < 400, status, headers, json: async () => o,
            text: async () => String(raw ?? JSON.stringify(o)),
            arrayBuffer: async () => Buffer.from(raw ?? ''),
        });
        if (u.pathname === '/api/ui/session') return res({ token: 'RT' });
        if (u.pathname === '/api/media-session') return res({ token: 'ST' });
        if (u.pathname === '/api/encrypt') {
            const src = JSON.parse(opts.body).data.source;
            return res(src in masters ? { url: `/api/stream?src=${src}` } : {});
        }
        if (u.pathname === '/api/stream') {
            const src = u.searchParams.get('src');
            return res({ data: { stream_url: `https://cdn.example/${src}/master.m3u8` } });
        }
        if (u.hostname === 'cdn.example') {
            const [, src, ...rest] = u.pathname.split('/');
            let m = masters[src];
            // An object maps each file under the front: master.m3u8, the
            // variant playlist, the init segment.
            if (m && typeof m === 'object' && !(m instanceof Error) && !Buffer.isBuffer(m)) m = m[rest.join('/')];
            if (m === undefined) return res(null, 404, '');
            if (m instanceof Error) throw m;
            return res(null, 200, m);
        }
        return res({});
    };
}

function load(t, masters, calls) {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    global.fetch = stub(masters, calls);
    delete require.cache[require.resolve('../providers/mapple')];
    return require('../providers/mapple');
}

const HEVC = '#EXTM3U\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L150.90,mp4a.40.2"\n2160.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90,mp4a.40.2"\n1080.m3u8\n';

test('videoCodecFamily names the video family of a CODECS list', () => {
    assert.equal(hls.videoCodecFamily('hvc1.1.6.L150.90,mp4a.40.2'), 'hevc');
    assert.equal(hls.videoCodecFamily('mp4a.40.2, hev1.1.6.L93.B0'), 'hevc');
    assert.equal(hls.videoCodecFamily('avc1.640028,mp4a.40.2'), 'avc');
    assert.equal(hls.videoCodecFamily('av01.0.08M.08'), 'av1');
    assert.equal(hls.videoCodecFamily('vp09.00.10.08'), 'vp9');
    assert.equal(hls.videoCodecFamily('mp4a.40.2'), null);
    assert.equal(hls.videoCodecFamily(null), null);
});

test('masterCodecs reads the best variant that declares CODECS', () => {
    assert.equal(hls.masterCodecs(HEVC), 'hvc1.1.6.L150.90,mp4a.40.2');
    assert.equal(hls.masterCodecs('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na.m3u8\n'), null);
});

test('mapple row carries codecs and videoCodec from the master', async (t) => {
    const { getMappleStreams } = load(t, { s9: HEVC }, []);
    const rows = await getMappleStreams('1376856', 'movie');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].codecs, 'hvc1.1.6.L150.90,mp4a.40.2');
    assert.equal(rows[0].videoCodec, 'hevc');
    assert.deepEqual(rows[0].levels.map((l) => l.height), [2160, 1080]);
    const n = normaliseStream(rows[0]);
    assert.equal(n.videoCodec, 'hevc');
    assert.equal(n.codecs, 'hvc1.1.6.L150.90,mp4a.40.2');
    assert.equal(n.levels[0].codecs, 'hvc1.1.6.L150.90,mp4a.40.2');
});

test('mapple row without CODECS says videoCodec null, not a guess', async (t) => {
    const plain = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080.m3u8\n';
    const { getMappleStreams } = load(t, { s9: plain }, []);
    const [row] = await getMappleStreams('1376856', 'movie');
    assert.equal(row.codecs, null);
    assert.equal(row.videoCodec, null);
    assert.equal(normaliseStream(row).videoCodec, null);
});

// The live s4 master on 2026-11-19 had no CODECS; only the init segment said hev1.
const NO_CODECS = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1701000,RESOLUTION=1920x1080,AUDIO="audio"\nv1080/index.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=854x480,AUDIO="audio"\nv480/index.m3u8\n';
const MEDIA = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg1.m4s\n#EXT-X-ENDLIST\n';
const initWith = (fourcc) => Buffer.concat([Buffer.from('\0\0\0\x1cftypiso5'), Buffer.from(`stsd....${fourcc}....`)]);

test('mapple reads hev1 from the init segment when the master has no CODECS', async (t) => {
    const calls = [];
    const { getMappleStreams } = load(t, {
        s9: { 'master.m3u8': NO_CODECS, 'v1080/index.m3u8': MEDIA, 'v1080/init.mp4': initWith('hev1hvcC') },
    }, calls);
    const [row] = await getMappleStreams('1376856', 'movie');
    assert.equal(row.codecs, null);
    assert.equal(row.videoCodec, 'hevc');
    assert.equal(normaliseStream(row).videoCodec, 'hevc');
    // The top variant is the one probed.
    assert.ok(calls.some((c) => c.endsWith('/s9/v1080/init.mp4')));
});

test('mapple reads avc1 from the init segment as avc', async (t) => {
    const { getMappleStreams } = load(t, {
        s9: { 'master.m3u8': NO_CODECS, 'v1080/index.m3u8': MEDIA, 'v1080/init.mp4': initWith('avc1avcC') },
    }, []);
    const [row] = await getMappleStreams('1376856', 'movie');
    assert.equal(row.videoCodec, 'avc');
});

test('mapple keeps the row with videoCodec null when the init probe fails', async (t) => {
    const { getMappleStreams } = load(t, { s9: { 'master.m3u8': NO_CODECS } }, []);
    const [row] = await getMappleStreams('1376856', 'movie');
    assert.equal(row.url, 'https://cdn.example/s9/master.m3u8');
    assert.equal(row.videoCodec, null);
    assert.deepEqual(row.levels.map((l) => l.height), [1080, 480]);
});

test('initVideoCodec and mapUri are pure', () => {
    assert.equal(hls.initVideoCodec(initWith('hvc1')), 'hevc');
    assert.equal(hls.initVideoCodec(Buffer.from('nothing here')), null);
    assert.equal(hls.mapUri(MEDIA, 'https://c/x/index.m3u8'), 'https://c/x/init.mp4');
    assert.equal(hls.mapUri('#EXTM3U\n#EXTINF:6,\na.ts\n', 'https://c/'), null);
});

test('normaliseStream derives videoCodec from codecs when a provider gives only codecs', () => {
    const n = normaliseStream({ url: 'https://x/m.m3u8', provider: 'VaPlayer', codecs: 'avc1.64001f,mp4a.40.2' });
    assert.equal(n.videoCodec, 'avc');
    assert.equal(normaliseStream({ url: 'https://x/a.mp4', provider: 'P' }).videoCodec, null);
});
