'use strict';
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Task 5A: multimovies VidBolt discovery chain. Stubbed fetch keyed by URL;
// no network.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shvb-'));
process.env.UPSTREAM_BASES_FILE = path.join(dir, 'provider-heals.json');
process.env.RESOLVE_CONFIG_FILE = path.join(dir, 'remote.json');
delete process.env.RESOLVE_CONFIG_URL;

const up = require('../utils/upstreamBase');
const vidbolt = require('../lib/selfheal/vidbolt');
const titlePage = require('../lib/selfheal/titlePage');
const mm = require('../providers/multimovies');

const FX = path.join(__dirname, 'fixtures', 'selfheal');
const TITLE = fs.readFileSync(path.join(FX, 'mm-title.html'), 'utf8');
const SCRAPER = fs.readFileSync(path.join(FX, 'nama-mm.js'), 'utf8');
const SITE = 'https://multimovies.test';
const SCRAPER_URL = 'https://raw.test/nama/multimovies.js';
const CFG = { bases: ['https://vidbolt.xyz', 'https://vidbolt.pro'], sites: [SITE], scrapers: [SCRAPER_URL] };
const cfg = (p, f, d) => (p === 'multimovies' && CFG[f] !== undefined ? CFG[f] : d);

const AUDIO_MASTER = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Telugu",LANGUAGE="te",URI="a.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nv.m3u8\n';
const NO_AUDIO_MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
const resolveJson = (master) => JSON.stringify({ stream: { sources: [{ kind: 'hls', url: 'https://cdn.test/m.m3u8', master }] } });

function res(status, body = '') {
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => body, body: { resume() {} } };
}
// routes: { 'https://x/path': body | status number | () => res }
function fakeFetch(routes) {
    const calls = [];
    const f = async (url, opts = {}) => {
        const u = String(url);
        calls.push({ url: u, method: opts.method || 'GET', referer: opts.headers && (opts.headers.referer || opts.headers.Referer) });
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
const landing = (site) => `<a href="https://m9.multimovies.test/">home</a> <a href="https://m9.multimovies.test/movies">x</a> ${site || ''}`;
const SEARCH = '<a href="/movie/inception-8559">Inception</a>';
const titleRoutes = {
    [`${SITE}/`]: landing(),
    'https://m9.multimovies.test/search': SEARCH,
    'https://m9.multimovies.test/movie/inception-8559': TITLE,
};

function captureLogs() {
    const lines = [];
    const orig = { warn: console.warn, log: console.log };
    console.warn = (...a) => lines.push(a.join(' '));
    console.log = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => Object.assign(console, orig) };
}

// What providers/registry.js does: validate, then the provider's own resolve
// (stubbed: true).
async function heal(f, { ownResolve = async () => true } = {}) {
    const run = vidbolt.createRun({ cfg });
    const out = await up.rediscover('multimovies', {
        seed: 'https://vidbolt.xyz', extra: run.extra, trails: run.trails,
        verify: async (cand, ctx) => (await run.validate(cand, ctx)) && ownResolve(cand),
    }, { fetch: f, budgetMs: 2000 });
    return { out, run };
}

beforeEach(() => { up._reset(); titlePage._reset(); for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true }); });

test('(a) both bases dead: title page names vidbolt.new, validated, adopted; next request goes there', async () => {
    const f = fakeFetch({ ...titleRoutes, 'https://vidbolt.new/api/resolve': resolveJson(AUDIO_MASTER) });
    const logs = captureLogs();
    let r;
    try { r = await heal(f); } finally { logs.restore(); }
    assert.strictEqual(r.out.applied, 'https://vidbolt.new');
    assert.strictEqual(r.out.candidates.find((c) => c.url === 'https://vidbolt.new').how, 'titlepage');
    const api = f.calls.find((c) => c.url.startsWith('https://vidbolt.new/api/resolve'));
    assert.strictEqual(api.referer, 'https://vidbolt.new/movie/27205');
    // The live provider now uses it.
    assert.strictEqual(mm._internal.resolveUrl('27205', 'movie'), 'https://vidbolt.new/api/resolve?type=movie&id=27205');
    assert.strictEqual(mm._internal.streamHeaders().Referer, 'https://vidbolt.new/');
    for (const p of ['[heal] multimovies candidate https://vidbolt.new via titlepage', '[heal] multimovies reject vidbolt.pro', '[heal] multimovies adopt https://vidbolt.new via titlepage']) {
        assert.ok(logs.lines.some((l) => l.startsWith(p)), `missing ${p}\n${logs.lines.join('\n')}`);
    }
    // The vidrift host on the same page is offered to vidrift, not adopted.
    assert.deepStrictEqual(titlePage.takeOffers('vidrift'), ['https://embed.vidrift.new']);
});

