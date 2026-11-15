import { searchAll } from '../../../lib/catalog';
import { createCache, TTL_SEC } from '../../../lib/ttl';
import { parseLangs } from '../../../lib/prefs';

export const revalidate = 3600;
// Search ranking and provider fallbacks can improve independently of a page
// deploy. Do not let Next's response cache preserve an obsolete result after
// the local search cache has been corrected.
export const dynamic = 'force-dynamic';

// Same query typed twice should be instant: TMDB search measured at ~920ms,
// the slowest path in the app. Bounded by BOTH age and size so a long-lived
// server process cannot accumulate stale entries.
const cache = createCache({ ttlMs: TTL_SEC.SEARCH * 1000, max: 200 });

export async function GET(req) {
  const params = new URL(req.url).searchParams;
  const q = (params.get('q') || '').trim().toLowerCase();
  if (!q) return Response.json({ q, titles: [] });
  // Preferred languages change the ranking, so they are part of the key.
  const langs = parseLangs(params.get('langs'));
  const key = `${q}|${langs.join(',')}`;

  const hit = cache.get(key);
  if (hit) return Response.json({ q, langs, titles: hit, cached: true });

  const titles = await searchAll(q, { langs });
  cache.set(key, titles);
  return Response.json({ q, langs, titles });
}
