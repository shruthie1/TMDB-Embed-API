import { poster } from './api';

const METAHUB = 'https://images.metahub.space/poster/small';

// Detail poster source order. TMDB w500 first: on a phone it is the same URL
// the row card's srcset picked (34vw x DPR 3 > 342), so the service worker
// image cache serves it at once. metahub
// is only a fallback: it sends no CORS header (the SW cannot cache it) and on
// some networks its connection hangs with no error, so onError never fires
// and the poster stayed blank.
export function posterSources(t) {
  if (!t?.poster) return [];
  const tmdb = poster(t.poster, 'w500');
  if (t.poster.startsWith('http') || !t.imdbId) return [tmdb];
  return [tmdb, `${METAHUB}/${t.imdbId}/img`];
}
