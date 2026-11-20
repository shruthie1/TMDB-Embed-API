'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each run gets its own state file, inside a dir that does not exist yet:
// a missing data/ dir must be the same as "no heals".
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'));
const FILE = path.join(dir, 'missing', 'provider-bases.json');
process.env.UPSTREAM_BASES_FILE = FILE;
delete process.env.SHOWSST_API_BASE;
delete process.env.SHOWSST_ORIGIN;

const up = require('../utils/upstreamBase');

// node-fetch-shaped stub: res.status, res.headers.get, res.text().
function res(status, { location, body = '' } = {}) {
    return {
        status,
        headers: { get: (k) => (k.toLowerCase() === 'location' ? location || null : null) },
        text: async () => body,
        body: { resume() {} },
    };
}
function fakeFetch(routes) {
    const calls = [];
    const f = async (url, opts = {}) => {
        calls.push(`${opts.method || 'GET'} ${url}`);
        const r = routes[`${opts.method || 'GET'} ${url}`] || routes[url];
        if (!r) throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).host}`);
        return typeof r === 'function' ? r() : r;
    };
    f.calls = calls;
    return f;
}

beforeEach(() => { up._reset(); fs.rmSync(path.dirname(FILE), { recursive: true, force: true }); });
afterEach(() => { up._reset(); });

test('getBase returns the seed when the state file and its dir are missing', () => {
    assert.equal(fs.existsSync(path.dirname(FILE)), false);
    assert.equal(up.getBase('mapple', 'https://mapple.fun/'), 'https://mapple.fun');
    assert.equal(up.isHealed('mapple', 'https://mapple.fun'), false);
});

test('a corrupt state file is ignored, not fatal', () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, '{not json');
    assert.equal(up.getBase('mapple', 'https://mapple.fun'), 'https://mapple.fun');
});

test('followRedirect only counts a 3xx to a different host', async () => {
    const f = fakeFetch({
        'HEAD https://old.example': res(301, { location: 'https://new.example/watch' }),
        'HEAD https://same.example': res(302, { location: '/home' }),
        'HEAD https://ok.example': res(200),
    });
    assert.equal(await up.followRedirect('https://old.example', { fetch: f }), 'https://new.example');
    assert.equal(await up.followRedirect('https://same.example', { fetch: f }), null);
    assert.equal(await up.followRedirect('https://ok.example', { fetch: f }), null);
    assert.equal(await up.followRedirect('https://dead.example', { fetch: f }), null);
});

test('followRedirect retries with GET when HEAD is rejected', async () => {
    const f = fakeFetch({
        'HEAD https://nohead.example': res(405),
        'GET https://nohead.example': res(301, { location: 'https://moved.example/' }),
    });
    assert.equal(await up.followRedirect('https://nohead.example', { fetch: f }), 'https://moved.example');
});

test('apiHostsFromPlayer reads the api host out of a same-origin bundle', async () => {
    const f = fakeFetch({
        'https://player.new.example': res(200, { body: '<script src="/assets/app.123.js"></script><a href="https://cdn.other.example">' }),
        'https://player.new.example/assets/app.123.js': res(200, { body: 'const A="https://api.new.example/v1";const B="https://player.new.example"' }),
    });
    assert.deepEqual(await up.apiHostsFromPlayer('https://player.new.example', { fetch: f }), ['https://api.new.example']);
});

test('a verified candidate is persisted and getBase returns it', async () => {
    const f = fakeFetch({ 'HEAD https://mapple.fun': res(301, { location: 'https://mapple.rip/' }) });
    const tried = [];
    const out = await up.rediscover('mapple', {
        seed: 'https://mapple.fun',
        verify: async (url) => { tried.push(url); return url === 'https://mapple.rip'; },
    }, { fetch: f });
    assert.equal(out.applied, 'https://mapple.rip');
    assert.deepEqual(tried, ['https://mapple.rip']);
    assert.equal(up.getBase('mapple', 'https://mapple.fun'), 'https://mapple.rip');

    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.equal(saved.mapple.base, 'https://mapple.rip');
    assert.equal(saved.mapple.previous, 'https://mapple.fun');
    assert.equal(saved.mapple.how, 'redirect');

    // A restart reads it back.
    up._reset();
    assert.equal(up.getBase('mapple', 'https://mapple.fun'), 'https://mapple.rip');
    // A person changing the seed (code or env) wins over the heal.
    assert.equal(up.getBase('mapple', 'https://mapple.example'), 'https://mapple.example');
});

test('nothing is applied when verify rejects, throws, or times out', async () => {
    const f = fakeFetch({ 'HEAD https://seed.example': res(301, { location: 'https://squatter.example/' }) });
    for (const verify of [async () => false, async () => { throw new Error('boom'); }, () => new Promise(() => {})]) {
        up._reset();
        const out = await up.rediscover('castletv', { seed: 'https://seed.example', verify }, { fetch: f, budgetMs: 50 });
        assert.equal(out.applied, null);
        assert.equal(out.candidates[0].url, 'https://squatter.example');
        assert.equal(up.getBase('castletv', 'https://seed.example'), 'https://seed.example');
    }
    assert.equal(fs.existsSync(FILE), false);
});

test('verifyCapped tells a timeout apart from a clean miss', async () => {
    assert.deepEqual(await up.verifyCapped(async () => null, 'x', 1000), { ok: false });
    assert.deepEqual(await up.verifyCapped(() => new Promise(() => {}), 'x', 20), { ok: false, timedOut: true });
    assert.deepEqual(await up.verifyCapped(async () => ({ masterUrl: 'm' }), 'x', 1000), { ok: true });
});

test('a stale heal falls back to the seed and is re-verified as a candidate', async () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const old = Date.now() - up.TTL_MS - 1000;
    fs.writeFileSync(FILE, JSON.stringify({ vaplayer: { base: 'https://va.new', seed: 'https://vaplayer.ru', updatedAt: old, checkedAt: old } }));
    assert.equal(up.getBase('vaplayer', 'https://vaplayer.ru'), 'https://vaplayer.ru');
    const out = await up.rediscover('vaplayer', { verify: async (u) => u === 'https://va.new' }, { fetch: fakeFetch({}) });
    assert.equal(out.applied, 'https://va.new');
    assert.equal(up.getBase('vaplayer', 'https://vaplayer.ru'), 'https://va.new');
});

test('noteOk resets the streak; noteFail counts up', () => {
    for (let i = 1; i <= 3; i++) assert.equal(up.noteFail('x'), i);
    up.noteOk('x');
    assert.equal(up.failStreak('x'), 0);
});

test('triggerRediscover is single-flight and then cooled down', async () => {
    let runs = 0;
    up._setDeps({ fetch: fakeFetch({}) });
    const opts = { seed: 'https://s.example', verify: async () => { runs++; return false; } };
    const a = up.triggerRediscover('p', opts);
    const b = up.triggerRediscover('p', opts);
    assert.equal(a, b);
    await a;
    assert.equal(up.triggerRediscover('p', opts), null);
    assert.equal(runs, 0); // no candidates, so verify never ran
});

// End to end through the real registry and the real showsst provider: the
// api host dies, five failures in a row trip the streak, discovery follows a
// 301 to a new host, verify carries a real title through showsst on it, and
// the next request is served from the new host. No real upstream is called.
test('registry: a failure streak heals showsst onto the host its old api redirects to', async () => {
    const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]);
    const BODY = { source: { label: 'MovieBox', url: 'https://frame.example/api?d=A', qualities: [{ quality: '1080p', codec: 'h264', url: 'https://frame.example/api?d=A' }] } };
    const realFetch = global.fetch;
    const hits = [];
    global.fetch = async (url) => {
        const host = new URL(url).hostname;
        hits.push(host);
        if (host === 'api.vidfresh.example') return new Response(JSON.stringify(BODY), { status: 200 });
        if (host === 'frame.example') return new Response(MP4_HEAD, { status: 206, headers: { 'content-type': 'video/mp4' } });
        throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    };
    up._setDeps({
        fetch: fakeFetch({ 'HEAD https://api.vidqueen.st': res(301, { location: 'https://api.vidfresh.example/' }) }),
        budgetMs: 2000,
    });
    try {
        const { getProvider } = require('../providers/registry');
        const p = getProvider('showsst');
        const ctx = { type: 'movie', tmdbId: '550' };
        for (let i = 0; i < up.FAIL_STREAK; i++) {
            await assert.rejects(p.fetch(ctx), /all \d+ mirrors failed/);
        }
        const job = up.pending('showsst');
        assert.ok(job, 'streak started a background rediscover');
        const out = await job;
        assert.equal(out.applied, 'https://api.vidfresh.example');
        assert.equal(up.getBase('showsst', 'https://api.vidqueen.st'), 'https://api.vidfresh.example');

        hits.length = 0;
        const streams = await p.fetch(ctx);
        assert.ok(streams.length > 0);
        assert.equal(hits[0], 'api.vidfresh.example', `healed host tried first: ${hits.join(',')}`);
        assert.equal(up.failStreak('showsst'), 0);
    } finally {
        global.fetch = realFetch;
    }
});

test('registry: an empty answer on a non-mainstream title does not count as a failure', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ source: null }), { status: 200 });
    try {
        const { getProvider } = require('../providers/registry');
        const p = getProvider('showsst');
        assert.deepEqual(await p.fetch({ type: 'movie', tmdbId: '999999' }), []);
        assert.equal(up.failStreak('showsst'), 0);
        assert.deepEqual(await p.fetch({ type: 'movie', tmdbId: '27205' }), []);
        assert.equal(up.failStreak('showsst'), 1);
    } finally {
        global.fetch = realFetch;
    }
});

test('mapple, castletv and vaplayer read their host per call', async () => {
    const mapple = require('../providers/mapple');
    assert.equal(mapple.streamHeaders().Origin, mapple.BASE);
    up.withBase('mapple', 'https://mapple.rip', () => {
        assert.equal(mapple.streamHeaders().Origin, 'https://mapple.rip');
    });
    for (const m of ['castletv', 'vaplayer', 'mapple', 'showsst']) {
        const u = require(`../providers/${m}`).UPSTREAM;
        assert.equal(u.name, m);
        assert.match(u.seed, /^https:\/\//);
    }
    // vaplayer: a heal moves both the wrapper and its streamdata api host.
    const realFetch = global.fetch;
    const urls = [];
    global.fetch = async (url) => { urls.push(String(url)); throw new Error('stop'); };
    const tmdb = require('../utils/tmdb');
    const realResolve = tmdb.resolveImdbId;
    tmdb.resolveImdbId = async () => 'tt1375666';
    delete require.cache[require.resolve('../providers/vaplayer')];
    const va = require('../providers/vaplayer');
    try {
        await up.withBase('vaplayer', 'https://vaplayer.new', () =>
            assert.rejects(va.getVaplayerStreams('27205', 'movie'), /stop/));
        assert.match(urls[0], /^https:\/\/vaplayer\.new\/embed\/va_src\.php/);
    } finally {
        global.fetch = realFetch;
        tmdb.resolveImdbId = realResolve;
    }
});
