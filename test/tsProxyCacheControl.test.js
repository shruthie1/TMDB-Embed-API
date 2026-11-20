'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createProxyRoutes } = require('../proxy/proxyServer');

// The Vercel edge caches /ts-proxy by URL and ignores Range. A cacheable 206
// was replayed for a later seek to a different offset (wrong bytes), so a
// NetMirror mp4 could not seek and the switch aborted. Measured 2026-11-20.
const SIZE = 1024 * 1024;
const body = Buffer.alloc(SIZE, 7);

async function withServers(fn) {
    const origin = http.createServer((req, res) => {
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(SIZE), 'Accept-Ranges': 'bytes' });
            return res.end();
        }
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
            res.writeHead(206, {
                'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
                'Content-Range': `bytes ${start}-${end}/${SIZE}`, 'Content-Length': String(end - start + 1),
            });
            return res.end(body.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(SIZE), 'Accept-Ranges': 'bytes' });
        res.end(body);
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    try {
        await fn(`http://127.0.0.1:${origin.address().port}`, `http://127.0.0.1:${proxy.address().port}`);
    } finally {
        proxy.close();
        origin.close();
    }
}

const tsUrl = (proxyBase, target) => `${proxyBase}/ts-proxy?url=${encodeURIComponent(target)}&tailPrefetch=0`;

test('a ranged 206 from ts-proxy is never cacheable by a shared cache', async () => {
    await withServers(async (originBase, proxyBase) => {
        const r = await fetch(tsUrl(proxyBase, `${originBase}/seek.mp4`), { headers: { Range: 'bytes=500000-' } });
        await r.arrayBuffer();
        assert.equal(r.status, 206);
        assert.match(r.headers.get('content-range'), /^bytes 500000-/);
        assert.match(r.headers.get('cache-control'), /no-store/);
        assert.doesNotMatch(r.headers.get('cache-control'), /public/);
    });
});

test('an open bytes=0- request (progressive window) is never cacheable', async () => {
    await withServers(async (originBase, proxyBase) => {
        const r = await fetch(tsUrl(proxyBase, `${originBase}/open.mp4`), { headers: { Range: 'bytes=0-' } });
        await r.arrayBuffer();
        assert.equal(r.status, 206);
        assert.match(r.headers.get('cache-control'), /no-store/);
    });
});

test('a full non-range 200 stays cacheable', async () => {
    await withServers(async (originBase, proxyBase) => {
        const r = await fetch(tsUrl(proxyBase, `${originBase}/seg1.ts`));
        await r.arrayBuffer();
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
    });
});
