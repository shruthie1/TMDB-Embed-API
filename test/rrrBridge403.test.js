'use strict';
// RRR (579974) multimovies 403, 2026-11-21. processStreamsForProxy kept only
// the inner `url` of VidBolt's signed bridge URL, dropping the bridge host and
// its CloudFront Policy/Signature/Key-Pair-Id; CloudFront answered 403
// MissingKey. Only our own proxy shapes may be unwrapped.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const { processStreamsForProxy, createProxyRoutes } = require('../proxy/proxyServer');
const { streamFromMaster } = require('../providers/multimovies');
const { normaliseStream } = require('../utils/streamSchema');

const SERVER = 'https://tmdb.example';
const SACDN = 'https://sacdn.hakunaymatata.com/dash/7499853135079687472_0_0_1080_h265_956/master.m3u8';
const BRIDGE = 'https://dash-hls-bridge.johndoesdmc.workers.dev/?url=' + encodeURIComponent(SACDN)
    + '&Policy=eyJQ&Signature=abc~def_&Key-Pair-Id=KMHN1LQ1HEUPL';

const innerOf = (proxied) => new URL(proxied).searchParams.get('url');
const headersOf = (proxied) => JSON.parse(new URL(proxied).searchParams.get('headers') || '{}');

test('a signed bridge URL is wrapped whole, with every signing param', () => {
    const [row] = processStreamsForProxy([{ url: BRIDGE }], SERVER);
    assert.ok(row.url.startsWith(`${SERVER}/m3u8-proxy?url=`));
    const inner = innerOf(row.url);
    assert.equal(inner, BRIDGE);
    const u = new URL(inner);
    assert.equal(u.hostname, 'dash-hls-bridge.johndoesdmc.workers.dev');
    assert.equal(u.searchParams.get('Policy'), 'eyJQ');
    assert.equal(u.searchParams.get('Signature'), 'abc~def_');
    assert.equal(u.searchParams.get('Key-Pair-Id'), 'KMHN1LQ1HEUPL');
    assert.equal(u.searchParams.get('url'), SACDN);
});

test('our own /m3u8-proxy wrapper unwraps to the upstream and keeps its headers', () => {
    const H = { Referer: 'https://vidrock.net/' };
    const wrapped = `https://other.host/m3u8-proxy?url=${encodeURIComponent('https://up.example/a/master.m3u8?t=1&s=2')}&headers=${encodeURIComponent(JSON.stringify(H))}`;
    const [row] = processStreamsForProxy([{ url: wrapped }], SERVER);
    assert.equal(innerOf(row.url), 'https://up.example/a/master.m3u8?t=1&s=2');
    assert.deepEqual(headersOf(row.url), H);
});

test('row headers win over the wrapper headers', () => {
    const wrapped = `${SERVER}/m3u8-proxy?url=${encodeURIComponent('https://up.example/m.m3u8')}&headers=${encodeURIComponent(JSON.stringify({ Referer: 'old' }))}`;
    const [row] = processStreamsForProxy([{ url: wrapped, headers: { Referer: 'new' } }], SERVER);
    assert.equal(innerOf(row.url), 'https://up.example/m.m3u8');
    assert.deepEqual(headersOf(row.url), { Referer: 'new' });
});

test('our own /ts-proxy and /proxy/<url> wrappers unwrap', () => {
    const ts = `${SERVER}/ts-proxy?url=${encodeURIComponent('https://up.example/v.mp4?sign=1')}`;
    const [a] = processStreamsForProxy([{ url: ts }], SERVER);
    assert.equal(a.url, `${SERVER}/ts-proxy?url=${encodeURIComponent('https://up.example/v.mp4?sign=1')}`);
    const p = `${SERVER}/proxy/${encodeURIComponent('https://up.example/m.m3u8')}`;
    const [b] = processStreamsForProxy([{ url: p }], SERVER);
    assert.equal(innerOf(b.url), 'https://up.example/m.m3u8');
});

test('a plain upstream URL, with or without a url= param, is unchanged', () => {
    for (const plain of [
        'https://up.example/hls/master.m3u8?token=x',
        'https://cdn.example/play?url=https%3A%2F%2Fx.example%2Fa.m3u8&sig=1',
        'https://vidlink.example/proxy/wiwii/abc/master.m3u8',
    ]) {
        const [row] = processStreamsForProxy([{ url: plain }], SERVER);
        assert.equal(innerOf(row.url), plain);
    }
});

const H265_MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="tel",NAME="Telugu",URI="audio_te.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="a",RESOLUTION=1920x800', 'video.m3u8', '',
].join('\n');

test('multimovies: an _h265_ master (bridge-wrapped) is tagged videoCodec hevc', () => {
    const row = streamFromMaster({ quality: '1080p' }, H265_MASTER, BRIDGE);
    assert.equal(row.videoCodec, 'hevc');
    assert.equal(normaliseStream(row).videoCodec, 'hevc');
    const bare = streamFromMaster({ quality: '1080p' }, H265_MASTER, SACDN);
    assert.equal(bare.videoCodec, 'hevc');
});

test('multimovies: a master without _h265_ or CODECS stays unknown', () => {
    const row = streamFromMaster({ quality: '1080p' }, H265_MASTER, 'https://img.example/media/abc/index.m3u8');
    assert.equal(row.videoCodec ?? null, null);
});

test('ts-proxy: an upstream 403 logs one greppable line with host, path, ct, server, body head', async () => {
    const body = '<?xml version="1.0"?><Error><Code>MissingKey</Code><Message>Missing Key-Pair-Id</Message></Error>' + 'x'.repeat(400);
    const origin = http.createServer((req, res) => {
        res.writeHead(403, { 'Content-Type': 'text/xml', Server: 'CloudFront' });
        res.end(body);
    });
    await new Promise((r) => origin.listen(0, '127.0.0.1', r));
    const app = express();
    createProxyRoutes(app);
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((r) => proxy.once('listening', r));
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
        const target = `http://127.0.0.1:${origin.address().port}/seg/a1/9.ts?Signature=SECRET&Key-Pair-Id=K`;
        const r = await fetch(`http://127.0.0.1:${proxy.address().port}/ts-proxy?url=${encodeURIComponent(target)}&tailPrefetch=0`);
        await r.arrayBuffer();
        assert.equal(r.status, 403);
    } finally {
        console.log = orig;
        proxy.close();
        origin.close();
    }
    const hits = lines.filter((l) => l.includes('[ts-proxy-403]'));
    assert.equal(hits.length, 1, lines.join('\n'));
    const line = hits[0];
    assert.match(line, /host=127\.0\.0\.1:\d+/);
    assert.match(line, /path=\/seg\/a1\/9\.ts /);
    assert.match(line, /status=403/);
    assert.match(line, /ct=text\/xml/);
    assert.match(line, /server=CloudFront/);
    assert.match(line, /MissingKey/);
    assert.doesNotMatch(line, /SECRET|Key-Pair-Id=K/);
    const bodyPart = /body=(.*)$/.exec(line)[1];
    assert.ok(JSON.parse(bodyPart).length <= 200);
});
