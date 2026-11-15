'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// buildCastleDemuxEntry runs on the critical path of every /api/streams call
// (Castle gates NetMirror). Its playlist and probe fetches had no timeout, so
// a Castle CDN that accepted the connection and never answered held the whole
// aggregate response open with it.
process.env.CASTLE_DEMUX_FETCH_TIMEOUT_MS = '300';
const runtime = require('../lib/runtime/environment');
const { buildCastleDemuxEntry } = require('../lib/media/republish');

test('a hanging Castle playlist gives up within the fetch timeout', async (t) => {
    const sockets = new Set();
    const server = http.createServer(() => { /* never respond */ });
    server.on('connection', (s) => { sockets.add(s); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
    const feat = runtime.features.castleDemux;
    Object.defineProperty(runtime.features, 'castleDemux', { value: true, configurable: true, writable: true });
    t.after(() => { runtime.features.castleDemux = feat; });

    const url = `http://127.0.0.1:${server.address().port}/castle.m3u8`;
    const t0 = Date.now();
    const out = await Promise.race([
        buildCastleDemuxEntry([{ provider: 'CastleTV', url }], 'http://localhost'),
        new Promise((r) => setTimeout(() => r('STILL_WAITING'), 3000)),
    ]);
    const ms = Date.now() - t0;
    assert.equal(out, null, `expected null, got ${String(out)} after ${ms}ms`);
    assert.ok(ms < 2000, `took ${ms}ms`);
});
