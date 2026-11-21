// Per-provider routing config (routing-matrix.md, owner 2026-11-21):
// "use proxy only when required, else route directly, which plays faster;
// maintain at provider config level whether the proxy is required."
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeFor, routeStreams, PROVIDER_ROUTES } = require('../lib/routing/providerRoutes');
const { processStreamsForProxy } = require('../proxy/proxyServer');

const SERVER = 'https://vm.example';
const H = { Referer: 'https://x.example/', 'User-Agent': 'UA' };

test('routeFor: matrix values per provider', () => {
    assert.deepEqual(routeFor('CastleTV', 'https://img1.hscow.com/a.m3u8'), { web: 'direct', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.johndoesdmc.workers.dev/m.m3u8?url=x'), { web: 'direct', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.john1mc.workers.dev/?url=x'), { web: 'direct', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://cdn.gzip.rousav.tech/a.m3u8'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('OneTouchTV', 'https://akm-cdn-play.hitv.ltd/a.m3u8'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('showsst', 'https://a.surrealviews.com/v.mp4'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('NetMirror', 'https://bcdnxw.hakunaymatata.com/v.mp4'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('vidrock', 'https://x.nucleardaydream.lol/a.m3u8'), { web: 'proxy', apk: 'proxy' });
    assert.deepEqual(routeFor('vidrock', 'https://s1.vercetti.org/a.m3u8'), { web: 'proxy', apk: 'proxy' });
});

test('routeFor: unknown provider or bad url -> proxy both (safe default)', () => {
    assert.deepEqual(routeFor('someNewProvider', 'https://a.b/c.m3u8'), { web: 'proxy', apk: 'proxy' });
    assert.deepEqual(routeFor(undefined, 'https://a.b/c.m3u8'), { web: 'proxy', apk: 'proxy' });
    assert.deepEqual(routeFor('CastleTV', 'not a url'), { web: 'direct', apk: 'direct' });
});

test('routeFor: host suffix matches on a dot boundary only', () => {
    // evilrousav.tech must not inherit gzip.rousav.tech's entry.
    assert.deepEqual(routeFor('multimovies', 'https://gzip.rousav.tech/a.m3u8'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.johndoesdmc.workers.dev.evil.com/a'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://evilworkers.dev/a'), { web: 'proxy', apk: 'direct' });
    // Only the measured VidBolt bridge labels, not any Cloudflare worker.
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.johndoesjkc.workers.dev/?url=x'), { web: 'direct', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://someone-else.workers.dev/a.m3u8'), { web: 'proxy', apk: 'direct' });
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.stranger.workers.dev/a'), { web: 'proxy', apk: 'direct' });
});

test('config values are only direct|proxy', () => {
    for (const [name, r] of Object.entries(PROVIDER_ROUTES)) {
        for (const v of [r.web, r.apk, ...Object.values(r.hosts || {}).flatMap((h) => [h.web, h.apk]),
            ...(r.hostPatterns || []).flatMap((h) => [h.web, h.apk])]) {
            assert.ok(v === 'direct' || v === 'proxy', `${name}: ${v}`);
        }
    }
});

function route(streams, enableProxy = false) {
    const remembered = [];
    const out = routeStreams(streams, SERVER, {
        enableProxy, processStreamsForProxy, rememberStreams: (s) => remembered.push(...s),
    });
    return { out, remembered };
}

test('web+apk-direct row keeps proxied url and gains directUrl, directHeaders, route', () => {
    const row = { url: 'https://img1.hscow.com/v/a.m3u8', provider: 'CastleTV', headers: H, languages: ['Telugu', 'Hindi'], audio: [{ language: 'te' }] };
    const { out, remembered } = route([row]);
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0].url, row.url);
    const r = out[0];
    assert.match(r.url, /^https:\/\/vm\.example\/m3u8-proxy\?url=/);
    assert.equal(r.directUrl, row.url);
    assert.deepEqual(r.directHeaders, H);
    assert.deepEqual(r.route, { web: 'direct', apk: 'direct' });
    assert.equal(r.headers, undefined);
    assert.deepEqual(r.languages, ['Telugu', 'Hindi']);
    assert.deepEqual(r.audio, [{ language: 'te' }]);
});

test('apk-only direct row (showsst) also carries directUrl; route says web proxy', () => {
    const row = { url: 'https://a.surrealviews.com/v.mp4#.mp4', provider: 'showsst', headers: H, languages: [] };
    const r = route([row]).out[0];
    assert.match(r.url, /\/ts-proxy\?url=/);
    assert.equal(r.directUrl, row.url);
    assert.deepEqual(r.route, { web: 'proxy', apk: 'direct' });
});

test('proxy-both row (vidrock, unknown) gets no direct fields', () => {
    for (const provider of ['vidrock', 'mystery']) {
        const r = route([{ url: 'https://s1.vercetti.org/a.m3u8', provider, headers: H }]).out[0];
        assert.match(r.url, /m3u8-proxy/);
        assert.equal(r.directUrl, undefined);
        assert.equal(r.directHeaders, undefined);
        assert.deepEqual(r.route, { web: 'proxy', apk: 'proxy' });
    }
});

test('headerless row stays direct and untouched (enableProxy off)', () => {
    const row = { url: 'https://plain.example/a.m3u8', provider: 'vidrock', languages: ['Telugu'] };
    const r = route([row]).out[0];
    assert.deepEqual(r, row);
});

test('__noProxy synthetic master is never wrapped and gets no direct fields', () => {
    const row = { url: `${SERVER}/hybrid/abc/master.m3u8`, provider: 'CastleTV', headers: H, __noProxy: true };
    const r = route([row]).out[0];
    assert.equal(r.url, row.url);
    assert.equal(r.directUrl, undefined);
    assert.equal(r.__noProxy, undefined);
});

test('a row already wrapped in our proxy unwraps to the upstream for directUrl', () => {
    const inner = 'https://img1.hscow.com/v/a.m3u8';
    const wrapped = `https://other.example/m3u8-proxy?url=${encodeURIComponent(inner)}&headers=${encodeURIComponent(JSON.stringify(H))}`;
    const r = route([{ url: wrapped, provider: 'CastleTV' }], true).out[0];
    assert.equal(r.directUrl, inner);
    assert.deepEqual(r.directHeaders, H);
});

test('enableProxy on: every row proxied, direct fields still follow the config', () => {
    const { out } = route([
        { url: 'https://img1.hscow.com/a.m3u8', provider: 'CastleTV' },
        { url: 'https://s1.vercetti.org/a.m3u8', provider: 'vidrock', headers: H },
    ], true);
    assert.match(out[0].url, /m3u8-proxy/);
    assert.equal(out[0].directUrl, 'https://img1.hscow.com/a.m3u8');
    assert.deepEqual(out[0].directHeaders, {});
    assert.equal(out[1].directUrl, undefined);
    assert.equal(out[1].headers, undefined);
});

test('apiServer delegates to the config module (no "has headers -> proxy" rule left)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'apiServer.js'), 'utf8');
    const start = src.indexOf('function routeStreamsForBrowser(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /routeStreams\(/);
    assert.doesNotMatch(body, /needsHeaders/);
});
