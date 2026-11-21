'use strict';
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Task 5B: vidrift on the shared title-page trail; path heals for vidrift and
// multimovies. Stubbed fetch keyed by URL; no network.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shvr-'));
process.env.UPSTREAM_BASES_FILE = path.join(dir, 'provider-heals.json');
process.env.RESOLVE_CONFIG_FILE = path.join(dir, 'remote.json');
delete process.env.RESOLVE_CONFIG_URL;
delete process.env.VIDRIFT_BASE;

const config = require('../lib/selfheal/config');
const up = require('../utils/upstreamBase');
const titlePage = require('../lib/selfheal/titlePage');
const vrHeal = require('../lib/selfheal/vidrift');
const vbHeal = require('../lib/selfheal/vidbolt');
const vidrift = require('../providers/vidrift');
const mm = require('../providers/multimovies');

const FX = path.join(__dirname, 'fixtures', 'selfheal');
const TITLE = fs.readFileSync(path.join(FX, 'mm-title.html'), 'utf8');
const RRR = fs.readFileSync(path.join(FX, 'vidrift-rrr.html'), 'utf8');
const SITE = 'https://multimovies.test';
const SCRAPER_URL = 'https://raw.test/nama/multimovies.js';
const MMCFG = { sites: [SITE], scrapers: [SCRAPER_URL], bases: ['https://vidbolt.xyz', 'https://vidbolt.pro'] };
const cfg = (p, f, d) => {
    if (p === 'multimovies' && MMCFG[f] !== undefined) return MMCFG[f];
    return config.cfg(p, f, d);
};
const AUDIO_MASTER = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Telugu",LANGUAGE="te",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8\n';
const M3U8 = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';

function res(status, body = '', headers = {}) {
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => body, body: { resume() {} } };
}
function fakeFetch(routes) {
    const calls = [];
    const f = async (url, opts = {}) => {
        const u = String(url);
        calls.push({ url: u, method: opts.method || 'GET' });
        const k = Object.keys(routes).find((key) => u === key || u.startsWith(`${key}?`));
        if (k === undefined) throw new Error(`getaddrinfo ENOTFOUND ${new URL(u).host}`);
        const r = routes[k];
        if (typeof r === 'function') return r();
        if (typeof r === 'number') return res(r);
        return res(200, r);
    };
    f.calls = calls;
    return f;
}
const LANDING = '<a href="https://m9.multimovies.test/">home</a><a href="https://m9.multimovies.test/x">x</a>';
const SEARCH = '<a href="/movie/inception-8559">Inception</a>';
const titleRoutes = (title = TITLE) => ({
    [`${SITE}/`]: LANDING,
    'https://m9.multimovies.test/search': SEARCH,
    'https://m9.multimovies.test/movie/inception-8559': title,
});
const NEW = 'https://embed.vidrift.new';
const goodHost = (h) => ({ [`${h}/embed/movie/579974`]: RRR, [`${h}/orion/36c0c007/master.m3u8`]: M3U8 });
const titleCalls = (f) => f.calls.filter((c) => c.url.includes('multimovies.test')).length;

function captureLogs() {
    const lines = [];
    const orig = { warn: console.warn, log: console.log };
    console.warn = (...a) => lines.push(a.join(' '));
    console.log = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => Object.assign(console, orig) };
}
const has = (logs, p) => assert.ok(logs.lines.some((l) => l.startsWith(p)), `missing ${p}\n${logs.lines.join('\n')}`);

async function healVidrift(f, { ownResolve = async () => true, ownResolvePath = async () => true } = {}) {
    const run = vrHeal.createRun({ cfg, ownResolvePath });
    const out = await up.rediscover('vidrift', {
        seed: 'https://embed.vidrift.net', extra: run.extra, trails: run.trails, onApplied: run.onApplied,
        verify: async (cand, ctx) => (await run.validate(cand, ctx)) && ownResolve(cand),
    }, { fetch: f, budgetMs: 2000 });
    return { out, run };
}
async function healMm(f) {
    const run = vbHeal.createRun({ cfg });
    const out = await up.rediscover('multimovies', {
        seed: 'https://vidbolt.xyz', extra: run.extra, trails: run.trails, onApplied: run.onApplied,
        verify: async (cand, ctx) => run.validate(cand, ctx),
    }, { fetch: f, budgetMs: 2000 });
    return { out, run };
}

