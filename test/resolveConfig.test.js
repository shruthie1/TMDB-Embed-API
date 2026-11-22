'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const express = require('express');
const os = require('os');

// Task 3 (provider self-heal): the route serves the merged config view. Keep
// this run off any remote copy on disk and off the network.
delete process.env.RESOLVE_CONFIG_URL;
process.env.RESOLVE_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')), 'remote.json');

// A1 (docs/PENDING-WORK.md): GET /api/resolve-config is what the APK's
// ResolveConfigStore fetches. 1.1.9 logs "HTTP 404; using defaults" today.
// The served JSON must parse into EVERY field ResolveConfig.kt reads, and hold
// exactly the app's current defaults, so serving it changes nothing until a
// value is edited on purpose.

const KT = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'chitram', 'app', 'resolve', 'ResolveConfig.kt');
const kt = fs.readFileSync(KT, 'utf8');

// Every `name = o.<reader>("key")` inside a parse function.
function readsIn(fnName) {
  const body = kt.split(`private fun ${fnName}(o: JsonObject)`)[1].split('\n        }\n')[0];
  return [...body.matchAll(/o\.(\w+)\("(\w+)"\)|\(o\["(\w+)"\] as\? JsonObject\)/g)]
    .map((m) => ({ reader: m[1] || 'object', key: m[2] || m[3] }));
}

