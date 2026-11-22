'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  urlExpiresAt, isUrlExpired, cappedTtlMs, anyStreamExpired, dropExpiredStreams,
} = require('../lib/urlExpiry');

const NOW = 1_800_000_000_000; // fixed clock for the parser tests
const sec = (ms) => Math.floor(ms / 1000);

test('e= in seconds', () => {
  const exp = NOW + 3600_000;
  assert.equal(urlExpiresAt(`https://cdn.x/a.m3u8?st=abc&e=${sec(exp)}`, NOW), sec(exp) * 1000);
});

test('expire= in milliseconds', () => {
  const exp = NOW + 7200_000;
  assert.equal(urlExpiresAt(`https://cdn.x/a.m3u8?expire=${exp}&sig=z`, NOW), exp);
});

test('internal_token v3.<13 digit ms>', () => {
  const exp = NOW + 600_000;
  assert.equal(urlExpiresAt(`https://cdn.x/a.mp4?internal_token=v3.${exp}.deadbeef`, NOW), exp);
});

test('no expiry -> null', () => {
  assert.equal(urlExpiresAt('https://cdn.x/a.m3u8?token=abc&end=5', NOW), null);
  assert.equal(urlExpiresAt('https://cdn.x/a.m3u8', NOW), null);
  assert.equal(urlExpiresAt(null, NOW), null);
  assert.equal(isUrlExpired('https://cdn.x/a.m3u8', 30_000, NOW), false);
});

test('absurd values -> null', () => {
  // Far past (2001), far future (2100 in ms), and a 13-digit ms 5 years out.
  assert.equal(urlExpiresAt('https://cdn.x/a?e=1000000000', NOW), null);
  assert.equal(urlExpiresAt('https://cdn.x/a?expire=4102444800000', NOW), null);
  assert.equal(urlExpiresAt(`https://cdn.x/a?e=${NOW + 5 * 365 * 86400_000}`, NOW), null);
});

test('proxied URL: expiry read from the encoded upstream', () => {
  const exp = NOW + 900_000;
  const up = `https://cdn.x/a.m3u8?e=${sec(exp)}&s=1`;
  const proxied = `http://127.0.0.1:8790/m3u8-proxy?url=${encodeURIComponent(up)}`;
  assert.equal(urlExpiresAt(proxied, NOW), sec(exp) * 1000);
});

test('skew: a URL expiring within 30s counts as expired', () => {
  assert.equal(isUrlExpired(`https://cdn.x/a?e=${sec(NOW + 20_000)}`, 30_000, NOW), true);
  assert.equal(isUrlExpired(`https://cdn.x/a?e=${sec(NOW + 40_000)}`, 30_000, NOW), false);
  assert.equal(isUrlExpired(`https://cdn.x/a?e=${sec(NOW - 60_000)}`, 30_000, NOW), true);
});

test('cappedTtlMs: min(base, earliest expiry - skew)', () => {
  const rows = [{ url: `https://cdn.x/a?e=${sec(NOW + 120_000)}` }, { url: 'https://cdn.x/b' }];
  assert.equal(cappedTtlMs(600_000, rows, 30_000, NOW), 90_000);
  assert.equal(cappedTtlMs(600_000, [{ url: 'https://cdn.x/b' }], 30_000, NOW), 600_000);
  assert.ok(cappedTtlMs(600_000, [{ url: `https://cdn.x/a?e=${sec(NOW)}` }], 30_000, NOW) <= 0);
  assert.equal(anyStreamExpired(rows, 30_000, NOW + 100_000), true);
  assert.equal(dropExpiredStreams(rows, 30_000, NOW + 100_000).length, 1);
});

// ---- Route wiring: cache read, cache store, re-resolve ----

function stub(rel, exports) {
  const id = require.resolve(path.join(__dirname, '..', rel));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const calls = {};
const plan = {};
const NAMES = ['castletv', 'netmirror'];
const fake = Object.fromEntries(NAMES.map((name) => [name, {
  name, enabled: true,
  fetch: async (ctx) => {
    const k = `${name}:${ctx.tmdbId}`;
    calls[k] = (calls[k] || 0) + 1;
    const f = plan[ctx.tmdbId] && plan[ctx.tmdbId][name];
    return f ? f(calls[k]) : [];
  },
}]));
stub('providers/registry.js', {
  listProviders: () => NAMES.map((name) => ({ name, enabled: true })),
  getProvider: (n) => fake[String(n).toLowerCase()] || null,
  getCookieStats: () => ({}),
  PROVIDER_DEADLINE_MS: 20000,
});
process.env.PREFERRED_AUDIO_LANGUAGE = 'Telugu';
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, resolveImdbId: async () => 'tt0000001' });
const app = require('../apiServer');