beforeEach(() => {
    up._reset(); titlePage._reset(); config.shared._setRemote(null); config.setHeals({});
    delete process.env.VIDRIFT_BASE;
    for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true });
});

test('(a) both hosts dead: title page names embed.vidrift.new; adopted; next page request goes there', async () => {
    const f = fakeFetch({ ...titleRoutes(), ...goodHost(NEW) });
    const logs = captureLogs();
    let r;
    try { r = await healVidrift(f); } finally { logs.restore(); }
    assert.strictEqual(r.out.applied, NEW);
    assert.strictEqual(r.out.candidates.find((c) => c.url === NEW).how, 'titlepage');
    assert.strictEqual(vidrift._internal.liveBases()[0], NEW);
    has(logs, `[heal] vidrift candidate ${NEW} via titlepage`);
    has(logs, '[heal] vidrift reject embed.vidrift.in');
    has(logs, `[heal] vidrift adopt ${NEW} via titlepage`);
    has(logs, '[heal] vidrift probe https://embed.vidrift.net host');
});

test('(b) VIDRIFT_BASE is still tried first after a heal', async () => {
    await healVidrift(fakeFetch({ ...titleRoutes(), ...goodHost(NEW) }));
    process.env.VIDRIFT_BASE = 'https://env.vidrift.test/';
    const b = vidrift._internal.liveBases();
    assert.deepStrictEqual(b.slice(0, 2), ['https://env.vidrift.test', NEW]);
    assert.ok(b.includes('https://embed.vidrift.net') && b.includes('https://embed.vidrift.in'));
});

test('(c) bad candidates are rejected with a reason', async () => {
    const run = vrHeal.createRun({ cfg });
    const page = (meta) => `<script>var embedMeta = ${JSON.stringify(meta)};</script>`;
    const cases = [
        ['https://a.test', { 'https://a.test/embed/movie/579974': page({ orionStreams: null }) }, 'orionStreams null'],
        ['https://b.test', { 'https://b.test/embed/movie/579974': page({ orionStreams: [] }) }, 'orionStreams empty'],
        ['https://c.test', { 'https://c.test/embed/movie/579974': RRR, 'https://c.test/orion/36c0c007/master.m3u8': '<html>no</html>' }, 'master 200 not-m3u8'],
        ['http://d.test', {}, 'not-https'],
    ];
    const logs = captureLogs();
    try {
        for (const [cand, routes] of cases) assert.strictEqual(await run.validate(cand, { fetch: fakeFetch(routes) }), false);
        const run2 = vrHeal.createRun({ cfg });
        assert.strictEqual(await run2.validate('https://e.test', { fetch: fakeFetch({ 'https://e.test/embed/movie/579974': '<html>no meta</html>' }) }), false);
    } finally { logs.restore(); }
    for (const [cand, , why] of cases) has(logs, `[heal] vidrift reject ${new URL(cand).host} ${why}`);
    has(logs, '[heal] vidrift reject e.test no-embedMeta');
});

test('(d) shared memo: a multimovies heal reads the page; vidrift within 30 min makes zero title-page GETs', async () => {
    const f1 = fakeFetch({ ...titleRoutes(), 'https://vidbolt.new/api/resolve': JSON.stringify({ stream: { sources: [{ kind: 'hls', master: AUDIO_MASTER }] } }) });
    await healMm(f1);
    assert.strictEqual(titleCalls(f1), 3);
    const f2 = fakeFetch({ ...titleRoutes(), ...goodHost(NEW) });
    const { out } = await healVidrift(f2);
    assert.strictEqual(titleCalls(f2), 0);
    assert.strictEqual(out.applied, NEW);
    assert.strictEqual(out.candidates.find((c) => c.url === NEW).how, 'titlepage');
});

