'use strict';
// Part B items 1, 3, 8: the MultiMovies hub page reader (lib/mmhub/page.js).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const page = require('../lib/mmhub/page');
const state = require('../lib/mmhub/state');

const FX = path.join(__dirname, 'fixtures', 'mmhub');
const TITLE = fs.readFileSync(path.join(FX, 'rrr-title.html'), 'utf8');
const SEARCH = fs.readFileSync(path.join(FX, 'search-rrr.html'), 'utf8');
const SITE = 'https://m1.multimovies.courses';

function fakeFetch(routes, calls = []) {
    return async (url, opts = {}) => {
        calls.push({ url, opts });
        const hit = routes[url];
        if (hit instanceof Error) throw hit;
        const status = hit === undefined ? 404 : (typeof hit === 'object' ? hit.status : 200);
        const body = typeof hit === 'object' && hit ? (hit.body || '') : (hit || 'not found');
        return { status, ok: status >= 200 && status < 300, headers: new Map(), text: async () => body };
    };
}

const deps = (fetch, extra = {}) => ({ fetch, site: SITE, details: async () => ({ title: 'RRR', year: '2022' }),
    sampleDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sample-')), ...extra });

beforeEach(() => { page._reset(); state._reset(); });

test('watchConfig: default pattern finds the servers on the saved RRR page', () => {
    const r = page.parseServers(TITLE, page.DEFAULTS);
    assert.strictEqual(r.servers.length, 6);
    assert.deepStrictEqual(r.servers.map((s) => s.name), ['Cineverse', 'GD mirror', 'Nexus', 'Vidrift', 'VIDOUT', 'Vidbolt']);
    assert.strictEqual(r.pattern, 0);
});

test('watchConfig: ordered fallback pattern used when the first stops matching', () => {
    const moved = TITLE.replace('const watchConfig =', 'window.watchConfig =');
    const r = page.parseServers(moved, page.DEFAULTS);
    assert.strictEqual(r.servers.length, 6);
    assert.ok(r.pattern > 0);
});

test('watchConfig: patterns come from config before code defaults', () => {
    const renamed = TITLE.replace('const watchConfig =', 'const playerCfg =').replace('"initialServers"', '"servers"');
    assert.strictEqual(page.parseServers(renamed, page.DEFAULTS), null);
    const cfg = { ...page.DEFAULTS, watchConfigPatterns: ['const\\s+playerCfg\\s*=\\s*\\{'], serverListPaths: ['servers'] };
    assert.strictEqual(page.parseServers(renamed, cfg).servers.length, 6);
});

test('classify: known extractors, known-without-extractor, unknown host', () => {
    const r = page.parseServers(TITLE, page.DEFAULTS);
    const c = Object.fromEntries(r.servers.map((s) => [s.name, page.classifyServer(s, page.DEFAULTS)]));
    assert.strictEqual(c.Vidbolt.extractor, 'multimovies');
    assert.strictEqual(c.Vidrift.extractor, 'vidrift');
    assert.strictEqual(c.VIDOUT.extractor, 'vidout');
    assert.strictEqual(c['GD mirror'].extractor, 'gdmirror');
    assert.strictEqual(c.Cineverse.known, true);
    assert.strictEqual(c.Cineverse.extractor, 'cineverse');
    const u = page.classifyServer({ name: 'Zeta', url: 'https://new.example.org/e/1' }, page.DEFAULTS);
    assert.strictEqual(u.known, false);
    assert.strictEqual(u.host, 'new.example.org');
});

test('read: search -> title page proven by the TMDB id in its server URLs; unknown server logged and on health', async () => {
    const withUnknown = TITLE.replace('"initialServers":[', '"initialServers":[{"id":"x","name":"Zeta","type":"iframe","url":"https:\\/\\/new.example.org\\/e\\/579974"},');
    const calls = [];
    const f = fakeFetch({
        [`${SITE}/search?q=RRR`]: SEARCH,
        [`${SITE}/movie/rrr-10105`]: withUnknown,
        [`${SITE}/movie/rrr-behind-beyond-72801`]: TITLE.replace(/579974/g, '999999').replace(/tt8178634/g, 'tt0000001'),
    }, calls);
    const logs = [];
    const r = await page.read({ tmdbId: 579974, type: 'movie' }, deps(f, { log: (l) => logs.push(l) }));
    assert.strictEqual(r.path, '/movie/rrr-10105');
    assert.strictEqual(r.servers.length, 7);
    assert.ok(logs.includes('[mm] unknown server new.example.org'));
    assert.deepStrictEqual(state.snapshot().unknownServers, ['new.example.org']);
    // Exact slug first, so the behind-the-scenes page was never read.
    assert.ok(!calls.some((c) => c.url.endsWith('72801')));
    // Fixed host: redirects are not followed.
    assert.ok(calls.every((c) => c.opts.redirect === 'manual'));
});

test('read: no page proves the id -> notListed with no servers (never a wrong title); cached negative stays notListed', async () => {
    const other = TITLE.replace(/579974/g, '111').replace(/tt8178634/g, 'tt1');
    const calls = [];
    const f = fakeFetch({ [`${SITE}/search?q=RRR`]: SEARCH, [`${SITE}/movie/rrr-10105`]: other,
        [`${SITE}/movie/rrr-behind-beyond-72801`]: other, [`${SITE}/movie/grrr-61738`]: other, [`${SITE}/movie/hunterrr-51950`]: other }, calls);
    const d = deps(f, { cfg: { ...page.DEFAULTS, serversTtlSec: 0 } });
    const r = await page.read({ tmdbId: 579974, type: 'movie' }, d);
    assert.strictEqual(r.notListed, true);
    assert.deepStrictEqual(r.servers, []);
    const n = calls.length;
    const again = await page.read({ tmdbId: 579974, type: 'movie' }, d);
    assert.strictEqual(again.notListed, true, 'negative title cache answers notListed');
    assert.strictEqual(calls.length, n, 'negative cache: no GET');
});

test('read: subtitle title with 0 search hits retries with the part before the separator (Pushpa 2 - The Rule)', async () => {
    const pushpa = TITLE.replace(/579974/g, '857598').replace(/tt8178634/g, 'tt16539454');
    const calls = [];
    const f = fakeFetch({
        [`${SITE}/api/search?q=Pushpa%202%20The%20Rule&limit=20`]: '{"movies":[],"tv_shows":[],"people":[],"results":[],"total":0}',
        [`${SITE}/api/search?q=Pushpa%202&limit=20`]: '{"results":[{"url":"/movie/pushpa-2-the-rule-70068","title":"Pushpa 2 - The Rule"}],"total":1}',
        [`${SITE}/movie/pushpa-2-the-rule-70068`]: pushpa,
    }, calls);
    const r = await page.read({ tmdbId: 857598, type: 'movie' }, deps(f, { details: async () => ({ title: 'Pushpa 2 - The Rule' }) }));
    assert.strictEqual(r.path, '/movie/pushpa-2-the-rule-70068');
    assert.ok(r.servers.length > 0);
    assert.deepStrictEqual(page.searchQueries('Pushpa 2 - The Rule'), ['Pushpa 2 The Rule', 'Pushpa 2']);
    assert.deepStrictEqual(page.searchQueries('RRR'), ['RRR']);
});

test('read: site down stays null (unknown), not notListed', async () => {
    const f = fakeFetch({ [`${SITE}/api/search?q=RRR&limit=20`]: { status: 503, body: '' } });
    assert.strictEqual(await page.read({ tmdbId: 579974, type: 'movie' }, deps(f, { log: () => {} })), null);
});

test('read: title mapping cached 7 d, server list cached 6 h', async () => {
    const calls = [];
    const f = fakeFetch({ [`${SITE}/search?q=RRR`]: SEARCH, [`${SITE}/movie/rrr-10105`]: TITLE }, calls);
    let now = 1_000_000;
    const d = deps(f, { now: () => now });
    await page.read({ tmdbId: 579974, type: 'movie' }, d);
    const n1 = calls.length;
    now += 5 * 3600e3;
    await page.read({ tmdbId: 579974, type: 'movie' }, d);
    assert.strictEqual(calls.length, n1, 'inside 6 h: no GET');
    now += 2 * 3600e3;
    await page.read({ tmdbId: 579974, type: 'movie' }, d);
    assert.strictEqual(calls.length, n1 + 1, 'after 6 h: title page only, no search');
    assert.ok(calls[calls.length - 1].url.endsWith('/movie/rrr-10105'));
});

test('read: series episode page path', async () => {
    const ep = TITLE.replace(/\\\/movie\\\/579974/g, '\\/tv\\/200946\\/1\\/1').replace(/579974/g, '200946');
    const search = '<a href="/series/dhootha-5555">Dhootha</a>';
    const f = fakeFetch({ [`${SITE}/search?q=Dhootha`]: search, [`${SITE}/series/dhootha-5555/season/1/episode/1`]: ep });
    const r = await page.read({ tmdbId: 200946, type: 'series', season: 1, episode: 1 },
        deps(f, { details: async () => ({ title: 'Dhootha', year: '2023' }) }));
    assert.strictEqual(r.path, '/series/dhootha-5555/season/1/episode/1');
});

test('site down: 3xx/5xx/network marks the configured host down on health and logs it', async () => {
    const logs = [];
    const f = fakeFetch({ [`${SITE}/search?q=RRR`]: { status: 301, body: '' } });
    assert.strictEqual(await page.read({ tmdbId: 579974, type: 'movie' }, deps(f, { log: (l) => logs.push(l) })), null);
    const snap = state.snapshot();
    assert.strictEqual(snap.host, 'm1.multimovies.courses');
    assert.strictEqual(snap.hostState, 'down');
    assert.match(snap.hostLastErr, /HTTP 301/);
    assert.ok(logs.some((l) => /^\[mm\] site down m1\.multimovies\.courses HTTP 301/.test(l)));
});

test('parse failure: redacted sample saved, no query strings or tokens in it', async () => {
    const broken = TITLE.replace('const watchConfig =', 'const nothing =')
        + '<script src="https://cdn.example/x.js?token=SECRET123&e=1764000000"></script>';
    const d = deps(fakeFetch({ [`${SITE}/search?q=RRR`]: SEARCH, [`${SITE}/movie/rrr-10105`]: broken }));
    const logs = [];
    d.log = (l) => logs.push(l);
    await page.read({ tmdbId: 579974, type: 'movie' }, d);
    const line = logs.find((l) => l.startsWith('[mm] parse failed watchConfig sample='));
    assert.ok(line, logs.join('\n'));
    const file = line.split('sample=')[1];
    const body = fs.readFileSync(path.join(d.sampleDir, file), 'utf8');
    assert.ok(!body.includes('SECRET123'));
    assert.ok(!/\?token=/.test(body));
    assert.ok(!body.includes('key=REDACTED') || !/key=[A-Za-z0-9]{8,}/.test(body));
});

test('redact: strips query strings and long token-like runs', () => {
    const s = page.redact('a https://h.example/p/master.m3u8?sig=abc&e=1 b "hls": "https://x.y/z?t=1" tok=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef');
    assert.ok(!s.includes('sig=abc'));
    assert.ok(!s.includes('t=1'));
    assert.ok(!s.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef'));
    assert.ok(s.includes('https://h.example/p/master.m3u8'));
});
