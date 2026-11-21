'use strict';
const assert = require('node:assert');
const { test } = require('node:test');

// Review I3: onetouchtv adopts a candidate only when that host itself finds
// RRR (2022) and answers its detail. No network: fetchOnce is stubbed.
const ott = require('../lib/selfheal/onetouchtv');
const { _internal } = require('../providers/onetouchtv');

function captureLogs() {
    const lines = [];
    const orig = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => { console.warn = orig; } };
}
const RRR_ROW = { id: 'abc', title: 'RRR (2022)', type: 'movie', year: '2022' };

function run(routes) {
    const calls = [];
    const r = ott.createRun({
        fetchOnce: async (url) => {
            calls.push(url);
            const k = Object.keys(routes).find((p) => url.startsWith(p));
            if (!k) { const e = new Error(`HTTP 404 from ${url}`); e.status = 404; throw e; }
            return routes[k];
        },
        findBestOttMatch: _internal.findBestOttMatch,
        bases: () => ['https://api3.devcorp.me'],
    });
    r.calls = calls;
    return r;
}

test('I3 onetouchtv: the candidate finds RRR and its detail: valid and title proven, 2 GETs', async () => {
    const r = run({ 'https://api.new/vod/search': [RRR_ROW], 'https://api.new/vod/abc/detail': { id: 'abc' } });
    const logs = captureLogs();
    try { assert.strictEqual(await r.validate('https://api.new'), true); } finally { logs.restore(); }
    assert.strictEqual(await r.titleProven('https://api.new'), true);
    assert.strictEqual(r.budget.gets, 2);
    assert.deepStrictEqual(r.calls, ['https://api.new/vod/search?keyword=RRR', 'https://api.new/vod/abc/detail']);
    assert.ok(logs.lines.some((l) => l.startsWith('[heal] onetouchtv valid api.new title "RRR (2022)"')), logs.lines.join('\n'));
});

test('I3 onetouchtv: a host without RRR, or whose detail 404s, is rejected', async () => {
    const logs = captureLogs();
    try {
        const a = run({ 'https://api.a/vod/search': [{ id: 'x', title: 'Other Film (2019)', type: 'movie', year: '2019' }] });
        assert.strictEqual(await a.validate('https://api.a'), false);
        assert.strictEqual(await a.titleProven('https://api.a'), null);
        const b = run({ 'https://api.b/vod/search': [RRR_ROW] });
        assert.strictEqual(await b.validate('https://api.b'), false);
        const c = run({});
        assert.strictEqual(await c.validate('http://api.c'), false);
    } finally { logs.restore(); }
    for (const p of ['[heal] onetouchtv reject api.a title-not-found', '[heal] onetouchtv reject api.b detail HTTP 404', '[heal] onetouchtv reject api.c not-https']) {
        assert.ok(logs.lines.some((l) => l.startsWith(p)), `missing ${p}\n${logs.lines.join('\n')}`);
    }
});

test('verify titles: vidrock, onetouchtv and vidrift use RRR 579974; the others Inception', () => {
    for (const n of ['vidrock', 'onetouchtv', 'vidrift']) assert.strictEqual(require(`../providers/${n}`).UPSTREAM.verifyTitle.tmdbId, '579974', n);
    for (const n of ['castletv', 'multimovies', 'showsst']) assert.strictEqual(require(`../providers/${n}`).UPSTREAM.verifyTitle, undefined, n);
});
