'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createProxyRoutes } = require('../proxy/proxyServer');

// An origin that ignores Range answers the ts-proxy size probe (bytes=0-0)
// with the WHOLE file. The proxy only wanted the headers; leaving that body
// unread kept the pooled socket checked out until the origin gave up.
// Prod 2026-11-19: `[pool] active=16 queued=0 free=0` for 8+ hours with no
// viewers, until a restart.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a probe answered with a full 200 body is released, not left holding a socket', async () => {
    const open = new Set();
    const origin = http.createServer((req, res) => {
        if (req.method === 'HEAD') { res.statusCode = 405; return res.end(); }
        if (req.headers.range) {
            // Ignore the range: stream a large body until the client stops reading.
            open.add(res);
            res.on('close', () => open.delete(res));
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            const chunk = Buffer.alloc(256 * 1024);
            let sent = 0;
            const pump = () => {
                while (sent < 256 && res.write(chunk)) sent += 1;
                if (sent < 256) res.once('drain', pump); else res.end();
            };
            return pump();
        }
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '2' });
        res.end('ok');
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    try {
        const target = `http://127.0.0.1:${origin.address().port}/film.mp4`;
        const r = await fetch(`http://127.0.0.1:${proxy.address().port}/ts-proxy?url=${encodeURIComponent(target)}&tailPrefetch=0`);
        await r.arrayBuffer();
        await sleep(500);
        assert.equal(open.size, 0, 'the probe response is still open on the origin');
    } finally {
        for (const res of open) res.destroy();
        proxy.close();
        origin.close();
    }
});

test('a viewer who hangs up mid-segment releases the upstream connection', async () => {
    const open = new Set();
    const origin = http.createServer((req, res) => {
        open.add(res);
        res.on('close', () => open.delete(res));
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        const chunk = Buffer.alloc(256 * 1024);
        let sent = 0;
        const pump = () => {
            while (sent < 256 && res.write(chunk)) sent += 1;
            if (sent < 256) res.once('drain', pump); else res.end();
        };
        pump();
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    try {
        const target = `http://127.0.0.1:${origin.address().port}/seg1.ts`;
        const ac = new AbortController();
        const r = await fetch(`http://127.0.0.1:${proxy.address().port}/ts-proxy?url=${encodeURIComponent(target)}`,
            { signal: ac.signal });
        const reader = r.body.getReader();
        await reader.read();
        ac.abort();
        await sleep(500);
        assert.equal(open.size, 0, 'the upstream segment is still being held open');
    } finally {
        for (const res of open) res.destroy();
        proxy.close();
        origin.close();
    }
});