test('(b) landing page dead: scraper names vidbolt.alt, adopted via scraper', async () => {
    const f = fakeFetch({ [SCRAPER_URL]: SCRAPER.replace('https://m2.multimovies.test', 'https://m2.dead.test'), 'https://vidbolt.alt/api/resolve': resolveJson(AUDIO_MASTER) });
    const { out } = await heal(f);
    assert.strictEqual(out.applied, 'https://vidbolt.alt');
    assert.strictEqual(out.candidates.find((c) => c.url === 'https://vidbolt.alt').how, 'scraper');
});

test('(c) scraper SITE.base reruns the title-page trail when the landing page was dead', async () => {
    const f = fakeFetch({
        [SCRAPER_URL]: SCRAPER.replace('https://vidbolt.alt', 'https://vidbolt.dead'),
        'https://m2.multimovies.test/': 'no site links here',
        'https://m2.multimovies.test/search': SEARCH,
        'https://m2.multimovies.test/movie/inception-8559': TITLE,
        'https://vidbolt.new/api/resolve': resolveJson(AUDIO_MASTER),
    });
    const { out } = await heal(f);
    assert.strictEqual(out.applied, 'https://vidbolt.new');
    assert.strictEqual(out.candidates.find((c) => c.url === 'https://vidbolt.new').how, 'titlepage');
});

test('(d) bad candidates are rejected with a reason and never adopted', async () => {
    const f = fakeFetch({
        [`${SITE}/`]: landing(),
        'https://m9.multimovies.test/search': SEARCH,
        'https://m9.multimovies.test/movie/inception-8559': TITLE.replace(/vidbolt\.new/g, 'bad.test'),
        'https://bad.test/api/resolve': resolveJson(NO_AUDIO_MASTER),
        [SCRAPER_URL]: SCRAPER,
        'https://vidbolt.alt/api/resolve': resolveJson(AUDIO_MASTER),
    });
    const logs = captureLogs();
    let r;
    try { r = await heal(f); } finally { logs.restore(); }
    assert.strictEqual(r.out.applied, 'https://vidbolt.alt');
    assert.ok(logs.lines.some((l) => l.startsWith('[heal] multimovies reject bad.test no-audio-master')), logs.lines.join('\n'));
    // HTML 200 and http:// are rejected by the validator itself.
    const run = vidbolt.createRun({ cfg });
    const g = fakeFetch({ 'https://html.test/api/resolve': '<html>parked</html>' });
    const logs2 = captureLogs();
    try {
        assert.strictEqual(await run.validate('https://html.test', { fetch: g }), false);
        assert.strictEqual(await run.validate('http://plain.test', { fetch: g }), false);
    } finally { logs2.restore(); }
    assert.ok(logs2.lines.some((l) => l.startsWith('[heal] multimovies reject html.test not-json')), logs2.lines.join('\n'));
    assert.ok(logs2.lines.some((l) => l.startsWith('[heal] multimovies reject plain.test not-https')), logs2.lines.join('\n'));
});

test('(e) label regex fallback; a different server whose URL holds "vidbolt" is not picked', () => {
    const noJson = TITLE.replace(/const watchConfig[^\n]*\n/, '');
    assert.strictEqual(vidbolt.vidboltFromTitle(noJson), 'https://vidbolt.new');
    const trap = `<button class="server-chip" data-url="https://vidbolt-mirror.test/movie/27205"><span class="server-name">Nexus</span></button>`;
    assert.strictEqual(vidbolt.vidboltFromTitle(trap), null);
    assert.strictEqual(vidbolt.currentSite(landing()), 'https://m9.multimovies.test');
    assert.strictEqual(vidbolt.titlePath(SEARCH), '/movie/inception-8559');
    assert.deepStrictEqual(vidbolt.fromScraper(SCRAPER), { vidbolt: 'https://vidbolt.alt', site: 'https://m2.multimovies.test' });
});