let base, server;
const realNow = Date.now;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { Date.now = realNow; server.close(); });
const get = async (p) => (await fetch(`${base}${p}`)).json();
const row = (expMs, tag = '') => ({ provider: 'NetMirror', name: 'NetMirror', title: `NM ${tag}`, quality: '1080p',
  url: `https://cdn.example/nm/${tag}.m3u8?e=${sec(expMs)}`, type: 'hls', languages: ['Telugu'] });

test('unexpired URL is served, and served again from cache', async () => {
  plan[7001] = { netmirror: () => [row(Date.now() + 3600_000, 'live')] };
  const a = await get('/api/streams/movie/7001');
  const b = await get('/api/streams/movie/7001');
  assert.equal(a.count, 1);
  assert.equal(b.count, 1);
  assert.equal(b.cached, true);
  assert.equal(calls['netmirror:7001'], 1);
  const c = await get('/api/streams/netmirror/movie/7001');
  assert.equal(c.count, 1);
  assert.equal(calls['netmirror:7001'], 1, 'per-provider route reuses the cached row');
});

test('URL already expired from the provider is not served or cached', async () => {
  plan[7002] = { netmirror: () => [row(Date.now() - 60_000, 'dead')] };
  const a = await get('/api/streams/movie/7002');
  assert.equal(a.count, 0);
  const b = await get('/api/streams/netmirror/movie/7002');
  assert.equal(b.count, 0);
  assert.equal(calls['netmirror:7002'], 2, 'nothing cached, so the second call resolves again');
});

test('cached entry past its URL expiry re-resolves instead of returning empty', async () => {
  // First resolve: URL valid for 120s. Second: a fresh URL.
  plan[7003] = { netmirror: (n) => [row(Date.now() + (n === 1 ? 120_000 : 3600_000), `v${n}`)] };
  const a = await get('/api/streams/movie/7003');
  assert.equal(a.count, 1);
  assert.match(a.streams[0].url, /v1/);
  assert.equal(calls['netmirror:7003'], 1);
  // 100s later: past expiry minus 30s skew, well inside the 10-min fixed TTL.
  Date.now = () => realNow() + 100_000;
  try {
    const b = await get('/api/streams/movie/7003');
    assert.equal(calls['netmirror:7003'], 2, 'provider called again');
    assert.equal(b.count, 1, 'fresh stream served, not an empty answer');
    assert.notEqual(b.cached, true);
    assert.match(b.streams[0].url, /v2/);
  } finally { Date.now = realNow; }
});

test('per-provider route: expired cached entry re-resolves', async () => {
  plan[7004] = { netmirror: (n) => [row(Date.now() + (n === 1 ? 120_000 : 3600_000), `p${n}`)] };
  const a = await get('/api/streams/netmirror/movie/7004');
  assert.equal(a.count, 1);
  Date.now = () => realNow() + 100_000;
  try {
    const b = await get('/api/streams/netmirror/movie/7004');
    assert.equal(calls['netmirror:7004'], 2);
    assert.equal(b.count, 1);
    assert.match(b.streams[0].url, /p2/);
  } finally { Date.now = realNow; }
});

// Gap 11.2: CastleTV signs with `Expires=` (capital E). The VM caches must cap
// an entry at that expiry, not keep it the full 30 min.
test('Expires= (Castle, capital E) caps the entry', () => {
  const exp = NOW + 10 * 60_000;
  const url = `https://img1.hscow.com/x.m3u8?Expires=${sec(exp)}&KeyName=k&Signature=s`;
  assert.equal(urlExpiresAt(url, NOW), sec(exp) * 1000);
  const ttl = cappedTtlMs(30 * 60_000, [{ url }], 30_000, NOW);
  assert.ok(ttl < 30 * 60_000, `ttl ${ttl}`);
  assert.equal(ttl, sec(exp) * 1000 - 30_000 - NOW);
});
