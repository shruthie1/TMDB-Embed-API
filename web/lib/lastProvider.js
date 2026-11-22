'use client';

// The provider that last reached playback and played >= 10 s, per title (and
// season/episode for TV). P8, 2026-11-22: same rule as the APK.
//
// This is only a preference. Signed URLs expire and provider health changes,
// so the resolver still validates it and falls back when necessary, and the
// language choice always wins (lib/backend.js applyLastProvider).
//
// One localStorage map, capped at LAST_PROVIDER_MAX titles; the oldest write
// goes first. The v1 layout (one key per title) is still read.
const V1_PREFIX = 'chitram:last-provider:v1:';
const STORE_KEY = 'chitram:last-provider:v2';
export const LAST_PROVIDER_MAX = 300;
export const LAST_PROVIDER_MIN_PLAY_S = 10;

const idOf = (mediaType, tmdbId, season = 0, episode = 0) => `${mediaType}:${tmdbId}:${season || 0}:${episode || 0}`;

function log(line) { try { console.info(line); } catch { /* never breaks play */ } }

function readMap() {
  try {
    const m = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch { return {}; }
}
function writeMap(m) {
  const keys = Object.keys(m);
  if (keys.length > LAST_PROVIDER_MAX) {
    keys.sort((a, b) => (m[a]?.at || 0) - (m[b]?.at || 0));
    for (const k of keys.slice(0, keys.length - LAST_PROVIDER_MAX)) delete m[k];
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* quota or private mode */ }
}

export function getLastProvider(mediaType, tmdbId, season = 0, episode = 0) {
  if (!mediaType || !tmdbId || typeof localStorage === 'undefined') return null;
  const id = idOf(mediaType, tmdbId, season, episode);
  const p = readMap()[id]?.p;
  if (p) return p;
  try { return localStorage.getItem(`${V1_PREFIX}${id}`) || null; } catch { return null; }
}

export function rememberProvider(mediaType, tmdbId, provider, season = 0, episode = 0, now = Date.now()) {
  if (!mediaType || !tmdbId || !provider || typeof localStorage === 'undefined') return;
  const id = idOf(mediaType, tmdbId, season, episode);
  const m = readMap();
  if (m[id]?.p === provider) { m[id].at = now; writeMap(m); return; }
  m[id] = { p: provider, at: now };
  writeMap(m);
  log(`[last] ${id} provider=${provider} saved`);
}

export function forgetProvider(mediaType, tmdbId, provider, season = 0, episode = 0) {
  if (!mediaType || !tmdbId || typeof localStorage === 'undefined') return;
  const id = idOf(mediaType, tmdbId, season, episode);
  const m = readMap();
  if (m[id] && (!provider || m[id].p === provider)) {
    delete m[id];
    writeMap(m);
    log(`[last] ${id} provider=${provider || '?'} failed`);
  }
  try {
    const key = `${V1_PREFIX}${id}`;
    if (!provider || localStorage.getItem(key) === provider) localStorage.removeItem(key);
  } catch { /* nothing kept */ }
}

/**
 * Seconds actually played on one stream, from `timeupdate` deltas. A seek is
 * not play time: a jump larger than 2 s counts nothing. Returns a function
 * that takes the current time and answers true ONCE, when the total first
 * reaches `minS`.
 */
export function playedTimer(minS = LAST_PROVIDER_MIN_PLAY_S) {
  let last = null;
  let total = 0;
  let done = false;
  return (t) => {
    if (done || !Number.isFinite(t)) return false;
    if (last != null) {
      const d = t - last;
      if (d > 0 && d <= 2) total += d;
    }
    last = t;
    if (total >= minS) { done = true; return true; }
    return false;
  };
}
