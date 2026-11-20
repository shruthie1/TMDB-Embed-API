'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const express = require('express');

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

async function serve() {
  const app = express();
  require('../routes/resolveConfig').registerResolveConfigRoute(app);
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
  for (const k of ['version', 'ttlSec', 'mapple', 'vaplayer']) assert.ok(k in cfg, `${k} missing`);
  check(cfg.mapple, readsIn('mapple'), 'mapple');
  check(cfg.vaplayer, readsIn('vaplayer'), 'vaplayer');
});

test('A1: values equal the app defaults exactly', async () => {
  const cfg = JSON.parse((await serve()).body);
  const top = defaultsOf('ResolveConfig');
  assert.equal(cfg.version, top.version);
  assert.equal(cfg.ttlSec, top.ttlSec);
  assert.deepStrictEqual(cfg.mapple, defaultsOf('MappleConfig'));
  assert.deepStrictEqual(cfg.vaplayer, defaultsOf('VaplayerConfig'));
});