test('(f) first trail candidate validates: no scraper GET', async () => {
    const f = fakeFetch({ ...titleRoutes, 'https://vidbolt.new/api/resolve': resolveJson(AUDIO_MASTER), [SCRAPER_URL]: SCRAPER });
    await heal(f);
    assert.ok(!f.calls.some((c) => c.url === SCRAPER_URL));
});

test('(g) a full failing run makes at most 12 counted GETs and validates at most 3', async () => {
    const f = fakeFetch({ ...titleRoutes, 'https://vidbolt.new/api/resolve': resolveJson(NO_AUDIO_MASTER), [SCRAPER_URL]: SCRAPER, 'https://vidbolt.alt/api/resolve': 500 });
    const { out, run } = await heal(f);
    assert.strictEqual(out.applied, null);
    assert.ok(run.state.gets <= 12, `gets ${run.state.gets}`);
    assert.ok(run.state.validated <= 3, `validated ${run.state.validated}`);
});

test('(h) a config base that validates: zero trail GETs', async () => {
    const f = fakeFetch({ 'https://vidbolt.pro/api/resolve': resolveJson(AUDIO_MASTER), ...titleRoutes, [SCRAPER_URL]: SCRAPER });
    const { out } = await heal(f);
    assert.strictEqual(out.applied, 'https://vidbolt.pro');
    assert.strictEqual(out.candidates.find((c) => c.url === 'https://vidbolt.pro').how, 'config');
    assert.ok(!f.calls.some((c) => c.url.startsWith(SITE) || c.url === SCRAPER_URL), f.calls.map((c) => c.url).join('\n'));
});

test('own resolve empty: candidate rejected even when the validator passes', async () => {
    const f = fakeFetch({ ...titleRoutes, 'https://vidbolt.new/api/resolve': resolveJson(AUDIO_MASTER) });
    const { out } = await heal(f, { ownResolve: async () => false });
    assert.strictEqual(out.applied, null);
});

test('registry: healRun trails feed rediscover; empty own resolve is logged and not adopted', async () => {
    const { _noteUpstream } = require('../providers/registry');
    up._setDeps({ fetch: async (u) => { throw new Error(`getaddrinfo ENOTFOUND ${new URL(u).host}`); }, budgetMs: 2000 });
    const mod = (rows) => ({
        UPSTREAM: {
            name: 'mmstub', seed: 'https://dead.test',
            healRun: () => ({ extra: [], trails: [async () => [{ url: 'https://cand.test', how: 'titlepage', from: 't' }]], validate: async () => true }),
        },
        getStub: async () => rows,
    });
    const info = { name: 'mmstub', functionName: 'getStub' };
    const logs = captureLogs();
    try {
        for (let i = 0; i < up.FAIL_STREAK; i++) _noteUpstream(info, mod([]), 'fail', { tmdbId: '27205' });
        await up.pending('mmstub');
    } finally { logs.restore(); }
    assert.strictEqual(up.getBase('mmstub', 'https://dead.test'), 'https://dead.test');
    assert.ok(logs.lines.some((l) => l.startsWith('[heal] mmstub reject https://cand.test own-resolve-empty')), logs.lines.join('\n'));
    // Review I3: rows alone (no title proof) are not enough.
    up._reset();
    up._setDeps({ fetch: async (u) => { throw new Error(`getaddrinfo ENOTFOUND ${new URL(u).host}`); }, budgetMs: 2000 });
    const logs2 = captureLogs();
    try {
        for (let i = 0; i < up.FAIL_STREAK; i++) _noteUpstream(info, mod([{ url: 'x' }]), 'fail', { tmdbId: '27205' });
        await up.pending('mmstub');
    } finally { logs2.restore(); }
    assert.strictEqual(up.getBase('mmstub', 'https://dead.test'), 'https://dead.test');
    assert.ok(logs2.lines.some((l) => l.startsWith('[heal] mmstub reject https://cand.test no-title-proof')), logs2.lines.join('\n'));
    up._reset();
    up._setDeps({});
});

// A fetch that serves an HLS master + media playlist of `minutes` on cdn.test
// and fails DNS for everything else.
function hlsFetch(minutes) {
    const media = `#EXTM3U\n${Array.from({ length: minutes }, () => '#EXTINF:60.0,\nseg.ts').join('\n')}\n#EXT-X-ENDLIST\n`;
    return async (u) => {
        const url = new URL(u);
        if (url.host !== 'cdn.test') throw new Error(`getaddrinfo ENOTFOUND ${url.host}`);
        const body = url.pathname.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n' : media;
        return { status: 200, ok: true, text: async () => body, headers: new Map() };
    };
}

