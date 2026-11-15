'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicBase } = require('../lib/runtime/publicBase');

const req = (protocol, host) => ({ protocol, get: (h) => (h === 'host' ? host : undefined) });

function withEnv(value, fn) {
    const prev = process.env.PUBLIC_BASE_URL;
    if (value === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = value;
    try { return fn(); } finally {
        if (prev === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = prev;
    }
}

test('unset: exactly the request-derived base the call sites used before', () => {
    withEnv(undefined, () => {
        assert.equal(publicBase(req('http', 'localhost:8790')), 'http://localhost:8790');
    });
});

test('set: an https public origin wins over an http request behind a proxy', () => {
    withEnv('https://api.example.com', () => {
        assert.equal(publicBase(req('http', '127.0.0.1:8787')), 'https://api.example.com');
    });
});

test('trailing slashes are dropped so joined paths never get "//"', () => {
    withEnv('https://api.example.com//', () => {
        assert.equal(`${publicBase(req('http', 'x'))}/hybrid/1/master.m3u8`,
            'https://api.example.com/hybrid/1/master.m3u8');
    });
});

test('a blank value is treated as unset', () => {
    withEnv('   ', () => {
        assert.equal(publicBase(req('http', 'h:1')), 'http://h:1');
    });
});

test('the proxy can still pass its own forwarded protocol', () => {
    withEnv(undefined, () => {
        assert.equal(publicBase(req('http', 'h:1'), 'https'), 'https://h:1');
    });
});

test('no call site builds a base from the request any more', () => {
    const fs = require('fs');
    const path = require('path');
    const files = ['apiServer.js', 'lib/media/hybridRoutes.js', 'lib/media/republish.js', 'proxy/proxyServer.js'];
    for (const f of files) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.ok(!/:\/\/\$\{req\.get\('host'\)\}/.test(src), `${f} still derives a base from req host`);
    }
});

test('both stream routes route header-gated streams for the browser', () => {
    // The per-provider route (/api/streams/:provider/...) used to return a
    // NetMirror mp4 as its raw CDN url, which the CDN refuses without a
    // Referer. Both routes must go through the one shared routing step.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'apiServer.js'), 'utf8');
    const agg = src.indexOf("app.get('/api/streams/:type/:tmdbId'");
    const per = src.indexOf("app.get('/api/streams/:provider/:type/:tmdbId'");
    assert.ok(agg > 0 && per > 0);
    const aggBody = src.slice(agg, per);
    const perBody = src.slice(per, src.indexOf('\n});', per));
    assert.match(aggBody, /routeStreamsForBrowser\(/);
    assert.match(perBody, /routeStreamsForBrowser\(/);
});
