'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

// Process-level reliability: health detail, request ids in logs, a per-IP
// limit on the open proxy routes, boot-time config checks, graceful stop.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const NAMES = ['castletv', 'netmirror'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
    name, enabled: true, fetch: async () => { console.log(`[fake] ${name} ran`); return []; },
}]));
stub('providers/registry.js', {
    listProviders: () => NAMES.map((name) => ({ name, enabled: true })),
    getProvider: (n) => fake[String(n).toLowerCase()] || null,
    getCookieStats: () => ({}),
    PROVIDER_DEADLINE_MS: 20000,
});
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });
process.env.PROXY_RATE_LIMIT_PER_MIN = '3';

const { recordProviderOutcome, BREAKER_THRESHOLD } = require('../lib/runtime/metrics');
const app = require('../apiServer');

let base, server;
test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('/api/health reports memory, uptime and open breakers', async () => {
    for (let i = 0; i < BREAKER_THRESHOLD; i++) recordProviderOutcome('netmirror', 'error', 1, 0);
    const d = await (await fetch(`${base}/api/health`)).json();
    assert.equal(d.ok, true);
    assert.equal(typeof d.memory.rssMB, 'number');
    assert.equal(typeof d.uptimeS, 'number');
    assert.deepEqual(d.openBreakers, ['netmirror']);
    assert.equal(d.breakers.netmirror.open, true);
    assert.ok(d.breakers.netmirror.reopensInS > 0);
});

test('every response carries X-Request-Id and reuses a sane incoming one', async () => {
    const a = await fetch(`${base}/api/health`);
    assert.match(a.headers.get('x-request-id') || '', /^[0-9a-f]{8}$/);
    const b = await fetch(`${base}/api/health`, { headers: { 'X-Request-Id': 'edge-42' } });
    assert.equal(b.headers.get('x-request-id'), 'edge-42');
    const c = await fetch(`${base}/api/health`, { headers: { 'X-Request-Id': 'bad id with spaces' } });
    assert.notEqual(c.headers.get('x-request-id'), 'bad id with spaces');
});

test('log lines a request causes carry its id', async () => {
    const lines = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return orig(chunk, ...rest); };
    try {
        await fetch(`${base}/api/streams/movie/4242?refresh=1`, { headers: { 'X-Request-Id': 'trace-7' } });
    } finally { process.stdout.write = orig; }
    const ran = lines.filter((l) => l.includes('[fake] castletv ran'));
    assert.ok(ran.length >= 1, 'provider log line seen');
    assert.ok(ran.every((l) => l.startsWith('[trace-7] ')), ran.join('|'));
});

test('proxy routes are rate limited per IP; other routes are not', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await fetch(`${base}/m3u8-proxy`)).status);
    assert.notEqual(codes[2], 429);
    assert.equal(codes[3], 429);
    const after = await fetch(`${base}/ts-proxy`);
    assert.equal(after.status, 429, 'the limit is shared across proxy routes');
    assert.ok(Number(after.headers.get('retry-after')) > 0);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('startup check flags a broken PUBLIC_BASE_URL, a bad port and unknown providers', () => {
    const { checkStartupConfig } = require('../lib/runtime/startupCheck');
    const ok = checkStartupConfig({ port: 8787, tmdbApiKeys: ['k'], defaultProviders: [] },
        { PUBLIC_BASE_URL: 'https://x.example', PRIMARY_PROVIDERS: 'castletv,netmirror' }, NAMES);
    assert.deepEqual(ok, { errors: [], warnings: [] });
    const bad = checkStartupConfig({ port: 99999, tmdbApiKeys: [], defaultProviders: ['nope'] },
        { PUBLIC_BASE_URL: 'tmdb.example', PRIMARY_PROVIDERS: 'castle' }, NAMES);
    assert.equal(bad.errors.length, 2, bad.errors.join('; '));
    assert.equal(bad.warnings.length, 3, bad.warnings.join('; '));
});

test('SIGTERM lets the server close and exit 0', async () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'apiServer.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '18797', BIND_HOST: '127.0.0.1', PROXY_RATE_LIMIT_PER_MIN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const deadline = Date.now() + 15000;
    while (!/listening on/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /listening on/, 'server started');
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    child.kill('SIGTERM');
    const res = await Promise.race([exited, new Promise((r) => setTimeout(() => r('TIMEOUT'), 10000))]);
    if (res === 'TIMEOUT') child.kill('SIGKILL');
    assert.deepEqual(res, { code: 0, signal: null }, out.slice(-500));
    assert.match(out, /\[shutdown\] SIGTERM/);
});
