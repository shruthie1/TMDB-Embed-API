'use strict';
// segmentVerify's byte check on VM1: a host the system resolver cannot look up
// (interkh.com DNAME, utils/dnsFallback.js) failed with "network fetch failed",
// so the Insertunit row got byteCheck ok:false and sank in its language group.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const dnsFallback = require('../utils/dnsFallback');
const segmentVerify = require('../lib/media/segmentVerify');

function serve(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
    });
}

function notFound() {
    return async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }); };
}

test('fetchWithFallback: a name the system cannot look up is fetched through resolve4', async () => {
    const s = await serve((req, res) => { res.setHeader('content-type', 'text/plain'); res.end(`ua=${req.headers['user-agent']}`); });
    const port = s.address().port;
    dnsFallback.lookupWithFallback._resolve4 = (h, cb) => cb(null, ['127.0.0.1']);
    dnsFallback.fetchWithFallback._primary = notFound();
    try {
        const r = await dnsFallback.fetchWithFallback(`http://nohost.invalid:${port}/x`, { headers: { 'User-Agent': 'page-ua' } });
        assert.equal(r.status, 200);
        assert.equal(await r.text(), 'ua=page-ua');
    } finally {
        delete dnsFallback.lookupWithFallback._resolve4;
        delete dnsFallback.fetchWithFallback._primary;
        s.close();
    }
});

test('fetchWithFallback: any other error is not retried', async () => {
    let calls = 0;
    dnsFallback.fetchWithFallback._primary = async () => { calls++; throw new TypeError('fetch failed'); };
    try {
        await assert.rejects(dnsFallback.fetchWithFallback('http://x.test/', {}), /fetch failed/);
        assert.equal(calls, 1);
    } finally { delete dnsFallback.fetchWithFallback._primary; }
});

test('segmentVerify: the default fetch verifies a TS segment on a host only resolve4 knows', async () => {
    const seg = Buffer.alloc(188 * 200); for (let i = 0; i < 200; i++) seg[i * 188] = 0x47;
    const s = await serve((req, res) => {
        if (req.headers['user-agent'] !== 'page-ua') { res.statusCode = 410; return res.end(); }
        if (req.url.startsWith('/master')) { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n/v.m3u8\n'); }
        if (req.url.startsWith('/v.m3u8')) { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); return res.end('#EXTM3U\n#EXTINF:6,\n/s0.ts\n#EXT-X-ENDLIST\n'); }
        res.setHeader('content-type', 'video/mp2t'); res.end(seg);
    });
    const port = s.address().port;
    dnsFallback.lookupWithFallback._resolve4 = (h, cb) => cb(null, ['127.0.0.1']);
    dnsFallback.fetchWithFallback._primary = notFound();
    try {
        const v = await segmentVerify.verifyOne({ url: `http://nohost.invalid:${port}/master.m3u8`, container: 'hls', headers: { 'User-Agent': 'page-ua' } }, { attemptMs: 4000 });
        assert.deepStrictEqual(v.ok, true, JSON.stringify(v));
    } finally {
        delete dnsFallback.lookupWithFallback._resolve4;
        delete dnsFallback.fetchWithFallback._primary;
        s.close();
    }
});
