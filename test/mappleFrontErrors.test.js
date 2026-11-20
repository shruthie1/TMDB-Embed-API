'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Prod 2026-11-19 09:14, 09:17, 09:56 UTC, mapple on 690957: one front's
// encrypt or signed request hit the 8s abort, the error left the sweep loop,
// and the provider returned no row at 16-19s. s4 (the front that carries it)
// was never tried. Errors must stay per front.
//
// fronts: { source: 'hang' | 'error' | 'empty' | 'row' | { delay, mode } }.
// { delay, mode } answers as `mode` after `delay` ms, unless aborted first.
// Unlisted fronts have no stream (empty encrypt answer).
function stub(fronts) {
    return async (url, opts = {}) => {
        const u = new URL(String(url));
        const headers = { get: () => null, getSetCookie: () => [] };
        const res = (o, raw) => ({ ok: true, status: 200, headers, json: async () => o, text: async () => (raw ?? JSON.stringify(o)) });
        if (u.pathname === '/api/ui/session') return res({ token: 'RT' });
        if (u.pathname === '/api/media-session') return res({ token: 'ST' });
        if (u.pathname === '/api/encrypt') {
            const src = JSON.parse(opts.body).data.source;
            let mode = fronts[src];
            if (mode && typeof mode === 'object') {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, mode.delay);
                    opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('This operation was aborted')); });
                });
                mode = mode.mode;
            }
            if (mode === 'hang') {
                return new Promise((_, reject) => {
                    opts.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
                });
            }
            if (mode === 'error') throw new TypeError('fetch failed');
            return res(mode ? { url: `/api/stream?src=${src}` } : {});
        }
        if (u.pathname === '/api/stream') {
            const src = u.searchParams.get('src');
            const f = fronts[src];
            if (f === 'busy') return res({ success: false, details: 'SOURCE_BUSY', failureKind: 'source_busy', retryable: true });
            const stream = (f === 'row' || f?.mode === 'row') ? `https://cdn.example/${src}/master.m3u8` : '';
            return res({ data: { stream_url: stream } });
        }
        if (u.hostname === 'cdn.example') {
            return res(null, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720.m3u8\n');
        }
        return res({});
    };
}

function load(t, fronts, env = {}) {
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
    global.fetch = stub(fronts);
    delete require.cache[require.resolve('../providers/mapple')];
    return require('../providers/mapple');
}

test('a hung first front is cut and a later front gives the row', async (t) => {
    const { getMappleStreams } = load(t, { mapple: 'hang', s12: 'empty', s4: 'row' }, { MAPPLE_FRONT_STEP_MS: '150' });
    const t0 = Date.now();
    const rows = await getMappleStreams('690957', 'movie');
    const ms = Date.now() - t0;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, 'https://cdn.example/s4/master.m3u8');
    assert.equal(rows[0].title, 'mapple · s4');
    assert.ok(ms < 1500, `took ${ms}ms`);
});

test('a front that throws does not end the sweep', async (t) => {
    const { getMappleStreams } = load(t, { mapple: 'error', s12: 'error', s4: 'row' });
    const rows = await getMappleStreams('690957', 'movie');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'mapple · s4');
});

test('a slow front with a long site timeout still gives its row', async (t) => {
    // 2026-11-20: s25 answered at ~10.5s, s2 is given 22s by the site player.
    // Fronts run in parallel, so a slow front is not starved by earlier ones.
    // Scaled: every other front hangs, s2 answers its row at 300ms while the
    // default 150ms cap would have cut it.
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts, { MAPPLE_FRONT_STEP_MS: '150' });
    for (const s of SOURCES) fronts[s] = 'hang';
    fronts.s2 = { delay: 300, mode: 'row' };
    const rows = await getMappleStreams('690957', 'movie');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'mapple · s2');
});

test('the first front with a row wins without waiting for hung fronts', async (t) => {
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts);
    for (const s of SOURCES) fronts[s] = 'hang';
    fronts.s12 = { delay: 100, mode: 'row' };
    const t0 = Date.now();
    const rows = await getMappleStreams('770906', 'movie');
    const ms = Date.now() - t0;
    assert.equal(rows[0].title, 'mapple · s12');
    assert.ok(ms < 1000, `took ${ms}ms`);
});

test('hung fronts are cut at the front deadline', async (t) => {
    // Front deadline 600-100-100 = 400ms, below every front cap.
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts, {
        PROVIDER_DEADLINE_MS: '600',
        MAPPLE_DEADLINE_MARGIN_MS: '100',
        MAPPLE_FRONT_END_RESERVE_MS: '100',
    });
    for (const s of SOURCES) fronts[s] = 'hang';
    const t0 = Date.now();
    await assert.rejects(getMappleStreams('690957', 'movie'), new RegExp(`all ${SOURCES.length} fronts tried failed`));
    const ms = Date.now() - t0;
    assert.ok(ms >= 350 && ms < 600, `took ${ms}ms`);
});

test('every front erroring throws so the registry records an error', async (t) => {
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts);
    for (const s of SOURCES) fronts[s] = 'error';
    await assert.rejects(getMappleStreams('690957', 'movie'), new RegExp(`all ${SOURCES.length} fronts tried failed, last: fetch failed`));
});

test('every front with no stream returns []', async (t) => {
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts);
    for (const s of SOURCES) fronts[s] = 'empty';
    assert.deepEqual(await getMappleStreams('690957', 'movie'), []);
});

test('errors mixed with no-stream fronts return []', async (t) => {
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts);
    for (const s of SOURCES) fronts[s] = 'empty';
    fronts.mapple = 'error';
    assert.deepEqual(await getMappleStreams('690957', 'movie'), []);
});

test('retryable in-band answers on every front throw, not cache an empty', async (t) => {
    // 2026-11-20, 770906: s2/s10 SOURCE_BUSY, s4/s16/s27/s28 SOURCE_TIMEOUT,
    // s8/s19 SOURCE_COOLDOWN - all 200s that say nothing about the title.
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts);
    for (const s of SOURCES) fronts[s] = 'busy';
    await assert.rejects(getMappleStreams('770906', 'movie'), /fronts tried failed, last: SOURCE_BUSY/);
});

test('retryable answers mixed with a not-here answer return []', async (t) => {
    const fronts = {};
    const { SOURCES, getMappleStreams } = load(t, fronts);
    for (const s of SOURCES) fronts[s] = 'busy';
    fronts.mapple = 'empty';
    assert.deepEqual(await getMappleStreams('770906', 'movie'), []);
});
