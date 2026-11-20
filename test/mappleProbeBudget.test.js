'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// readLadder runs after a front already gave a stream. Master, media playlist
// and init segment were three 8s steps in a row: 24s worst case, past the 20s
// registry deadline, so a found row could be dropped. The codec probe now has
// one shared budget (about 2s), and is skipped when the deadline is near.
// Stub fetch honours the abort signal, like real fetch.
function stub(files, calls) {
    return (url, opts = {}) => {
        const u = new URL(String(url));
        calls.push(`${opts.method || 'GET'} ${u.pathname}`);
        const headers = { get: () => null, getSetCookie: () => [] };
        const res = (o, status = 200, raw) => ({
            ok: status < 400, status, headers, json: async () => o,
            text: async () => String(raw ?? JSON.stringify(o)),
            arrayBuffer: async () => Buffer.from(raw ?? ''),
        });
        if (u.pathname === '/api/ui/session') return Promise.resolve(res({ token: 'RT' }));
        if (u.pathname === '/api/media-session') return Promise.resolve(res({ token: 'ST' }));
        if (u.pathname === '/api/encrypt') {
            const src = JSON.parse(opts.body).data.source;
            return Promise.resolve(res(src === 's12' ? { url: '/api/stream?src=s12' } : {}));
        }
        if (u.pathname === '/api/stream') {
            return Promise.resolve(res({ data: { stream_url: 'https://cdn.example/s12/master.m3u8' } }));
        }
        if (u.hostname === 'cdn.example') {
            const f = files[u.pathname.slice('/s12/'.length)];
            if (f === undefined) return Promise.resolve(res(null, 404, ''));
            if (f === 'HANG') {
                // Never answers. Only the abort signal ends it.
                return new Promise((_, reject) => {
                    opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
            }
            return Promise.resolve(res(null, 200, f));
        }
        return Promise.resolve(res({}));
    };
}

function load(t, files, calls, env = {}) {
    const realFetch = global.fetch;
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    t.after(() => {
        global.fetch = realFetch;
        for (const k of Object.keys(env)) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        delete require.cache[require.resolve('../providers/mapple')];
    });
    global.fetch = stub(files, calls);
    delete require.cache[require.resolve('../providers/mapple')];
    return require('../providers/mapple');
}

const NO_CODECS = '#EXTM3U\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nv1080/index.m3u8\n';
const MEDIA = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg1.m4s\n#EXT-X-ENDLIST\n';

test('a hung init segment still returns the row within the probe budget, videoCodec null', async (t) => {
    const calls = [];
    const { getMappleStreams } = load(t, {
        'master.m3u8': NO_CODECS, 'v1080/index.m3u8': MEDIA, 'v1080/init.mp4': 'HANG',
    }, calls);
    const t0 = Date.now();
    const rows = await getMappleStreams('1376856', 'movie');
    const ms = Date.now() - t0;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, 'https://cdn.example/s12/master.m3u8');
    assert.equal(rows[0].videoCodec, null);
    assert.equal(rows[0].codecs, null);
    assert.deepEqual(rows[0].levels.map((l) => l.height), [1080]);
    assert.ok(calls.some((c) => c.endsWith('/s12/v1080/init.mp4')), 'init segment was probed');
    // Budget is 2000ms for both probe fetches. Before the fix this was 8000ms.
    assert.ok(ms >= 1800 && ms < 3500, `took ${ms}ms`);
});

test('a hung media playlist shares the same probe budget', async (t) => {
    const { getMappleStreams } = load(t, { 'master.m3u8': NO_CODECS, 'v1080/index.m3u8': 'HANG' }, []);
    const t0 = Date.now();
    const [row] = await getMappleStreams('1376856', 'movie');
    const ms = Date.now() - t0;
    assert.equal(row.videoCodec, null);
    assert.ok(ms < 3500, `took ${ms}ms`);
});

test('the probe is skipped when the registry deadline is near', async (t) => {
    const calls = [];
    // Deadline 2100ms minus a 2000ms margin leaves about 100ms: below the
    // probe minimum, so no media playlist or init fetch is made.
    const { getMappleStreams } = load(t, {
        'master.m3u8': NO_CODECS, 'v1080/index.m3u8': MEDIA, 'v1080/init.mp4': 'HANG',
    }, calls, { PROVIDER_DEADLINE_MS: '2100', MAPPLE_DEADLINE_MARGIN_MS: '2000' });
    const t0 = Date.now();
    const [row] = await getMappleStreams('1376856', 'movie');
    assert.equal(row.url, 'https://cdn.example/s12/master.m3u8');
    assert.equal(row.videoCodec, null);
    assert.ok(!calls.some((c) => c.includes('/v1080/')), 'probe was skipped');
    assert.ok(Date.now() - t0 < 1000);
});

test('a hung master past the deadline keeps the row instead of overrunning', async (t) => {
    const { getMappleStreams } = load(t, { 'master.m3u8': 'HANG' }, [],
        { PROVIDER_DEADLINE_MS: '2500', MAPPLE_DEADLINE_MARGIN_MS: '2000' });
    const t0 = Date.now();
    const [row] = await getMappleStreams('1376856', 'movie');
    const ms = Date.now() - t0;
    assert.equal(row.url, 'https://cdn.example/s12/master.m3u8');
    assert.equal(row.videoCodec, null);
    // Master timeout is cut to the ~500ms left, not the 8000ms step timeout.
    assert.ok(ms < 1500, `took ${ms}ms`);
});
