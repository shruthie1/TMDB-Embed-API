'use strict';
// Provider self-heal Task 6: key and token extractors, and the key heal run.
// Stubbed fetch only, no network. Fixtures are synthetic (no real bundles).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCipheriv, randomBytes } = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-keys-'));
process.env.UPSTREAM_BASES_FILE = path.join(tmp, 'provider-heals.json');
process.env.RESOLVE_CONFIG_FILE = path.join(tmp, 'resolve-config.remote.json');
delete process.env.RESOLVE_CONFIG_URL;

const keys = require('../lib/selfheal/keys');
const { classify } = require('../lib/selfheal/classify');
const upstream = require('../utils/upstreamBase');

const FIX = path.join(__dirname, 'fixtures', 'selfheal');

function gcmEncrypt(keyHex, plain) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cbcEncrypt(key, iv, obj) {
    const c = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
    return Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
}
const res = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) });
function stubFetch(map) {
    const calls = [];
    const f = async (url) => {
        calls.push(String(url));
        for (const [k, v] of Object.entries(map)) if (String(url).includes(k)) return typeof v === 'function' ? v(url) : res(v);
        return res('', 404);
    };
    f.calls = calls;
    return f;
}

const GOOD = 'a'.repeat(63) + 'b';
const BAD = '0123456789abcdef'.repeat(4);

test('(a) vidrock: two hex literals, only one passes the GCM tag: that one is returned, 2 GETs', async () => {
    const sample = gcmEncrypt(GOOD, 'https://cdn.example/x/master.m3u8');
    const bundle = `var a="${BAD}";function k(){return "${GOOD}"}`;
    const f = stubFetch({
        '/movie/27205': '<script type="module" src="/assets/index-AbC123.js"></script>',
        '/assets/index-AbC123.js': bundle,
    });
    const r = await keys.extractVidrockKey({ fetch: f, base: 'https://vidrock.example', sample });
    assert.equal(r && r.key, GOOD);
    assert.equal(f.calls.length, 2);
});

test('(b) vidrock: no literal passes: null (nothing to apply)', async () => {
    const sample = gcmEncrypt(GOOD, 'https://cdn.example/x/master.m3u8');
    const f = stubFetch({
        '/movie/27205': '<script src="/assets/index-Z.js"></script>',
        '/assets/index-Z.js': `"${BAD}"`,
    });
    assert.equal(await keys.extractVidrockKey({ fetch: f, base: 'https://vidrock.example', sample }), null);
});

test('(c) onetouchtv: key from the mP(){var s="...",r=B.d.a2(s,0,16) shape, IV = first 16, hosts from literals, 1 GET', async () => {
    const key = 'Zx9TQ2kLmN4pQr7sTu1vWx3yZa5bCd8e';
    const sample = cbcEncrypt(key, key.slice(0, 16), { result: [{ id: 1 }] });
    const bundle = fs.readFileSync(path.join(FIX, 'ott-main.dart.js'), 'utf8').replace('__KEY__', key);
    const f = stubFetch({ '/main.dart.js': bundle });
    const r = await keys.extractOnetouchKey({ fetch: f, front: 'https://ott.example', sample });
    assert.equal(r.key, key);
    assert.equal(r.iv, key.slice(0, 16));
    assert.deepEqual(r.hosts, ['https://api4.devcorp.example']);
    assert.equal(f.calls.length, 1);
});

test('(c2) onetouchtv: no 32-char literal decrypts: key null, hosts still returned', async () => {
    const sample = cbcEncrypt('Zx9TQ2kLmN4pQr7sTu1vWx3yZa5bCd8e', 'Zx9TQ2kLmN4pQr7s', { result: [] });
    const bundle = fs.readFileSync(path.join(FIX, 'ott-main.dart.js'), 'utf8').replace('__KEY__', 'Q'.repeat(32));
    const r = await keys.extractOnetouchKey({ fetch: stubFetch({ '/main.dart.js': bundle }), front: 'https://ott.example', sample });
    assert.equal(r.key, null);
    assert.deepEqual(r.hosts, ['https://api4.devcorp.example']);
});

test('(d) parseVaConfig reads apiToken, streamDataApiUrl, rateLimited from the page; rateLimited:true is blocked', () => {
    const html = fs.readFileSync(path.join(FIX, 'va-player.html'), 'utf8');
    const c = keys.parseVaConfig(html);
    assert.equal(c.apiToken, 'TOKxyz');
    assert.equal(c.streamDataApiUrl, 'https://streamdata.vaplayer.example/api.php');
    assert.equal(c.rateLimited, false);
    const limited = keys.parseVaConfig(html.replace('rateLimited: false', 'rateLimited: true').replace('"TOKxyz"', '""'));
    assert.equal(limited.rateLimited, true);
    assert.equal(keys.parseVaConfig('<html>no config</html>'), null);
    assert.equal(classify({ message: keys.vaRateLimitedMessage() }), 'blocked');
});