test('I3 registry: a candidate whose stream runs the validation title runtime is adopted', async () => {
    const proof = require('../lib/selfheal/proof');
    proof._setDeps({ getDetails: async () => ({ runtime: 148 }) });
    const { _noteUpstream } = require('../providers/registry');
    const mod = {
        UPSTREAM: { name: 'mmproof', seed: 'https://dead.test', healRun: () => ({ extra: [], trails: [async () => [{ url: 'https://cand.test', how: 'titlepage', from: 't' }]], validate: async () => true }) },
        getStub: async () => [{ url: 'https://cdn.test/a/master.m3u8' }],
    };
    const info = { name: 'mmproof', functionName: 'getStub' };
    const logs = captureLogs();
    try {
        up._setDeps({ fetch: hlsFetch(147), budgetMs: 2000 });
        proof._setDeps({ getDetails: async () => ({ runtime: 148 }), fetch: hlsFetch(147) });
        for (let i = 0; i < up.FAIL_STREAK; i++) _noteUpstream(info, mod, 'fail', { tmdbId: '27205' });
        await up.pending('mmproof');
    } finally { logs.restore(); up._setDeps({}); proof._setDeps({}); }
    assert.strictEqual(up.getBase('mmproof', 'https://dead.test'), 'https://cand.test');
    assert.ok(logs.lines.some((l) => l.startsWith('[heal] mmproof title-proof https://cand.test ok 147min want 148min')), logs.lines.join('\n'));
    up._reset();
});

test('I3 registry: a candidate serving the wrong film (short clip) is rejected', async () => {
    const proof = require('../lib/selfheal/proof');
    proof._setDeps({ getDetails: async () => ({ runtime: 148 }) });
    const { _noteUpstream } = require('../providers/registry');
    const mod = {
        UPSTREAM: { name: 'mmclip', seed: 'https://dead.test', healRun: () => ({ extra: [], trails: [async () => [{ url: 'https://cand.test', how: 'titlepage', from: 't' }]], validate: async () => true }) },
        getStub: async () => [{ url: 'https://cdn.test/a/master.m3u8' }],
    };
    const info = { name: 'mmclip', functionName: 'getStub' };
    const logs = captureLogs();
    try {
        up._setDeps({ fetch: hlsFetch(10), budgetMs: 2000 });
        proof._setDeps({ getDetails: async () => ({ runtime: 148 }), fetch: hlsFetch(10) });
        for (let i = 0; i < up.FAIL_STREAK; i++) _noteUpstream(info, mod, 'fail', { tmdbId: '27205' });
        await up.pending('mmclip');
    } finally { logs.restore(); up._setDeps({}); proof._setDeps({}); }
    assert.strictEqual(up.getBase('mmclip', 'https://dead.test'), 'https://dead.test');
    assert.ok(logs.lines.some((l) => l.startsWith('[heal] mmclip title-proof https://cand.test mismatch 10min want 148min')), logs.lines.join('\n'));
    up._reset();
});

// ---- review I2: playerPath heals ----

const movedTitle = TITLE.split('vidbolt.new/movie/27205').join('vidbolt.new/v/27205?t=abc')
    .split('vidbolt.new\\/movie\\/27205').join('vidbolt.new\\/v\\/27205?t=abc');
const PLAYER_PAGE = '<script>var cfg = {"servers":[{"id":"orion","name":"Orion"}]};</script>';

async function healWithApply(f) {
    const run = vidbolt.createRun({ cfg });
    const out = await up.rediscover('multimovies', {
        seed: 'https://vidbolt.xyz', extra: run.extra, trails: run.trails, onApplied: run.onApplied,
        verify: async (cand, ctx) => run.validate(cand, ctx),
    }, { fetch: f, budgetMs: 2000 });
    return { out, run };
}

