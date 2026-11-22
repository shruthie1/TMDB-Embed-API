'use client';

/**
 * What the tapped card already knows about a title (name, year, poster,
 * backdrop), kept for the title page's first paint. The page used to show
 * grey bars until /api/title answered; now it shows the name and the poster
 * the card had already downloaded, and the bars only stand in for the rest.
 *
 * Browser memory only, filled from click handlers. The server never writes
 * it, so a hard load renders the plain skeleton on both sides (no hydration
 * mismatch).
 */
const MAX = 40;
const seeds = new Map();

const key = (type, id) => `${type}/${Number(id)}`;

/** Remember a card's title. `posterSrc` is the url the card's img showed. */
export function seedTitle(title, posterSrc) {
  if (typeof window === 'undefined' || !title?.mediaType || !title?.tmdbId) return;
  const k = key(title.mediaType, title.tmdbId);
  seeds.delete(k);
  seeds.set(k, {
    title: title.title || '',
    year: title.year || null,
    poster: title.poster || null,
    backdrop: title.backdrop || null,
    posterSrc: posterSrc || null,
  });
  while (seeds.size > MAX) seeds.delete(seeds.keys().next().value);
}

export function peekSeed(type, id) {
  if (typeof window === 'undefined') return null;
  return seeds.get(key(type, id)) || null;
}

/** onClick for a link to a title: seeds from the img inside the link. */
export function seedOnClick(title) {
  return (e) => {
    const img = e?.currentTarget?.querySelector?.('img');
    seedTitle(title, img?.complete && img.naturalWidth ? img.currentSrc || img.src : null);
  };
}

export function clearSeeds() { seeds.clear(); }

const WARM_MAX = 20;
const warmed = [];

/**
 * Request a title's full record on hover or D-pad dwell (lib/prefetch.js),
 * so the title page usually opens on an answer already in hand. The routes
 * send no browser max-age (lib/edgeCache.js), so the promise is parked where
 * getJson takes it (window.__chitramEarly, see lib/earlyRows.js).
 */
export function warmTitle(type, id) {
  if (typeof window === 'undefined' || typeof fetch !== 'function' || !type || !id) return;
  const url = `/api/title/${type}/${Number(id)}/full`;
  const early = window.__chitramEarly = window.__chitramEarly || {};
  if (early[url]) return;
  early[url] = fetch(url)
    .then(r => r.json().then(b => ({ ok: r.ok, status: r.status, body: b })))
    .catch(() => null);
  warmed.push(url);
  while (warmed.length > WARM_MAX) delete early[warmed.shift()];
}