test('(d2) vaplayer provider: regex misses, CONFIG present: token and streamDataApiUrl from CONFIG; rateLimited:true throws blocked', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    const seen = [];
    let page = fs.readFileSync(path.join(FIX, 'va-player.html'), 'utf8');
    global.fetch = async (url) => {
        const u = String(url); seen.push(u);
        if (u.includes('va_src.php')) return res(JSON.stringify({ src: 'https://player.example/embed/movie/tt1' }));
        if (u.startsWith('https://player.example/')) return res(page);
        if (u.includes('api.php')) return res(JSON.stringify({ status_code: '200', data: { file_name: 'X.mp4', stream_urls: ['https://cdn.example/pl/a/master.m3u8'] } }));
        if (u.includes('/generate.php')) return res('HT');
        if (u.includes('master.m3u8')) return res('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\n/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.m3u8\n');
        return res('', 404);
    };
    delete require.cache[require.resolve('../providers/vaplayer')];
    const tmdb = require('../utils/tmdb');
    const realResolve = tmdb.resolveImdbId;
    tmdb.resolveImdbId = async () => 'tt1';
    t.after(() => { tmdb.resolveImdbId = realResolve; });
    const { getVaplayerStreams } = require('../providers/vaplayer');
    const rows = await getVaplayerStreams('1', 'movie');
    const api = seen.find((u) => u.includes('api.php'));
    assert.ok(api.startsWith('https://streamdata.vaplayer.example/api.php?'), api);
    assert.ok(api.includes('api_token=TOKxyz'), api);
    assert.equal(rows.length, 1);

    page = page.replace('rateLimited: false', 'rateLimited: true').replace('"TOKxyz"', '""');
    await assert.rejects(() => getVaplayerStreams('2', 'movie'), (e) => classify({ message: e.message }) === 'blocked');
});

test('(e) vidrock: a wrong key now throws a key-class error (not an empty answer)', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    const enc = gcmEncrypt(GOOD, 'https://cdn.example/m.m3u8');
    global.fetch = async (url) => (String(url).includes('/api/movie/') ? res(JSON.stringify({ Nova: { url: enc, language: 'English' } })) : res('', 404));
    const vidrock = require('../providers/vidrock');
    await assert.rejects(() => vidrock.getVidrockStreams('579974', 'movie'), (e) => classify({ message: e.message }) === 'key');
    // The right key (as a trial) decrypts it.
    assert.equal(keys.withTrial('vidrock', { key: GOOD }, () => vidrock.decryptStreamUrl(enc)), 'https://cdn.example/m.m3u8');
});

// ---- the key heal run ----

function resetAll() {
    keys._reset(); upstream._reset();
    fs.rmSync(process.env.UPSTREAM_BASES_FILE, { force: true });
}

function fakeHeal(over = {}) {
    let extracts = 0; let verifies = 0;
    const opts = {
        extract: async () => { extracts++; return over.found === undefined ? { key: GOOD } : over.found; },
        verify: async (fields) => { verifies++; return over.verify === undefined ? keys.trial('vidrock', 'key') === fields.key : over.verify; },
    };
    return { opts, counts: () => ({ extracts, verifies }) };
}

test('key heal: 2 key failures do nothing, the 3rd runs once; adopt only after verify; logs adopt', async () => {
    resetAll();
    const h = fakeHeal();
    assert.equal(keys.noteKeyFail('vidrock', h.opts), null);
    assert.equal(keys.noteKeyFail('vidrock', h.opts), null);
    const run = keys.noteKeyFail('vidrock', h.opts);
    assert.ok(run);
    assert.equal(await run, true);
    assert.deepEqual(h.counts(), { extracts: 1, verifies: 1 });
    assert.equal(upstream.getField('vidrock', 'key').value, GOOD);
    // Cooldown: 3 more failures inside 30 min start nothing.
    for (let i = 0; i < 3; i++) assert.equal(keys.noteKeyFail('vidrock', h.opts), null);
    assert.equal(h.counts().extracts, 1);
});

test('key heal: verify fails (own resolve or title proof): nothing applied', async () => {
    resetAll();
    const h = fakeHeal({ verify: false });
    keys.noteKeyFail('vidrock', h.opts); keys.noteKeyFail('vidrock', h.opts);
    assert.equal(await keys.noteKeyFail('vidrock', h.opts), false);
    assert.equal(upstream.getField('vidrock', 'key'), null);
});