test('I2 a new player path on a new host: query dropped, path proven, saved only after the host is adopted', async () => {
    const f = fakeFetch({
        ...titleRoutes, 'https://m9.multimovies.test/movie/inception-8559': movedTitle,
        'https://vidbolt.new/v/27205': PLAYER_PAGE,
        'https://vidbolt.new/api/resolve': resolveJson(AUDIO_MASTER),
    });
    const logs = captureLogs();
    let r;
    try { r = await healWithApply(f); } finally { logs.restore(); }
    assert.strictEqual(r.out.applied, 'https://vidbolt.new');
    assert.strictEqual(up.getField('multimovies', 'playerPath').value, '/v/{id}');
    // The host was validated with the new path as Referer.
    const api = f.calls.find((c) => c.url.startsWith('https://vidbolt.new/api/resolve'));
    assert.strictEqual(api.referer, 'https://vidbolt.new/v/27205');
    const pend = logs.lines.findIndex((l) => l.startsWith('[heal] multimovies path /v/{id} pending host vidbolt.new'));
    const adopt = logs.lines.findIndex((l) => l.startsWith('[heal] multimovies adopt https://vidbolt.new'));
    const saved = logs.lines.findIndex((l) => l.startsWith('[heal] multimovies path /v/{id} via titlepage'));
    assert.ok(pend >= 0 && adopt > pend && saved > adopt, logs.lines.join('\n'));
    assert.strictEqual(r.run.state.validated <= vidbolt.MAX_VALIDATED, true);
});

test('I2 a path heal is never saved when its host is rejected', async () => {
    const f = fakeFetch({
        ...titleRoutes, 'https://m9.multimovies.test/movie/inception-8559': movedTitle,
        'https://vidbolt.new/v/27205': PLAYER_PAGE,
        'https://vidbolt.new/api/resolve': resolveJson(NO_AUDIO_MASTER),
    });
    const logs = captureLogs();
    let r;
    try { r = await healWithApply(f); } finally { logs.restore(); }
    assert.strictEqual(r.out.applied, null);
    assert.strictEqual(up.getField('multimovies', 'playerPath'), null);
});

test('I2 a path whose page has no server list is rejected and uses no host slot', async () => {
    const f = fakeFetch({
        ...titleRoutes, 'https://m9.multimovies.test/movie/inception-8559': movedTitle,
        'https://vidbolt.new/v/27205': '<html>parked</html>',
        'https://vidbolt.new/api/resolve': resolveJson(AUDIO_MASTER),
    });
    const logs = captureLogs();
    let r;
    try { r = await healWithApply(f); } finally { logs.restore(); }
    assert.ok(logs.lines.some((l) => l.startsWith('[heal] multimovies reject vidbolt.new path /v/{id} no-server-list')), logs.lines.join('\n'));
    assert.strictEqual(up.getField('multimovies', 'playerPath'), null);
    // vidbolt.pro (config) and vidbolt.new: 2 host slots; the path check used none.
    assert.strictEqual(r.run.state.validated, 2);
    assert.strictEqual(r.run.state.pathChecks, 1);
    assert.strictEqual(r.out.applied, 'https://vidbolt.new');
});

test('M6 redirects and trail GETs share one 12-GET run budget', async () => {
    const run = vidbolt.createRun({ cfg });
    const f = fakeFetch({});
    const logs = captureLogs();
    try {
        await up.rediscover('multimovies', {
            seed: 'https://vidbolt.xyz', extra: run.extra, trails: run.trails, budget: run.budget,
            verify: async (cand, ctx) => run.validate(cand, ctx),
        }, { fetch: f, budgetMs: 2000 });
    } finally { logs.restore(); }
    // followRedirect HEAD+GET are counted with the trails.
    assert.ok(f.calls.some((c) => c.method === 'HEAD'), 'redirect check ran');
    assert.strictEqual(f.calls.length, run.budget.gets);
    assert.ok(run.budget.gets <= 12, `gets ${run.budget.gets}`);
});

test('I3 proof: MP4 mvhd duration (v0) is read from the first bytes', () => {
    const proof = require('../lib/selfheal/proof');
    const box = Buffer.alloc(32);
    box.write('mvhd', 0); box[4] = 0; box.writeUInt32BE(1000, 16); box.writeUInt32BE(148 * 60 * 1000, 20);
    assert.strictEqual(proof.mp4Seconds(Buffer.concat([Buffer.from('....moov'), box])), 148 * 60);
    assert.strictEqual(proof.mp4Seconds(Buffer.from('no box here')), null);
    assert.strictEqual(proof.runtimeMatches(147 * 60, 148), true);
    assert.strictEqual(proof.runtimeMatches(10 * 60, 148), false);
    assert.strictEqual(proof.runtimeMatches(120 * 60, 148), false);
});
