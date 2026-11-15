import data from './data/search-index.json';
import { prepName, prepQuery, matchTier } from './searchRank';

/**
 * In-memory index of popular Indian titles (te, ta, hi, ml, kn), built by
 * scripts/build-search-index.mjs and committed. Loaded once per server
 * process; a lookup is a synchronous scan of ~2,900 prepared names.
 */
let records = null;

function load() {
  if (records) return records;
  const f = Object.fromEntries(data.fields.map((name, i) => [name, i]));
  records = data.rows.map(r => {
    const tv = r[f.tv] === 1;
    const title = r[f.title];
    const orig = r[f.original_title] || '';
    const year = r[f.year] || 0;
    const date = year ? `${year}-01-01` : '';
    return {
      // TMDB /search/multi shape, so index hits and live hits merge as one.
      m: {
        id: r[f.id], media_type: tv ? 'tv' : 'movie',
        ...(tv ? { name: title, original_name: orig || title, first_air_date: date }
               : { title, original_title: orig || title, release_date: date }),
        original_language: r[f.original_language],
        popularity: r[f.popularity], vote_count: r[f.vote_count],
        vote_average: r[f.vote_average], poster_path: r[f.poster_path] || null,
        __index: true,
      },
      names: [prepName(title), ...(orig ? [prepName(orig)] : [])],
    };
  });
  return records;
}

export const indexBuiltAt = () => data.builtAt;
export const indexSize = () => load().length;

/** Index hits for a query: [{ m, tier }], unsorted. */
export function lookupIndex(q) {
  const pq = prepQuery(q);
  if (!pq.n) return [];
  const out = [];
  for (const rec of load()) {
    let tier = 0;
    for (const pn of rec.names) tier = Math.max(tier, matchTier(pq, pn));
    if (tier > 0) out.push({ m: rec.m, tier });
  }
  return out;
}
