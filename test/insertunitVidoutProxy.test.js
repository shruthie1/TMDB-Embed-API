'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const dns = require('node:dns');
const express = require('express');
const { createProxyRoutes, inferContentType } = require('../proxy/proxyServer');
const { lookupWithFallback } = require('../utils/dnsFallback');

// VIDOUT segments are MPEG-TS named .woff2 (seg-200-f1-a4.woff2, 129720 B,
// `video/MP2T`, first byte 0x47; VM 2026-11-24). The proxy must stream them
// whole like any playlist segment: no HEAD, no bytes=0-0 probe.
test('ts-proxy: a .woff2 playlist segment is fetched whole, no HEAD or probe, mp2t type kept', async () => {
    const seen = [];
    const body = Buffer.alloc(188 * 50, 0x47);
    const origin = http.createServer((req, res) => {
        seen.push({ method: req.method, range: req.headers.range || null, referer: req.headers.referer || null });
        res.writeHead(200, { 'Content-Type': 'video/MP2T', 'Content-Length': String(body.length) });
        res.end(req.method === 'HEAD' ? undefined : body);
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    try {
        const target = `http://127.0.0.1:${origin.address().port}/Qt9/hls3/seg-200-f1-a4.woff2`;
        const headers = encodeURIComponent(JSON.stringify({ Referer: 'https://vidout.pages.dev/' }));
        const r = await fetch(`http://127.0.0.1:${proxy.address().port}/ts-proxy?url=${encodeURIComponent(target)}&headers=${headers}&seg=1`);
        const got = Buffer.from(await r.arrayBuffer());
        assert.equal(r.status, 200);
        assert.equal(got.length, body.length);
        assert.match(r.headers.get('content-type'), /video\/mp2t/i);
        assert.deepStrictEqual(seen.map((s) => s.method), ['GET']);
        assert.equal(seen[0].range, null);
        assert.equal(seen[0].referer, 'https://vidout.pages.dev/');
    } finally {
        proxy.close();
        origin.close();
    }
});

test('inferContentType: a segment labelled as a font is a media segment', () => {
    assert.equal(inferContentType('video/MP2T', 'https://h/seg-1.woff2'), 'video/MP2T');
    assert.equal(inferContentType('font/woff2', 'https://h/seg-1.woff2'), 'video/mp2t');
});

// VM1 2026-11-24: getaddrinfo ENOTFOUND for a DNAME'd host that resolve4 answers.
test('lookupWithFallback: ENOTFOUND from the system resolver falls back to resolve4', async () => {
    const realLookup = dns.lookup;
    dns.lookup = (h, o, cb) => { const e = new Error(`getaddrinfo ENOTFOUND ${h}`); e.code = 'ENOTFOUND'; cb(e); };
    lookupWithFallback._resolve4 = (h, cb) => cb(null, ['67.159.10.2']);
    try {
        const one = await new Promise((res, rej) => lookupWithFallback('ghzbfjzbazc.interkh.com', {}, (e, a, f) => (e ? rej(e) : res([a, f]))));
        assert.deepStrictEqual(one, ['67.159.10.2', 4]);
        const all = await new Promise((res, rej) => lookupWithFallback('ghzbfjzbazc.interkh.com', { all: true }, (e, a) => (e ? rej(e) : res(a))));
        assert.deepStrictEqual(all, [{ address: '67.159.10.2', family: 4 }]);
        lookupWithFallback._resolve4 = (h, cb) => { const e = new Error('nx'); e.code = 'ENOTFOUND'; cb(e); };
        await assert.rejects(new Promise((res, rej) => lookupWithFallback('nope.invalid', {}, (e, a) => (e ? rej(e) : res(a)))), /ENOTFOUND nope\.invalid/);
    } finally {
        dns.lookup = realLookup;
        delete lookupWithFallback._resolve4;
    }
});

test('lookupWithFallback: a name the system resolves is untouched', async () => {
    const realLookup = dns.lookup;
    dns.lookup = (h, o, cb) => cb(null, '10.0.0.1', 4);
    lookupWithFallback._resolve4 = () => { throw new Error('must not be called'); };
    try {
        const one = await new Promise((res, rej) => lookupWithFallback('ok.example', {}, (e, a) => (e ? rej(e) : res(a))));
        assert.equal(one, '10.0.0.1');
    } finally {
        dns.lookup = realLookup;
        delete lookupWithFallback._resolve4;
    }
});

test('proxy agents use the fallback lookup', () => {
    const { _agents } = require('../proxy/proxyServer');
    assert.equal(_agents.https.options.lookup, lookupWithFallback);
    assert.equal(_agents.http.options.lookup, lookupWithFallback);
});
