'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { PassThrough } = require('stream');
const express = require('express');
const { createProxyRoutes, _pipeUpstream } = require('../proxy/proxyServer');

// VM logs 2026-11-20..24: 104 of 115 `upstream body stalled 25000ms` lines
// followed a `CLIENT ABORTED` on the same ts-proxy#N. The main fetch had no
// client signal, and pipeUpstream registered res.on('close') after the
// response had already closed, so only the 25 s stall watchdog freed the
// upstream socket.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function captureLogs() {
    const lines = [];
    const orig = { log: console.log, warn: console.warn };
    console.log = (...a) => { lines.push(a.join(' ')); };
    console.warn = (...a) => { lines.push(a.join(' ')); };
    return { lines, restore: () => { console.log = orig.log; console.warn = orig.warn; } };
}

test('a client that aborts before upstream headers cancels the main fetch', async () => {
    const open = new Set();
    const origin = http.createServer((req, res) => {
        open.add(res);
        res.on('close', () => open.delete(res));
        // Slow headers: the client is gone before they arrive.
        setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            res.write(Buffer.alloc(1024)); // then go quiet, never end
        }, 400);
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    const cap = captureLogs();
    try {
        const target = `http://127.0.0.1:${origin.address().port}/seg1.ts`;
        const ac = new AbortController();
        const p = fetch(`http://127.0.0.1:${proxy.address().port}/ts-proxy?url=${encodeURIComponent(target)}`,
            { signal: ac.signal }).catch(() => undefined);
        await sleep(100);
        ac.abort();
        await p;
        await sleep(800);
        assert.equal(open.size, 0, 'the upstream request is still open after the client left');
        assert.ok(!cap.lines.some((l) => l.includes('stalled')), 'a client abort was counted as a stall');
    } finally {
        cap.restore();
        for (const res of open) res.destroy();
        proxy.close();
        origin.close();
    }
});

test('pipeUpstream on an already-closed response discards the body at once', async () => {
    const body = new PassThrough();
    const res = new PassThrough();
    res.destroy();
    await sleep(10);
    const cap = captureLogs();
    try {
        _pipeUpstream({ body }, res, 'ts-proxy#test');
    } finally { cap.restore(); }
    assert.ok(body.destroyed, 'the upstream body was left open');
    assert.ok(cap.lines.some((l) => l.includes('[proxy] client gone, upstream cancelled')), cap.lines.join('\n'));
});
