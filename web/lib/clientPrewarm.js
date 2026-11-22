'use client';

/**
 * Browser-side provider rows, kept and prewarmed (P14 + P15).
 *
 * Only OneTouchTV resolves in a browser today (lib/oneTouchClient.js). CastleTV
 * stays off on the web until one real browser check shows its getVideo2 POST
 * passes the CORS preflight from chtrm2 (owner rule 2026-11-22). NetMirror,
 * MultiMovies, Vidrift, mapple, VaPlayer and ShowsSt cannot run in a browser.
 *
 * Rows are kept in the client stream cache under `c:onetouchtv` (30 min, URL
 * expiry, 50 titles). A prewarm and a Play fallback for the same title share
 * one running resolve.
 */
import { resolveOneTouchRows } from './oneTouchClient';
import { titleKey, getSlot, hasSlot, putSlot } from './streamCache';
import { logPrewarm, browserOffline } from './backend';

const SLOT = 'c:onetouchtv';
const running = new Map();

function shared(key, args, resolver) {
  const now = running.get(key);
  if (now) return now;
  // Not tied to one caller's signal: a prewarm's answer is still worth keeping
  // after the page that asked for it is gone.
  const p = Promise.resolve()
    .then(() => resolver({ ...args, signal: undefined }))
    .then((rows) => {
      if (Array.isArray(rows) && rows.length) putSlot(key, SLOT, rows);
      return Array.isArray(rows) ? rows : [];
    })
    .finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

/** OneTouchTV rows for a title: kept rows first (0 requests), else one resolve. */
export function oneTouchRowsCached({ type, tmdbId, season = 0, episode = 0, signal, resolver = resolveOneTouchRows }) {
  const key = titleKey(type, tmdbId, season, episode);
  const kept = getSlot(key, SLOT);
  if (kept) return Promise.resolve(kept);
  const p = shared(key, { type, tmdbId, season, episode }, resolver);
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    p.then(resolve, reject);
  });
}

/** Details-page prewarm of the browser-side providers. Fire-and-forget. */
export function prewarmClientProviders(type, tmdbId, { season = 0, episode = 0, resolver = resolveOneTouchRows } = {}) {
  if (!tmdbId) return;
  const key = titleKey(type, tmdbId, season, episode);
  if (browserOffline()) { logPrewarm('onetouchtv', `skip offline ${key}`); return; }
  if (hasSlot(key, SLOT) || running.has(key)) { logPrewarm('onetouchtv', `skip kept-or-running ${key}`); return; }
  logPrewarm('onetouchtv', `start ${key}`);
  const t0 = Date.now();
  shared(key, { type, tmdbId, season, episode }, resolver)
    .then((rows) => logPrewarm('onetouchtv', `done ${key} rows=${rows.length} ms=${Date.now() - t0}`))
    .catch((e) => logPrewarm('onetouchtv', `failed ${key} ${String(e?.message || e).slice(0, 80)}`));
}

export function _resetClientPrewarm() { running.clear(); }