test('(e) the memo never adopts: vidrift validation failing leaves the base unchanged', async () => {
    const f = fakeFetch({ ...titleRoutes(), [`${NEW}/embed/movie/579974`]: '<html>parked</html>' });
    const { out } = await healVidrift(f);
    assert.strictEqual(out.applied, null);
    assert.strictEqual(vidrift._internal.liveBases()[0], 'https://embed.vidrift.net');
});

test('(f) path change: host root 200, movie path 404: drift, moviePath saved, base unchanged', async () => {
    const H = 'https://embed.vidrift.net';
    const title = TITLE.replace(/https:\\\/\\\/embed\.vidrift\.new\\\/embed\\\/movie\\\/27205/, 'https:\\/\\/embed.vidrift.net\\/e\\/movie\\/27205');
    assert.ok(title.includes('embed.vidrift.net\\/e\\/movie'), 'fixture rewritten');
    const f = fakeFetch({
        ...titleRoutes(title),
        [`${H}/embed/movie/579974`]: 404,
        [`${H}/`]: 'home',
        [`${H}/e/movie/579974`]: RRR,
        [`${H}/orion/36c0c007/master.m3u8`]: M3U8,
    });
    const logs = captureLogs();
    try { await healVidrift(f); } finally { logs.restore(); }
    has(logs, `[heal] vidrift probe ${H} drift rule=path-404`);
    has(logs, '[heal] vidrift path /e/movie/{id} via titlepage');
    assert.strictEqual(up.getField('vidrift', 'moviePath').value, '/e/movie/{id}');
    assert.strictEqual(vidrift.embedUrl(H, '579974', 'movie'), `${H}/e/movie/579974`);
    assert.strictEqual(vidrift._internal.liveBases()[0], H);
});

test('(g) an IMDb id in the title URL: no path template, reject nopath, nothing saved', async () => {
    const H = 'https://embed.vidrift.net';
    assert.strictEqual(titlePage.pathFromUrl(`${H}/embed/movie/tt1375666`, '27205'), null);
    const title = TITLE.replace(/https:\\\/\\\/embed\.vidrift\.new\\\/embed\\\/movie\\\/27205/, 'https:\\/\\/embed.vidrift.net\\/embed\\/movie\\/tt1375666');
    const f = fakeFetch({ ...titleRoutes(title), [`${H}/embed/movie/579974`]: 404, [`${H}/`]: 'home' });
    const logs = captureLogs();
    try { await healVidrift(f); } finally { logs.restore(); }
    has(logs, '[heal] vidrift reject https://embed.vidrift.net nopath');
    assert.strictEqual(up.getField('vidrift', 'moviePath'), null);
});

test('(h) multimovies: /watch/{id} playerPath saved after its host is adopted; resolvePath 404 on a live host is drift, nothing saved', async () => {
    const title = TITLE.replace('https:\\/\\/vidbolt.new\\/movie\\/27205', 'https:\\/\\/vidbolt.new\\/watch\\/27205');
    const ok = JSON.stringify({ stream: { sources: [{ kind: 'hls', master: AUDIO_MASTER }] } });
    const f = fakeFetch({ ...titleRoutes(title), 'https://vidbolt.new/api/resolve': ok, 'https://vidbolt.new/watch/27205': '{"servers":[{"id":"orion"}]}' });
    const logs = captureLogs();
    try { await healMm(f); } finally { logs.restore(); }
    has(logs, '[heal] multimovies path /watch/{id} via titlepage');
    assert.strictEqual(up.getField('multimovies', 'playerPath').value, '/watch/{id}');
    // Host and path were adopted together (no "cap 3" on the right host).
    assert.strictEqual(up.getBase('multimovies', 'https://vidbolt.xyz'), 'https://vidbolt.new');

    for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true });
    up._reset(); titlePage._reset();
    const g = fakeFetch({ ...titleRoutes(), 'https://vidbolt.new/api/resolve': 404, 'https://vidbolt.new/': 'home' });
    const logs2 = captureLogs();
    let r;
    try { r = await healMm(g); } finally { logs2.restore(); }
    assert.strictEqual(r.out.applied, null);
    has(logs2, '[heal] multimovies reject vidbolt.new resolvePath (drift)');
    assert.strictEqual(up.getField('multimovies', 'resolvePath'), null);
});

