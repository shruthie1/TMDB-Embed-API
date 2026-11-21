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

// ---- provider self-heal Task 9: routes from config ----
// Remote `routes.<provider>` = { web: off|direct|proxy, apk: off|direct|proxy|device,
// hostPatterns?: [{ re: string, web, apk }], hosts?: {...} }. The code words
// none / on-device are accepted too. No remote: today's values.
const selfhealConfig = require('../lib/selfheal/config');
const routesMod = require('../lib/routing/providerRoutes');
function withRemote(t, doc) {
    selfhealConfig.shared._setRemote(doc);
    const warn = console.warn; console.warn = () => {};
    t.after(() => { selfhealConfig.shared._setRemote(null); console.warn = warn; });
}

test('Task 9 (a): no remote: routes and surfaces are the built-in values', () => {
    selfhealConfig.shared._setRemote(null);
    for (const [p, cfg] of Object.entries(PROVIDER_ROUTES)) {
        assert.deepEqual(routeFor(p, 'https://unmatched.example/a.m3u8'), { web: cfg.web, apk: cfg.apk });
    }
    assert.equal(routesMod.surfaceAllows('mapple', 'web'), false);
    assert.equal(routesMod.surfaceAllows('vaplayer', 'web'), false);
    assert.equal(routesMod.surfaceAllows('castletv', 'web'), true);
    assert.equal(routesMod.surfaceOnDevice('vaplayer'), true);
    assert.equal(routesMod.surfaceOnDevice('castletv'), false);
});

test('Task 9 (b): remote vidrock {web:direct, apk:direct} gives direct, also on its built-in vercetti host rule', (t) => {
    withRemote(t, { routes: { vidrock: { web: 'direct', apk: 'direct', hosts: {} } } });
    assert.deepEqual(routeFor('vidrock', 'https://x.nucleardaydream.lol/a.m3u8'), { web: 'direct', apk: 'direct' });
    assert.deepEqual(routeFor('vidrock', 'https://s1.vercetti.org/a.m3u8'), { web: 'direct', apk: 'direct' });
});

test('Task 9 (c): remote castletv {web:off} makes surfaceAllows(castletv, web) false; apk device -> on-device', (t) => {
    withRemote(t, { routes: { castletv: { web: 'off', apk: 'device' } } });
    assert.equal(routesMod.surfaceAllows('castletv', 'web'), false);
    assert.equal(routesMod.surfaceAllows('castletv', null), true);
    assert.equal(routesMod.surfaceOnDevice('castletv'), true);
    // off/device are surface words: the row route keeps the built-in value.
    assert.deepEqual(routeFor('castletv', 'https://img1.hscow.com/a.m3u8'), { web: 'direct', apk: 'direct' });
});

test('Task 9 (d): an invalid value falls back to the built-in, with one log line', (t) => {
    const lines = [];
    withRemote(t, { routes: { castletv: { web: 'fast', apk: 'proxy' }, mapple: { web: 'sometimes' } } });
    console.warn = (...a) => lines.push(a.join(' '));
    assert.deepEqual(routeFor('castletv', 'https://img1.hscow.com/a.m3u8'), { web: 'direct', apk: 'proxy' });
    assert.equal(routesMod.surfaceAllows('mapple', 'web'), false);
    routeFor('castletv', 'https://img1.hscow.com/b.m3u8');
    assert.equal(lines.filter((l) => l.startsWith('[routes] config castletv.web=fast invalid')).length, 1, lines.join('\n'));
});

test('Task 9: remote hostPatterns with `re` as a string; a bad regex is skipped, not thrown', (t) => {
    withRemote(t, { routes: { multimovies: { web: 'proxy', apk: 'direct', hostPatterns: [
        { re: '([', web: 'direct', apk: 'direct' },
        { re: '^dash-hls-bridge\\.newlabel\\.workers\\.dev$', web: 'direct', apk: 'direct' },
    ] } } });
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.newlabel.workers.dev/m.m3u8'), { web: 'direct', apk: 'direct' });
    // The remote list replaced the built-in patterns.
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.john1mc.workers.dev/m.m3u8'), { web: 'proxy', apk: 'direct' });
    // Built-in hosts are kept when the remote names none.
    assert.deepEqual(routeFor('multimovies', 'https://cdn.gzip.rousav.tech/a.m3u8'), { web: 'proxy', apk: 'direct' });
});

