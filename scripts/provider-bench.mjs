#!/usr/bin/env node
// Provider benchmark: one GET per (provider, title) against the per-provider
// route, plus optionally the aggregate route. Read-only.
//
//   node scripts/provider-bench.mjs --base http://localhost:8790 --out bench.json
//   node scripts/provider-bench.mjs --base https://tmdb-187-127-137-163.sslip.io --aggregate
//
// Titles run one at a time per provider (providers in parallel), so no single
// upstream sees a burst. NetMirror and showsst rate limit per IP.

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--base', 'http://localhost:8790').replace(/\/$/, '');
const OUT = opt('--out', null);
const TIMEOUT_MS = Number(opt('--timeout', 60000));
const AGG = args.includes('--aggregate');
const ONLY_AGG = args.includes('--aggregate-only');
const PROVIDERS = (opt('--providers', 'castletv,netmirror,onetouchtv,vaplayer,mapple,showsst'))
  .split(',').filter(Boolean);

export const TITLES = [
  { id: 1376856, type: 'movie', label: 'The Paradise (te)' },
  { id: 690957, type: 'movie', label: 'Pushpa (te)' },
  { id: 811941, type: 'movie', label: 'Devara (te)' },
  { id: 801688, type: 'movie', label: 'Kalki 2898-AD (te)' },
  { id: 927342, type: 'movie', label: 'Amaran (ta)' },
  { id: 1075794, type: 'movie', label: 'Leo (ta)' },
  { id: 1112426, type: 'movie', label: 'Stree 2 (hi)' },
  { id: 1069945, type: 'movie', label: 'Manjummel Boys (ml)' },
  { id: 1084812, type: 'movie', label: 'Aavesham (ml)' },
  { id: 693134, type: 'movie', label: 'Dune: Part Two (en)' },
  { id: 872585, type: 'movie', label: 'Oppenheimer (en)' },
  { id: 12259, type: 'movie', label: 'Sholay 1975 (hi, old)' },
  { id: 101352, type: 'series', season: 1, episode: 1, label: 'Panchayat S1E1 (hi tv)' },
  { id: 84105, type: 'series', season: 1, episode: 1, label: 'Mirzapur S1E1 (hi tv)' },
];

function url(t, provider) {
  const qs = t.season ? `?season=${t.season}&episode=${t.episode}` : '';
  return provider
    ? `${BASE}/api/streams/${provider}/${t.type}/${t.id}${qs}`
    : `${BASE}/api/streams/${t.type}/${t.id}${qs}${qs ? '&' : '?'}refresh=1`;
}

async function one(t, provider) {
  const t0 = Date.now();
  try {
    const r = await fetch(url(t, provider), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = Date.now() - t0;
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.success === false) {
      return { provider: provider || 'AGGREGATE', id: t.id, label: t.label, outcome: 'error', ms, status: r.status, err: d?.message || d?.error || null };
    }
    const n = Array.isArray(d.streams) ? d.streams.length : 0;
    return {
      provider: provider || 'AGGREGATE', id: t.id, label: t.label, outcome: n > 0 ? 'hit' : 'empty', ms, count: n,
      providers: [...new Set((d.streams || []).map((s) => s.provider))],
      timings: provider ? undefined : d.providerTimings,
    };
  } catch (e) {
    return { provider: provider || 'AGGREGATE', id: t.id, label: t.label, outcome: e.name === 'TimeoutError' ? 'timeout' : 'error', ms: Date.now() - t0, err: String(e.message || e) };
  }
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

export function summarise(rows) {
  const by = {};
  for (const r of rows) (by[r.provider] ||= []).push(r);
  const out = {};
  for (const [p, rs] of Object.entries(by)) {
    const ms = rs.map((r) => r.ms);
    out[p] = {
      n: rs.length,
      hit: rs.filter((r) => r.outcome === 'hit').length,
      empty: rs.filter((r) => r.outcome === 'empty').length,
      error: rs.filter((r) => r.outcome === 'error').length,
      timeout: rs.filter((r) => r.outcome === 'timeout').length,
      p50: pct(ms, 50), p95: pct(ms, 95),
    };
  }
  return out;
}

async function main() {
  const started = new Date().toISOString();
  const rows = [];
  if (!ONLY_AGG) {
    await Promise.all(PROVIDERS.map(async (p) => {
      for (const t of TITLES) rows.push(await one(t, p));
    }));
  }
  if (AGG || ONLY_AGG) for (const t of TITLES) rows.push(await one(t, null));
  const summary = summarise(rows);
  const result = { base: BASE, started, finished: new Date().toISOString(), summary, rows };
  if (OUT) {
    const fs = await import('node:fs');
    fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  }
  console.log(`base ${BASE}  ${started}`);
  console.log('provider      hit/n  empty err tmo   p50ms  p95ms');
  for (const [p, s] of Object.entries(summary)) {
    console.log(`${p.padEnd(12)} ${String(s.hit).padStart(3)}/${String(s.n).padEnd(3)} ${String(s.empty).padStart(4)} ${String(s.error).padStart(3)} ${String(s.timeout).padStart(3)} ${String(s.p50).padStart(7)} ${String(s.p95).padStart(6)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