test('key heal: extractor finds nothing: no verify, nothing applied', async () => {
    resetAll();
    const h = fakeHeal({ found: null });
    keys.noteKeyFail('vidrock', h.opts); keys.noteKeyFail('vidrock', h.opts);
    assert.equal(await keys.noteKeyFail('vidrock', h.opts), false);
    assert.equal(h.counts().verifies, 0);
    assert.equal(upstream.getField('vidrock', 'key'), null);
});

test('key heal: a success between failures resets the key streak', () => {
    keys._reset();
    const h = fakeHeal();
    keys.noteKeyFail('vidrock', h.opts); keys.noteKeyFail('vidrock', h.opts);
    keys.noteKeyOk('vidrock');
    assert.equal(keys.noteKeyFail('vidrock', h.opts), null);
    assert.equal(keys.keyStreak('vidrock'), 1);
});

test('key heal: the found key equals the one in use: no apply (a key the provider already failed with)', async () => {
    resetAll();
    const h = fakeHeal({ found: { key: 'same' } });
    h.opts.current = () => ({ key: 'same' });
    keys.noteKeyFail('vidrock', h.opts); keys.noteKeyFail('vidrock', h.opts);
    assert.equal(await keys.noteKeyFail('vidrock', h.opts), false);
    assert.equal(h.counts().verifies, 0);
});

// ---- registry wiring ----

test('registry: 3 key errors start one key heal (factory built once), never the host streak; a host error resets the key streak', async () => {
    resetAll();
    const { _noteUpstream } = require('../providers/registry');
    let built = 0; let rows = 0;
    const mod = {
        UPSTREAM: { name: 'keystub', seed: 'https://keystub.test' },
        get: async () => { rows++; return []; },
        keyHeal: () => { built++; return { extract: async () => null }; },
    };
    const info = { name: 'keystub', functionName: 'get' };
    upstream._setDeps({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND keystub.test'); } });
    const keyErr = new Error('vidrock: decrypt failed on all 2 server(s) for 1: Unsupported state or unable to authenticate data');
    _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, keyErr);
    _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, new Error('getaddrinfo ENOTFOUND keystub.test'));
    assert.equal(keys.keyStreak('keystub'), 0);
    for (let i = 0; i < 3; i++) _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, keyErr);
    assert.equal(upstream.failStreak('keystub'), 1, 'only the ENOTFOUND counted toward the host streak');
    await new Promise((r) => setImmediate(r));
    assert.equal(built, 1);
    // Review I1: extract found no key, so the run falls back to one host
    // rediscover (stubbed fetch); the host STREAK still saw only the ENOTFOUND.
    const p = upstream.pending('keystub');
    if (p) await p;
    upstream._setDeps({});
});

test('registry: key heal verify runs the own resolve and title proof under the trial key', async () => {
    resetAll();
    const proof = require('../lib/selfheal/proof');
    const { _noteUpstream } = require('../providers/registry');
    let seenKey = null;
    const mod = {
        UPSTREAM: { name: 'keystub2', seed: 'https://keystub2.test', healRun: () => ({ titleProven: async () => true }) },
        get: async () => { seenKey = keys.trial('keystub2', 'key'); return [{ url: 'https://cdn/x.m3u8' }]; },
        keyHeal: () => ({ extract: async () => ({ key: GOOD }), current: () => ({ key: BAD }) }),
    };
    proof._setDeps({});
    const info = { name: 'keystub2', functionName: 'get' };
    const keyErr = new Error('bad decrypt');
    _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, keyErr);
    _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, keyErr);
    _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, keyErr);
    for (let i = 0; i < 20 && !upstream.getField('keystub2', 'key'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(seenKey, GOOD);
    assert.equal(upstream.getField('keystub2', 'key').value, GOOD);
    assert.equal(keys.trial('keystub2', 'key'), undefined, 'the trial does not leak outside the run');
});

test('onetouchtv heal run: the bundle trail offers api host literals from main.dart.js (1 GET)', async () => {
    const run = require('../lib/selfheal/onetouchtv').createRun({
        fetchOnce: async () => [], findBestOttMatch: () => null, bases: () => ['https://api3.devcorp.me'], front: () => 'https://ott.example',
    });
    const bundle = fs.readFileSync(path.join(FIX, 'ott-main.dart.js'), 'utf8');
    const f = stubFetch({ '/main.dart.js': bundle });
    const found = await run.trails[0]({ fetch: f });
    assert.deepEqual(found.map((c) => c.url), ['https://api4.devcorp.example']);
    assert.equal(found[0].how, 'bundle');
    assert.equal(run.budget.gets, 1);
});