test('(i) a remote edit of vidrift.moviePath drops the path heal', () => {
    up.setField('vidrift', 'moviePath', '/e/movie/{id}', 'titlepage');
    assert.strictEqual(vidrift._internal.moviePath(), '/e/movie/{id}');
    config.shared._setRemote({ version: 2, vidrift: { moviePath: '/v2/movie/{id}' } });
    assert.strictEqual(vidrift._internal.moviePath(), '/v2/movie/{id}');
    assert.strictEqual(up.getField('vidrift', 'moviePath'), null);
});

test('(j) plain 403 on every host: blocked (review I1), no title-page GET; with cf-mitigated: blocked', async () => {
    const all403 = { 'https://embed.vidrift.net/embed/movie/579974': 403, 'https://embed.vidrift.in/embed/movie/579974': 403, ...titleRoutes() };
    const f = fakeFetch(all403);
    const logs = captureLogs();
    try { await healVidrift(f); } finally { logs.restore(); }
    assert.strictEqual(titleCalls(f), 0);
    has(logs, '[heal] vidrift skip titlepage (blocked)');
    up._reset();
    const g = fakeFetch({ ...all403, 'https://embed.vidrift.net/embed/movie/579974': () => res(403, 'x', { 'cf-mitigated': 'challenge' }) });
    const logs2 = captureLogs();
    try { await healVidrift(g); } finally { logs2.restore(); }
    assert.strictEqual(titleCalls(g), 0);
    has(logs2, '[heal] vidrift skip titlepage (blocked)');
});

test('(k) scraper with no Vidrift entry: no host from its text; its SITE.base reruns the title page', async () => {
    const scraper = 'var SITE = { name: "MultiMovies", base: "https://m2.multimovies.test" };\n{ name: "VidBolt", url: "https://vidbolt.dead/movie/" + id }';
    const f = fakeFetch({
        [SCRAPER_URL]: scraper,
        'https://m2.multimovies.test/': 'nothing',
        'https://m2.multimovies.test/search': SEARCH,
        'https://m2.multimovies.test/movie/inception-8559': TITLE,
        ...goodHost(NEW),
    });
    const { out } = await healVidrift(f);
    assert.strictEqual(out.applied, NEW);
    assert.ok(!out.candidates.some((c) => c.how === 'scraper'));
});

test('(l) a full failing run makes at most 12 counted GETs', async () => {
    const f = fakeFetch({ ...titleRoutes(), [`${NEW}/embed/movie/579974`]: RRR, [SCRAPER_URL]: 'var SITE = { base: "https://m3.multimovies.test" };' });
    const { out, run } = await healVidrift(f);
    assert.strictEqual(out.applied, null);
    assert.ok(run.state.gets <= 12, `gets ${run.state.gets}`);
    assert.ok(run.state.validated <= 3, `validated ${run.state.validated}`);
});

test('(m) no remote, no heal: page URL is today\'s', () => {
    assert.deepStrictEqual(vidrift._internal.liveBases(), ['https://embed.vidrift.net', 'https://embed.vidrift.in']);
    assert.strictEqual(vidrift.embedUrl(vidrift._internal.liveBases()[0], '579974', 'movie'), 'https://embed.vidrift.net/embed/movie/579974');
    assert.strictEqual(vidrift.embedUrl('https://embed.vidrift.net', '1396', 'tv', 2, 3), 'https://embed.vidrift.net/embed/tv/1396/2/3');
    assert.strictEqual(vidrift.UPSTREAM.verifyTitle.tmdbId, '579974');
    assert.strictEqual(mm.UPSTREAM.name, 'multimovies');
});

