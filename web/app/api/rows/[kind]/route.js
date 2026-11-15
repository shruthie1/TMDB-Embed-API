import { trendingIndia, trendingGlobal, trendingSeriesGlobal, recentlyAdded,
         languageRow, ottSeries, genreRow, comingSoon } from '../../../../lib/catalog';
import { createCache, TTL_SEC } from '../../../../lib/ttl';
import { parseLangs, PREF_LANGS } from '../../../../lib/prefs';

export const revalidate = 21600; // 6h — discovery rows change slowly

// Rows depend on the viewer's languages, so the key includes them. The
// browser and CDN keep the same 6 h via Cache-Control below.
const cache = createCache({ ttlMs: TTL_SEC.DISCOVERY * 1000, max: 300 });
const LANG_CODES = new Set(PREF_LANGS.map(l => l.code));
// Action, Thriller, Comedy, Romance, Family.
const GENRE_IDS = new Set([28, 53, 35, 10749, 10751]);

async function build(kind, langs) {
  // One popularity list feeds both: Top 10 is its head; the home page
  // shows the rest as "Trending now" once Top 10 has claimed the first ten.
  if (kind === 'top10') return trendingIndia({ langs, limit: 10 });
  if (kind === 'trending') return trendingIndia({ langs, limit: 30 });
  if (kind === 'upcoming') return comingSoon({ langs });
  if (kind.startsWith('genre-') && GENRE_IDS.has(Number(kind.slice(6)))) {
    return genreRow(Number(kind.slice(6)), { langs });
  }
  if (kind === 'global') return trendingGlobal();
  if (kind === 'globalseries') return trendingSeriesGlobal();
  if (kind === 'recent') return recentlyAdded({ langs });
  // Kept for old clients: the combined series row, now OTT-only.
  if (kind === 'series') return ottSeries(langs);
  const [prefix, lang] = kind.includes('-') ? kind.split('-') : [null, kind];
  if (!LANG_CODES.has(lang)) return null;
  if (prefix === 'series') return ottSeries(lang);
  if (prefix === null) return languageRow(lang);
  return null;
}

export async function GET(req, { params }) {
  const { kind } = params;
  const sp = new URL(req.url).searchParams;
  const langs = parseLangs(sp.get('langs'));
  const key = `${kind}|${langs.join(',')}`;

  let titles = cache.get(key);
  if (!titles) {
    titles = await build(kind, langs);
    if (titles === null) return Response.json({ error: 'unknown row' }, { status: 404 });
    // An empty row is usually a TMDB hiccup; do not pin it for 6 h.
    if (titles.length) cache.set(key, titles);
  }
  return Response.json({ kind, titles }, {
    headers: { 'Cache-Control': `public, s-maxage=${TTL_SEC.DISCOVERY}, stale-while-revalidate=3600` },
  });
}
