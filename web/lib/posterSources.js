import { poster } from './api';

const METAHUB = 'https://images.metahub.space/poster/small';

// Detail poster source order. A row card already loaded the TMDB w342 URL,
// so reuse it when the browser holds it: an instant cache hit. Otherwise use
// metahub's pre-sized poster (keyed by IMDB id, a smaller webp) and fall back
// to TMDB on a miss.
export function posterSources(t, isCached = cachedNow) {
  if (!t?.poster) return [];
  const tmdb = poster(t.poster, 'w342');
  if (t.poster.startsWith('http') || !t.imdbId) return [tmdb];
  if (isCached(tmdb)) return [tmdb];
  return [`${METAHUB}/${t.imdbId}/img`, tmdb];
}

// True when the image is already in the browser's memory cache: complete is
// set at once for a cached URL.
export { cachedNow };
function cachedNow(url) {
  if (typeof Image === 'undefined') return false;
  const img = new Image(); img.src = url;
  const hit = img.complete && img.naturalWidth > 0;
  if (!hit) img.src = '';   // cancel the probe's own request
  return hit;
}