// ---- review 2026-11-21 fixes ----

test('I3 a host whose page is another film (embedMeta.tmdbId) is rejected', async () => {
    const run = vrHeal.createRun({ cfg });
    const wrong = RRR.replace('"tmdbId":579974', '"tmdbId":12345');
    const logs = captureLogs();
    let ok;
    try { ok = await run.validate(NEW, { fetch: fakeFetch({ [`${NEW}/embed/movie/579974`]: wrong, [`${NEW}/orion/36c0c007/master.m3u8`]: M3U8 }) }); } finally { logs.restore(); }
    assert.strictEqual(ok, false);
    has(logs, '[heal] vidrift reject embed.vidrift.new title-mismatch tmdbId 12345');
    assert.strictEqual(await run.titleProven(NEW), null);
    const run2 = vrHeal.createRun({ cfg });
    assert.strictEqual(await run2.validate(NEW, { fetch: fakeFetch(goodHost(NEW)) }), true);
    assert.strictEqual(await run2.titleProven(NEW), true);
});

test('I1 current host times out: the title page is still read and the new host adopted', async () => {
    const timeout = () => { throw new Error('The operation was aborted due to timeout'); };
    const f = fakeFetch({ 'https://embed.vidrift.net/embed/movie/579974': timeout, ...titleRoutes(), ...goodHost(NEW) });
    const logs = captureLogs();
    let out;
    try { ({ out } = await healVidrift(f)); } finally { logs.restore(); }
    assert.strictEqual(out.applied, NEW);
    has(logs, '[heal] vidrift probe https://embed.vidrift.net down rule=timeout');
    assert.ok(!logs.lines.some((l) => l.startsWith('[heal] vidrift skip titlepage')), logs.lines.join('\n'));
});

test('I2/M7 host and path moved together: validated with the new path, own resolve pinned to the new host, path saved after adoption', async () => {
    const title = TITLE.split('embed.vidrift.new/embed/movie/27205').join('embed.vidrift.new/e/movie/27205')
        .split('embed.vidrift.new\\/embed\\/movie\\/27205').join('embed.vidrift.new\\/e\\/movie\\/27205');
    const f = fakeFetch({ ...titleRoutes(title), [`${NEW}/e/movie/579974`]: RRR, [`${NEW}/orion/36c0c007/master.m3u8`]: M3U8 });
    const pinnedSeen = [];
    const run = vrHeal.createRun({ cfg, ownResolvePath: async (tmpl) => { pinnedSeen.push([up.pinned('vidrift'), tmpl]); return true; } });
    const logs = captureLogs();
    let out;
    try {
        out = await up.rediscover('vidrift', {
            seed: 'https://embed.vidrift.net', extra: run.extra, trails: run.trails, onApplied: run.onApplied,
            verify: (cand, ctx) => up.withBase('vidrift', cand, async () => (await run.validate(cand, ctx))
                && (await run.ownResolve(cand, async () => [], { tmdbId: '579974', mediaType: 'movie' })).length > 0
                && (await run.titleProven(cand)) === true),
        }, { fetch: f, budgetMs: 2000 });
    } finally { logs.restore(); }
    assert.strictEqual(out.applied, NEW, logs.lines.join('\n'));
    assert.deepStrictEqual(pinnedSeen, [[NEW, '/e/movie/{id}']]);
    assert.strictEqual(up.getField('vidrift', 'moviePath').value, '/e/movie/{id}');
    const pend = logs.lines.findIndex((l) => l.startsWith('[heal] vidrift path /e/movie/{id} pending host embed.vidrift.new'));
    const adopt = logs.lines.findIndex((l) => l.startsWith('[heal] vidrift adopt https://embed.vidrift.new'));
    const saved = logs.lines.findIndex((l) => l.startsWith('[heal] vidrift path /e/movie/{id} via titlepage'));
    assert.ok(pend >= 0 && adopt > pend && saved > adopt, logs.lines.join('\n'));
    assert.strictEqual(run.state.pathChecks, 0);
});
