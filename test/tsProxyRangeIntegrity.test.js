'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { createProxyRoutes } = require('../proxy/proxyServer');

// Byte-range integrity for /ts-proxy. A seek after a source switch once got
// another range's bytes, because a URL-keyed edge cache replayed a cacheable
// 206. These tests check the bytes, not only the headers, at two layers:
// the proxy itself, and the proxy behind a shared cache that keys on URL only.

const SIZE = 64 * 1024;
// Byte i is a known value. Different offsets give different bytes.
const body = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) body[i] = (i * 31 + (i >> 8)) & 0xff;

function startOrigin() {
    const origin = http.createServer((req, res) => {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (req.method === 'HEAD' || !m) {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(SIZE), 'Accept-Ranges': 'bytes' });
            return res.end(req.method === 'HEAD' ? undefined : body);
        }
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
        res.writeHead(206, {
            'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${SIZE}`, 'Content-Length': String(end - start + 1),
        });
        res.end(body.subarray(start, end + 1));
    });
    return new Promise((r) => origin.listen(0, '127.0.0.1', () => r(origin)));
}

function startProxy() {
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    return new Promise((r) => proxy.once('listening', () => r(proxy)));
}

// Shared cache that behaves like a CDN edge which ignores Range: the key is the
// URL only. It stores a response when Cache-Control allows a shared cache.
function startUrlKeyedCache(upstreamBase) {
    const store = new Map();
    const cache = http.createServer(async (req, res) => {
        const hit = store.get(req.url);
        if (hit) {
            res.writeHead(hit.status, { ...hit.headers, 'x-test-cache': 'HIT' });
            return res.end(hit.body);
        }
        const headers = {};
        if (req.headers.range) headers.Range = req.headers.range;
        const r = await fetch(upstreamBase + req.url, { headers });
        const buf = Buffer.from(await r.arrayBuffer());
        const out = {};
        for (const k of ['content-type', 'content-range', 'accept-ranges', 'cache-control']) {
            const v = r.headers.get(k);
            if (v) out[k] = v;
        }
        out['content-length'] = String(buf.length);
        const cc = r.headers.get('cache-control') || '';
        if (/public|s-maxage|max-age/.test(cc) && !/no-store|private/.test(cc)) {
            store.set(req.url, { status: r.status, headers: out, body: buf });
        }
        res.writeHead(r.status, { ...out, 'x-test-cache': 'MISS' });
        res.end(buf);
    });
    return new Promise((r) => cache.listen(0, '127.0.0.1', () => r(cache)));
}

async function withStack(fn) {
    const origin = await startOrigin();
    const proxy = await startProxy();
    const cache = await startUrlKeyedCache(`http://127.0.0.1:${proxy.address().port}`);
    try {
        await fn({
            originBase: `http://127.0.0.1:${origin.address().port}`,
            proxyBase: `http://127.0.0.1:${proxy.address().port}`,
            cacheBase: `http://127.0.0.1:${cache.address().port}`,
        });
    } finally {
        cache.close();
        proxy.close();
        origin.close();
    }
}

const tsPath = (target) => `/ts-proxy?url=${encodeURIComponent(target)}&tailPrefetch=0`;

async function getRange(base, path, start, end) {
    const r = await fetch(base + path, { headers: { Range: `bytes=${start}-${end}` } });
    const bytes = Buffer.from(await r.arrayBuffer());
    return { r, bytes };
}

function assertRange({ r, bytes }, start, end, label) {
    assert.equal(r.status, 206, `${label}: status`);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${SIZE}`, `${label}: Content-Range`);
    assert.equal(bytes.length, end - start + 1, `${label}: length`);
    assert.ok(bytes.equals(body.subarray(start, end + 1)), `${label}: bytes differ from origin slice ${start}-${end}`);
}

const RANGES = [
    [0, 9],
    [500, 509],
    [32768, 32799],
    [SIZE - 16, SIZE - 1],
];

test('known sequence: the ranges under test have different bytes', () => {
    const [a, b] = RANGES;
    assert.ok(!body.subarray(a[0], a[1] + 1).equals(body.subarray(b[0], b[1] + 1)));
});

test('proxy returns the exact bytes for each different range on the same url', async () => {
    await withStack(async ({ originBase, proxyBase }) => {
        const path = tsPath(`${originBase}/same.mp4`);
        for (const [start, end] of RANGES) {
            const got = await getRange(proxyBase, path, start, end);
            assertRange(got, start, end, `proxy ${start}-${end}`);
            assert.match(got.r.headers.get('cache-control') || '', /no-store/, `proxy ${start}-${end}: no-store`);
            assert.doesNotMatch(got.r.headers.get('cache-control') || '', /public/, `proxy ${start}-${end}: not public`);
        }
    });
});

test('seek regression: range B after range A on the same url gets B bytes through a URL-keyed cache', async () => {
    await withStack(async ({ originBase, cacheBase }) => {
        const path = tsPath(`${originBase}/seek.mp4`);
        const a = await getRange(cacheBase, path, 0, 9);
        assertRange(a, 0, 9, 'range A');
        const b = await getRange(cacheBase, path, 500, 509);
        assert.ok(!b.bytes.equals(a.bytes), 'range B returned the bytes of range A (cached 206 replayed)');
        assertRange(b, 500, 509, 'range B');
        const c = await getRange(cacheBase, path, 32768, 32799);
        assertRange(c, 32768, 32799, 'range C');
        for (const x of [a, b, c]) assert.equal(x.r.headers.get('x-test-cache'), 'MISS', 'a 206 was served from the shared cache');
    });
});
