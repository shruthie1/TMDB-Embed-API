'use strict';
// Part B item 3: extractor patterns live in resolve-config with code defaults
// and ordered fallbacks; a total parse failure saves a redacted sample.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const iu = require('../providers/insertunit');
const page = require('../lib/mmhub/page');
const selfheal = require('../lib/selfheal/config');

const RRR_PAGE = fs.readFileSync(path.join(__dirname, 'fixtures', 'insertunit', 'rrr-page.html'), 'utf8');
const MURL = 'https://hye1eaipby4w.interkh.com/08_07_22/08/07/03/A47E2JHN/5TE334TV.mp4/master.m3u8?sig=REDACTED';
const realDeps = { ...iu._deps };
afterEach(() => { Object.assign(iu._deps, realDeps); delete iu._deps.sampleDir; page._reset(); });

test('shipped resolve-config carries the mmhub and insertunit patterns, same in the web copy', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'routes', 'resolve-config.json'), 'utf8'));
    const web = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'resolve-config.json'), 'utf8'));
    assert.deepStrictEqual(shipped.mmhub, page.DEFAULTS);
    assert.deepStrictEqual(shipped.insertunit.hlsPatterns, iu.CONFIG_DEFAULTS.hlsPatterns);
    assert.deepStrictEqual(shipped.insertunit.seasonsPatterns, iu.CONFIG_DEFAULTS.seasonsPatterns);
    assert.deepStrictEqual(web.mmhub, shipped.mmhub);
    assert.deepStrictEqual(web.insertunit, shipped.insertunit);
    assert.strictEqual(web.version, shipped.version);
});

test('insertunit: ordered fallback finds a JSON-style "hls" key when the literal form is gone', () => {
    const moved = RRR_PAGE.replace(/\bhls:\s*"/, '"hls": "');
    assert.notStrictEqual(moved, RRR_PAGE);
    assert.strictEqual(iu.masterFromPage(moved, 'movie'), MURL);
});

test('insertunit: a pattern from config is used before the code defaults', () => {
    const renamed = RRR_PAGE.replace(/\bhls:\s*"/, 'streamSrc: "');
    assert.strictEqual(iu.masterFromPage(renamed, 'movie'), null);
    assert.strictEqual(iu.masterFromPage(renamed, 'movie', null, null, { hlsPatterns: ['\\bstreamSrc:\\s*"(https?:\\/\\/[^"]+)"'] }), MURL);
});

test('insertunit: page 200 with nothing parseable saves a redacted sample and logs [mm] parse failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sample-'));
    iu._deps.imdbOf = async () => 'tt8178634';
    iu._deps.sampleDir = dir;
    const body = '<html><script>var player = new Player({ src: "https://cdn.example/x/master.m3u8?token=SECRETTOKEN123" });</script></html>';
    iu._deps.fetchText = async () => ({ status: 200, text: body });
    const logs = [];
    const orig = console.warn;
    console.warn = (l) => logs.push(String(l));
    try { assert.deepStrictEqual(await iu.getInsertunitStreams('579974', 'movie'), []); } finally { console.warn = orig; }
    const line = logs.find((l) => l.startsWith('[mm] parse failed insertunit sample='));
    assert.ok(line, logs.join('\n'));
    const saved = fs.readFileSync(path.join(dir, line.split('sample=')[1]), 'utf8');
    assert.ok(!saved.includes('SECRETTOKEN123'));
});

test('mmhub: cfg() reads mmhub patterns through the selfheal config', () => {
    assert.deepStrictEqual(selfheal.cfg('mmhub', 'watchConfigPatterns', []), page.DEFAULTS.watchConfigPatterns);
    assert.strictEqual(page.liveCfg().site, page.DEFAULTS.site);
});
