'use client';

// This is only a preference. Signed URLs expire and provider health changes,
// so the resolver still validates it and falls back when necessary.
const KEY_PREFIX = 'chitram:last-provider:v1:';

function keyOf(mediaType, tmdbId, season = 0, episode = 0) {
  return `${KEY_PREFIX}${mediaType}:${tmdbId}:${season}:${episode}`;
}

export function getLastProvider(mediaType, tmdbId, season = 0, episode = 0) {
  if (!mediaType || !tmdbId || typeof localStorage === 'undefined') return null;
  try { return localStorage.getItem(keyOf(mediaType, tmdbId, season, episode)) || null; }
  catch { return null; }
}

export function rememberProvider(mediaType, tmdbId, provider, season = 0, episode = 0) {
  if (!mediaType || !tmdbId || !provider || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(keyOf(mediaType, tmdbId, season, episode), provider); } catch {}
}

export function forgetProvider(mediaType, tmdbId, provider, season = 0, episode = 0) {
  if (!mediaType || !tmdbId || typeof localStorage === 'undefined') return;
  try {
    const key = keyOf(mediaType, tmdbId, season, episode);
    if (!provider || localStorage.getItem(key) === provider) localStorage.removeItem(key);
  } catch {}
}