test('Task 9: the code words none / on-device are accepted as well', (t) => {
    withRemote(t, { routes: { vaplayer: { web: 'none', apk: 'direct' }, showsst: { apk: 'on-device' } } });
    assert.equal(routesMod.surfaceAllows('vaplayer', 'web'), false);
    assert.equal(routesMod.surfaceOnDevice('vaplayer'), false);
    assert.equal(routesMod.surfaceOnDevice('showsst'), true);
});

// Review M5: an invalid route word inside hostPatterns / hosts keeps the
// built-in value (the built-in host entry, else the provider's built-in
// default) and logs one line, as the header says.
test('M5: invalid route word in hosts/hostPatterns keeps the built-in value, one log line each', (t) => {
    const lines = [];
    withRemote(t, { routes: { multimovies: {
        hostPatterns: [{ re: '^x\\.workers\\.dev$', web: 'fast', apk: 'direct' }],
        hosts: { 'gzip.rousav.tech': { web: 'direct', apk: 'zoom' }, 'new.example': { web: 'nope', apk: 'proxy' } },
    } } });
    console.warn = (...a) => lines.push(a.join(' '));
    // Pattern: web invalid -> multimovies built-in web (proxy); apk valid.
    assert.deepEqual(routeFor('multimovies', 'https://x.workers.dev/m.m3u8'), { web: 'proxy', apk: 'direct' });
    // Known host: apk invalid -> its built-in host entry (apk direct).
    assert.deepEqual(routeFor('multimovies', 'https://gzip.rousav.tech/a.m3u8'), { web: 'direct', apk: 'direct' });
    // New host: web invalid -> provider built-in web (proxy).
    assert.deepEqual(routeFor('multimovies', 'https://new.example/a.m3u8'), { web: 'proxy', apk: 'proxy' });
    routeFor('multimovies', 'https://new.example/b.m3u8');
    for (const k of ['hostPatterns[0].web=fast', 'hosts.gzip.rousav.tech.apk=zoom', 'hosts.new.example.web=nope']) {
        assert.equal(lines.filter((l) => l.startsWith(`[routes] config multimovies.${k} invalid, built-in kept`)).length, 1, `${k}\n${lines.join('\n')}`);
    }
});

// Review M4: a remote regex with nested quantifiers or over 200 chars is
// rejected (catastrophic backtracking guard); the built-in patterns stay.
test('M4: remote hostPatterns.re with nested quantifiers or > 200 chars is rejected, built-in kept, one warning', (t) => {
    const lines = [];
    const long = `^${'a'.repeat(210)}$`;
    withRemote(t, { routes: { multimovies: { hostPatterns: [
        { re: '(a+)+$', web: 'direct', apk: 'direct' },
        { re: '^(\\w*)*\\.dev$', web: 'direct', apk: 'direct' },
        { re: long, web: 'direct', apk: 'direct' },
    ] } } });
    console.warn = (...a) => lines.push(a.join(' '));
    // All remote patterns rejected -> the built-in VidBolt pattern still routes.
    assert.deepEqual(routeFor('multimovies', 'https://dash-hls-bridge.john1mc.workers.dev/m.m3u8'), { web: 'direct', apk: 'direct' });
    const t0 = Date.now();
    assert.deepEqual(routeFor('multimovies', `https://${'a'.repeat(40)}!.example/m.m3u8`), { web: 'proxy', apk: 'direct' });
    assert.ok(Date.now() - t0 < 200, 'no backtracking stall');
    routeFor('multimovies', 'https://other.example/m.m3u8');
    assert.equal(lines.filter((l) => /^\[routes\] config multimovies\.hostPatterns re=.* rejected/.test(l)).length, 3, lines.join('\n'));
});
