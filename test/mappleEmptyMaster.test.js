'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Prod 2026-11-19, mapple on The Paradise (1376856): a front returned a
// stream_url whose master body was only "#EXTM3U" (8 bytes). That row could
// not play but was offered in the server menu. Stub fetch: s9 has an empty
// master, s4 a real one, so the provider must skip s9 and return s4.
function stub(masters, calls) {
    return async (url, opts = {}) => {
        const u = new URL(String(url));
        calls.push(`${opts.method || 'GET'} ${u.pathname}${u.search}`);
        const headers = { get: () => null, getSetCookie: () => [] };
        const res = (o, status = 200, raw) => ({ ok: status < 400, status, headers, json: async () => o, text: async () => (raw ?? JSON.stringify(o)) });
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
            const src = u.pathname.split('/')[1];
            const m = masters[src];
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

const REAL = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n1080.m3u8\n';

test('mapple skips a front whose master is only #EXTM3U', async (t) => {
    const calls = [];
    const { getMappleStreams } = load(t, { s9: '#EXTM3U', s4: REAL }, calls);
    const rows = await getMappleStreams('1376856', 'movie');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, 'https://cdn.example/s4/master.m3u8');
    assert.deepEqual(rows[0].levels.map((l) => l.height), [1080]);
});

test('mapple returns [] when every front has an empty master', async (t) => {
    const { getMappleStreams } = load(t, { s9: '#EXTM3U\n', s4: '#EXTM3U' }, []);
    assert.deepEqual(await getMappleStreams('1376856', 'movie'), []);
});

test('mapple keeps the row when the master fetch itself fails', async (t) => {
    const { getMappleStreams } = load(t, { s9: new Error('timeout') }, []);
    const rows = await getMappleStreams('1376856', 'movie');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, 'https://cdn.example/s9/master.m3u8');
});

test('isEmptyPlaylist: media playlist with #EXTINF is not empty', () => {
    const { isEmptyPlaylist } = require('../providers/mapple');
    assert.equal(isEmptyPlaylist('#EXTM3U'), true);
    assert.equal(isEmptyPlaylist('#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n'), false);
    assert.equal(isEmptyPlaylist(REAL), false);
});