test('onetouchtv: a wrong key is a key-class error with no retry', () => {
    const ott = require('../providers/onetouchtv');
    let err;
    try { ott._internal.decrypt(Buffer.from('x'.repeat(32)).toString('base64')); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(classify({ message: err.message }), 'key');
    assert.equal(ott._internal.isRetryable(err), false);
});

// ---- review batch 2, I1: a moved host answering 200 HTML must still heal ----

function captureWarn() {
    const lines = []; const w = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => { console.warn = w; } };
}
async function waitFor(fn, ms = 1000) {
    for (let t = 0; t < ms && !fn(); t += 5) await new Promise((r) => setTimeout(r, 5));
    return fn();
}

test('I1 onetouchtv: an HTML 200 body is not a key error and is not retried', () => {
    const ott = require('../providers/onetouchtv');
    for (const body of ['<!DOCTYPE html><html><head><title>Parked</title></head><body>domain for sale</body></html>', '{"error":"not found"}']) {
        let err;
        try { ott._internal.decrypt(body); } catch (e) { err = e; }
        assert.ok(err, body);
        assert.ok(!err.keyError, `keyError on ${body.slice(0, 20)}`);
        assert.notEqual(classify({ message: err.message }), 'key', err.message);
        assert.equal(ott._internal.isRetryable(err), false);
    }
});

test('I1 registry: HTML-200 failures count on the host streak and start a host rediscover, no key run', async () => {
    resetAll();
    const ott = require('../providers/onetouchtv');
    const { _noteUpstream } = require('../providers/registry');
    let err;
    try { ott._internal.decrypt('<!DOCTYPE html><html><body>parked</body></html>'); } catch (e) { err = e; }
    let keyRuns = 0;
    const mod = {
        UPSTREAM: { name: 'ottstub', seed: 'https://ottstub.test' },
        get: async () => [],
        keyHeal: () => { keyRuns++; return { extract: async () => null }; },
    };
    const info = { name: 'ottstub', functionName: 'get' };
    let gets = 0;
    upstream._setDeps({ fetch: async () => { gets++; throw new Error('getaddrinfo ENOTFOUND ottstub.test'); } });
    const cap = captureWarn();
    try {
        for (let i = 0; i < upstream.FAIL_STREAK; i++) _noteUpstream(info, mod, 'fail', { tmdbId: '579974' }, err);
        assert.equal(keys.keyStreak('ottstub'), 0);
        assert.ok(cap.lines.some((l) => /\[registry\] ottstub failed \d+x in a row .* rediscovering/.test(l)), cap.lines.join('\n'));
        const p = upstream.pending('ottstub');
        assert.ok(p, 'a host rediscover is running');
        await p;
    } finally { cap.restore(); upstream._setDeps({}); }
    assert.equal(keyRuns, 0);
    assert.ok(gets >= 1);
});

test('I1 key run: none or same falls back to one host rediscover', async () => {
    resetAll();
    let fb = 0;
    const none = { extract: async () => null, verify: async () => true, fallback: async () => { fb++; return { applied: 'https://new.test' }; } };
    assert.equal(await keys.runKeyHeal('vidrock', none), 'host');
    assert.equal(fb, 1);
    const same = { extract: async () => ({ key: 'k' }), current: () => ({ key: 'k' }), verify: async () => true, fallback: async () => { fb++; return null; } };
    assert.equal(await keys.runKeyHeal('vidrock', same), false);
    assert.equal(fb, 2);
});

test('I1 registry: 3 key errors, the bundle gives no key: one host rediscover runs', async () => {
    resetAll();
    const { _noteUpstream } = require('../providers/registry');
    const mod = {
        UPSTREAM: { name: 'keystub3', seed: 'https://keystub3.test' },
        get: async () => [],
        keyHeal: () => ({ extract: async () => null }),
    };
    const info = { name: 'keystub3', functionName: 'get' };
    let gets = 0;
    upstream._setDeps({ fetch: async () => { gets++; throw new Error('getaddrinfo ENOTFOUND keystub3.test'); } });
    const cap = captureWarn();
    try {
        for (let i = 0; i < 3; i++) _noteUpstream(info, mod, 'fail', { tmdbId: '1' }, new Error('bad decrypt'));
        assert.ok(await waitFor(() => cap.lines.some((l) => l.startsWith('[heal] keystub3 key none -> host rediscover'))), cap.lines.join('\n'));
        assert.ok(await waitFor(() => gets >= 1 && !upstream.pending('keystub3')), 'the rediscover ran');
    } finally { cap.restore(); upstream._setDeps({}); }
});