const consts = Object.fromEntries([...kt.matchAll(/const val (\w+) = "([^"]*)"/g)].map((m) => [m[1], m[2]]));

function literal(src) {
  const s = src.trim();
  if (/^"/.test(s)) return JSON.parse(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (consts[s] !== undefined) return consts[s];
  if (/^\w+\(\)$/.test(s)) return null; // nested config, checked on its own
  if (s === 'DEFAULT_PREWARM') return null; // per-section `prewarm`, checked on its own
  if (/^listOf\(/.test(s)) return [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (/^mapOf\(/.test(s)) {
    return Object.fromEntries([...s.matchAll(/"([^"]+)" to ([\d_]+)L?/g)].map((m) => [m[1], Number(m[2].replace(/_/g, ''))]));
  }
  const expr = s.replace(/_/g, '').replace(/(\d)L\b/g, '$1');
  assert.match(expr, /^[\d\s*+]+$/, `unparsed default: ${s}`);
  return expr.split('*').reduce((p, x) => p * Number(x.trim()), 1);
}

// `val name: Type = default,` in one data class.
function defaultsOf(cls) {
  const body = kt.split(`data class ${cls}(`)[1].split('\n)')[0];
  const out = {};
  for (const m of body.matchAll(/^\s*val (\w+): [^=]+= (.+?),?$/gm)) out[m[1]] = literal(m[2].replace(/,$/, ''));
  return out;
}

async function serve(source) {
  const app = express();
  require('../routes/resolveConfig').registerResolveConfigRoute(app, source);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/resolve-config`);
  const body = await r.text();
  await new Promise((r2) => server.close(r2));
  return { r, body };
}

test('A1: GET /api/resolve-config is 200 JSON with a short cache header', async () => {
  const { r, body } = await serve();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  const cc = r.headers.get('cache-control');
  const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1]);
  assert.ok(maxAge > 0 && maxAge <= 600, cc);
  JSON.parse(body);
});

test('A1: every field ResolveConfig.kt reads is present with the right JSON type', async () => {
  const cfg = JSON.parse((await serve()).body);
  const typeOf = { str: 'string', path: 'string', int: 'number', long: 'number', bool: 'boolean',
    strings: 'array', hosts: 'array', object: 'object' };
  const check = (obj, fields, where) => {
    assert.ok(fields.length > 5, `parsed too few fields from ${where}`);
    for (const { reader, key } of fields) {
      assert.ok(key in obj, `${where}.${key} missing`);
      const t = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
      assert.equal(t, typeOf[reader], `${where}.${key} is ${t}, ResolveConfig reads it with o.${reader}`);
      if (reader === 'path') assert.match(obj[key], /^\//, `${where}.${key} must start with /`);
      if (reader === 'hosts') obj[key].forEach((h) => assert.match(h, /^https:\/\//));
    }
  };
  for (const k of ['version', 'ttlSec', 'mapple', 'vaplayer', 'netmirror']) assert.ok(k in cfg, `${k} missing`);
  check(cfg.mapple, readsIn('mapple'), 'mapple');
  check(cfg.vaplayer, readsIn('vaplayer'), 'vaplayer');
  check(cfg.netmirror, readsIn('netmirror'), 'netmirror');
});

test('A1: values equal the app defaults exactly', async () => {
  const cfg = JSON.parse((await serve()).body);
  const top = defaultsOf('ResolveConfig');
  assert.equal(cfg.version, top.version);
  assert.equal(cfg.ttlSec, top.ttlSec);
  assert.deepStrictEqual(noPrewarm(cfg.mapple), defaultsOf('MappleConfig'));
  assert.deepStrictEqual(noPrewarm(cfg.vaplayer), defaultsOf('VaplayerConfig'));
  assert.deepStrictEqual(noPrewarm(cfg.netmirror), defaultsOf('NetmirrorConfig'));
});

// prewarm.md: the served `<provider>.prewarm` flags equal ResolveConfig.DEFAULT_PREWARM.
function noPrewarm(sec) { const { prewarm, ...rest } = sec; return rest; }
test('prewarm: served flags equal the APK built-in DEFAULT_PREWARM', async () => {
  const cfg = JSON.parse((await serve()).body);
  const def = [...kt.match(/val DEFAULT_PREWARM = setOf\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const on = Object.keys(cfg).filter((k) => cfg[k] && cfg[k].prewarm === true).sort();
  assert.deepStrictEqual(on, def);
});

const selfhealConfig = require('../lib/selfheal/config');

test('Task 3: a heal shows in the served config', async () => {
  selfhealConfig.setHeals({ vaplayer: { fields: { wrapperBases: { value: ['https://va.healed'], how: 'redirect', over: null } } } });
  try {
    const cfg = JSON.parse((await serve()).body);
    assert.deepStrictEqual(cfg.vaplayer.wrapperBases, ['https://va.healed']);
  } finally { selfhealConfig.setHeals({}); }
  const again = JSON.parse((await serve()).body);
  assert.notDeepStrictEqual(again.vaplayer.wrapperBases, ['https://va.healed']);
});

test('Task 3: new provider sections equal the provider constants', async () => {
  const cfg = JSON.parse((await serve()).body);
  for (const name of ['castletv', 'multimovies', 'vidrock', 'vidrift', 'onetouchtv', 'showsst']) {
    const mod = require(`../providers/${name}`);
    assert.ok(mod.CONFIG_DEFAULTS, `${name} exports CONFIG_DEFAULTS`);
    assert.deepStrictEqual(noPrewarm(cfg[name]), mod.CONFIG_DEFAULTS, name);
  }
});

test('Task 3: unknown top-level keys survive the merge', async () => {
  const builtin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'routes', 'resolve-config.json'), 'utf8'));
  const source = selfhealConfig.createConfig({ builtin: { ...builtin, routes: { castletv: { web: 'direct' } }, zzz: [1] } });
  const cfg = JSON.parse((await serve(source)).body);
  assert.deepStrictEqual(cfg.zzz, [1]);
  assert.deepStrictEqual(cfg.routes, { castletv: { web: 'direct' } });
});

test('Task 3: a snapshot that cannot be built is a 500', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let r;
  try { r = (await serve({ snapshot: () => { throw new Error('boom'); } })).r; } finally { console.error = orig; }
  assert.equal(r.status, 500);
  assert.ok(errors.some((l) => l.startsWith('[resolve-config] snapshot failed')), errors.join('\n'));
});

test('M3: a broken built-in file is a 500 again', async () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcfg-')), 'resolve-config.json');
  fs.writeFileSync(bad, '{ broken');
  const source = selfhealConfig.createConfig({ builtin: bad });
  const errors = [];
  const orig = { error: console.error, warn: console.warn };
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = () => {};
  let r;
  try { r = (await serve(source)).r; } finally { Object.assign(console, orig); }
  assert.equal(r.status, 500);
  assert.ok(errors.some((l) => l.startsWith('[resolve-config] snapshot failed: built-in config unreadable')), errors.join('\n'));
});
