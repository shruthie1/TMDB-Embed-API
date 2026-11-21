// R4 (routing-matrix.md): rewritten media playlists were 8x-198x the upstream.
// Each segment line repeated the full upstream url, URL-encoded, plus the
// row's headers as URL-encoded JSON (Castle: ~580 of ~740 bytes per line).
// Segment lines now carry a short header token `h=` and a lightly encoded
// url. Fixtures are real captures (2026-11-21, Animal 781732, local API).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const qs = require('qs');

const tokensFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'htok-')), 'tokens.json');
process.env.PROXY_HEADER_TOKENS_FILE = tokensFile;
const { rewriteM3u8, createProxyRoutes } = require('../proxy/proxyServer');
const headerTokens = require('../lib/routing/headerTokens');

const FX = path.join(__dirname, 'fixtures', 'playlists');
const BASE = 'https://chitram-vm.example';
const cases = [
    { name: 'castletv', file: 'castletv-720-media.m3u8', target: 'https://img1.hscow.com/hls_mps/244461588/720/index_287.m3u8?Expires=1&KeyName=k&Signature=s', maxRatio: 2.0 },
    { name: 'multimovies', file: 'multimovies-bridge-media.m3u8', target: 'https://dash-hls-bridge.johndoesjkc.workers.dev/?url=x', maxRatio: 1.2 },
];
const urlLines = (t) => t.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const mapUris = (t) => t.split('\n').filter((l) => l.startsWith('#EXT-X-MAP:')).map((l) => l.match(/URI="([^"]+)"/)[1]);

for (const c of cases) {
    const src = fs.readFileSync(path.join(FX, c.file), 'utf8');
    const headers = JSON.parse(fs.readFileSync(path.join(FX, `${c.name}-headers.json`), 'utf8'));

    test(`${c.name}: rewritten playlist <= ${c.maxRatio}x upstream bytes`, () => {
        const out = rewriteM3u8(src, c.target, BASE, headers);
        const ratio = Buffer.byteLength(out) / Buffer.byteLength(src);
        console.log(`[size] ${c.name} upstream=${Buffer.byteLength(src)} rewritten=${Buffer.byteLength(out)} ratio=${ratio.toFixed(2)}`);
        assert.ok(ratio <= c.maxRatio, `ratio ${ratio.toFixed(2)}`);
    });

    test(`${c.name}: every segment/map url decodes to the exact upstream url and headers`, () => {
        const out = rewriteM3u8(src, c.target, BASE, headers);
        const srcUrls = [...mapUris(src), ...urlLines(src)].map((l) => new URL(l, c.target).href);
        const outUrls = [...mapUris(out), ...urlLines(out)];
        assert.equal(outUrls.length, srcUrls.length);
        outUrls.forEach((line, i) => {
            const u = new URL(line);
            assert.equal(u.pathname, '/ts-proxy');
            // WHATWG parse (browsers, our own unwrap) and qs (express req.query).
            assert.equal(u.searchParams.get('url'), srcUrls[i]);
            const q = qs.parse(u.search.slice(1));
            assert.equal(q.url, srcUrls[i]);
            assert.equal(q.headers, undefined);
            assert.deepEqual(headerTokens.get(q.h), headers);
        });
    });
}

test('relative segment lines resolve against the playlist url', () => {
    const media = '#EXTM3U\n#EXTINF:4,\nseg 1.ts?a=1&b=2+3\n#EXTINF:4,\n../x/seg%202.ts#frag\n#EXT-X-ENDLIST';
    const target = 'https://cdn.example/p/q/media.m3u8?sig=abc';
    const out = rewriteM3u8(media, target, BASE, { Referer: 'https://r/' });
    const [a, b] = urlLines(out);
    assert.equal(qs.parse(new URL(a).search.slice(1)).url, new URL('seg 1.ts?a=1&b=2+3', target).href);
    assert.equal(qs.parse(new URL(b).search.slice(1)).url, new URL('../x/seg%202.ts#frag', target).href);
});

test('header tokens survive a restart (persisted) and are stable per header set', () => {
    const h = { Referer: 'https://persist.example/' };
    const id = headerTokens.put(h);
    assert.equal(headerTokens.put({ ...h }), id);
    assert.ok(id.length <= 16);
    const saved = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
    assert.deepEqual(saved[id], h);
    headerTokens._resetForTest();
    assert.deepEqual(headerTokens.get(id), h);
});

test('no headers -> no token param', () => {
    const out = rewriteM3u8('#EXTM3U\n#EXTINF:4,\nhttps://c.example/a.ts', 'https://c.example/m.m3u8', BASE, {});
    assert.doesNotMatch(urlLines(out)[0], /[?&]h=/);
});

// End to end through express: the token line fetches the right bytes with
// the right headers; the legacy `headers=` line (held by a client mid-session
// across the deploy) still works; an unknown token is a clear 410.
test('ts-proxy serves token lines and legacy lines byte-identically', async (t) => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    const seen = [];
    const upstream = http.createServer((req, res) => {
        seen.push({ url: req.url, referer: req.headers.referer });
        if (req.headers.referer !== 'https://ref.example/') { res.statusCode = 403; return res.end('no'); }
        res.setHeader('Content-Type', 'video/mp2t');
        res.end(body);
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const up = `http://127.0.0.1:${upstream.address().port}`;
    const express = require('express');
    const app = express();
    createProxyRoutes(app);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const me = `http://127.0.0.1:${srv.address().port}`;
    t.after(() => { upstream.close(); srv.close(); });

    const H = { Referer: 'https://ref.example/' };
    const segUrl = `${up}/v/seg-1.ts?sig=a/b=c&x=1`;
    const out = rewriteM3u8(`#EXTM3U\n#EXTINF:4,\n${segUrl}`, `${up}/v/m.m3u8`, me, H);
    const tokenLine = urlLines(out)[0];
    const legacyLine = `${me}/ts-proxy?url=${encodeURIComponent(segUrl)}&headers=${encodeURIComponent(JSON.stringify(H))}&seg=1`;
    for (const line of [tokenLine, legacyLine]) {
        const r = await fetch(line);
        assert.equal(r.status, 200, line);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), body);
    }
    assert.ok(seen.every((s) => s.url === '/v/seg-1.ts?sig=a/b=c&x=1' && s.referer === 'https://ref.example/'), JSON.stringify(seen));
    const bad = await fetch(`${me}/ts-proxy?url=${encodeURIComponent(segUrl + '&n=2')}&h=zzzzzzzzzzzz&seg=1`);
    assert.equal(bad.status, 410);
});
