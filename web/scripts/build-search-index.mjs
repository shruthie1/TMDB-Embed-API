#!/usr/bin/env node
/**
 * Build the local Indian title index that search ranks against.
 *
 * TMDB's /search is literal and ranks by its own relevance, so a short prefix
 * such as "pu" or "sala" rarely surfaces Pushpa or Salaar. A small local list
 * of the popular Indian titles fixes that without a request per keystroke.
 *
 * Run by hand (it is never built on a request), then commit the output:
 *   node web/scripts/build-search-index.mjs
 * Measured 2026-11-15: 250 requests, ~13 s, ~2,850 titles.
 *
 * The key comes from TMDB_V3_KEY in the environment or web/.env.local. It is
 * never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const OUT = path.join(webDir, 'lib', 'data', 'search-index.json');

function readKey() {
  if (process.env.TMDB_V3_KEY) return process.env.TMDB_V3_KEY.trim();
  try {
    const env = fs.readFileSync(path.join(webDir, '.env.local'), 'utf8');
    const m = env.match(/^TMDB_V3_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

const KEY = readKey();
if (!KEY) { console.error('TMDB_V3_KEY not set (env or web/.env.local)'); process.exit(1); }

const BASE = process.env.TMDB_API_BASE || 'https://api.tmdb.org/3';
const LANGS = ['te', 'ta', 'hi', 'ml', 'kn'];
const TYPES = ['movie', 'tv'];
const PAGES = Number(process.env.PAGES || 25);

const jobs = [];
for (const lang of LANGS) for (const type of TYPES) for (let p = 1; p <= PAGES; p++) jobs.push({ lang, type, p });

const out = new Map();
let reqs = 0, fail = 0;
const t0 = Date.now();
// Latin-script original titles help matching; native-script ones never match
// a typed query, so they are dropped to keep the file small.
const latin = (s) => /[a-z]/i.test(s || '');

async function worker() {
  while (jobs.length) {
    const { lang, type, p } = jobs.shift();
    reqs++;
    const qs = new URLSearchParams({
      api_key: KEY, with_original_language: lang, sort_by: 'popularity.desc',
      'vote_count.gte': '3', include_adult: 'false', page: String(p),
    });
    try {
      const r = await fetch(`${BASE}/discover/${type}?${qs}`);
      if (!r.ok) { fail++; continue; }
      const d = await r.json();
      for (const m of d.results || []) {
        const title = m.title || m.name;
        const orig = m.original_title || m.original_name || '';
        const date = m.release_date || m.first_air_date || '';
        out.set(`${type}-${m.id}`, [
          m.id, type === 'tv' ? 1 : 0, title,
          latin(orig) && orig !== title ? orig : '',
          m.original_language, date ? Number(date.slice(0, 4)) : 0,
          Math.round((m.popularity || 0) * 100) / 100, m.vote_count || 0,
          Math.round((m.vote_average || 0) * 10) / 10, m.poster_path || '',
        ]);
      }
    } catch { fail++; }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const rows = [...out.values()].sort((a, b) => b[6] - a[6]);
const doc = {
  builtAt: new Date().toISOString().slice(0, 10),
  fields: ['id', 'tv', 'title', 'original_title', 'original_language', 'year',
           'popularity', 'vote_count', 'vote_average', 'poster_path'],
  rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc));
console.log(`reqs=${reqs} fail=${fail} titles=${rows.length} bytes=${fs.statSync(OUT).size} ms=${Date.now() - t0}`);
if (fail > reqs * 0.1) process.exit(2);
