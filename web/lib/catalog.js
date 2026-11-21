import { searchKey, searchScore, similarity, variants, typoFixes } from './fuzzy';
import { abortReason } from './abortReason';
import { lookupIndex } from './searchIndex';
import { prepQuery, tierOf, rankScore, yearOf, TIER } from './searchRank';
import { DEFAULT_PREFS, INDIA_PROVIDERS } from './prefs';

// Server-side catalog. Runs in Next.js route handlers — plain HTTP only,
// no browser, so it deploys to Vercel. Cinemeta first (~0.02s), TMDB for
// discovery rows and enrichment (~0.31s).

const TMDB = process.env.TMDB_API_BASE || 'https://api.tmdb.org/3';
const KEY = process.env.TMDB_V3_KEY || '';
const CINEMETA = process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io';

// Languages this household actually watches, in priority order.
export const LANGS = [
  { code: 'te', label: 'Telugu' },
  { code: 'ta', label: 'Tamil' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'hi', label: 'Hindi' },
];

async function j(url, ms = 9000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(abortReason(`timeout after ${ms}ms`)), ms);
  try {
    const r = await fetch(url, { signal: c.signal, next: { revalidate: 21600 } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

const tmdbUrl = (path, params = {}) =>
  `${TMDB}${path}?${new URLSearchParams({ api_key: KEY, ...params })}`;

/** Normalise a TMDB list item to the shape the Card expects. */
/** Drop repeats by (type,id). TMDB paging and merged feeds both produce them. */
export function dedupe(items) {
  const seen = new Set();
  return items.filter(t => {
    const k = `${t.mediaType}-${t.tmdbId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function fromTmdb(m, mediaType) {
  const type = mediaType || m.media_type || (m.title ? 'movie' : 'tv');
  const date = m.release_date || m.first_air_date || '';
  return {
    tmdbId: m.id,
    mediaType: type,
    title: m.title || m.name || 'Untitled',
    poster: m.poster_path || null,
    backdrop: m.backdrop_path || null,
    year: date ? Number(date.slice(0, 4)) : null,
    rating: m.vote_average ?? null,
    originalLang: m.original_language ?? null,
    // TMDB returns overview on discover/trending/search, so carrying it costs
    // no extra request and lets the hero say what a title actually is.
    overview: m.overview || null,
  };
}

export async function discoverByLang(code, { type = 'movie', limit = 18 } = {}) {
  const d = await j(tmdbUrl(`/discover/${type}`, {
    with_original_language: code,
    sort_by: 'popularity.desc',
    'vote_count.gte': '20',
  }));
  return dedupe((d?.results || []).slice(0, limit).map(m => fromTmdb(m, type)));
}

export async function trendingIndia({ limit = 18, langs = LANGS.map(l => l.code) } = {}) {
  // /trending is GLOBAL and its `region` parameter is ignored, so sorting its
  // results only reorders whatever Hollywood is trending that week. Measured
  // 2026-08-31: 0 of 20 results were Indian-language, and the hero banner led
  // with The Odyssey. Discover actually filters, so ask it directly.
  const recent = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const page = (p) => j(tmdbUrl('/discover/movie', {
    with_original_language: langs.join('|'),
    sort_by: 'popularity.desc',
    // Low enough that a regional release still qualifies - Indian films poll
    // far below Hollywood on TMDB - high enough to skip unranked uploads.
    'vote_count.gte': '15',
    'primary_release_date.gte': recent,
    page: String(p),
  }));
  const pages = await Promise.all([page(1), page(2)]);
  const found = dedupe(pages.flatMap(d => (d?.results || []).map(m => fromTmdb(m, 'movie'))));
  // Popularity alone is mostly Hindi and Tamil (Telugu measured 2/18), so
  // take turns by language in the viewer's order, each by popularity.
  if (found.length >= 6) return interleaveByLang(found, langs).slice(0, limit);

  // A quiet release window is possible; fall back to global trending with the
  // Indian titles pulled to the front rather than showing an empty banner.
  const g = await j(tmdbUrl('/trending/movie/week'));
  const all = (g?.results || []).map(m => fromTmdb(m, 'movie'));
  const codes = new Set(langs);
  return dedupe([...found,
                 ...all.filter(t => codes.has(t.originalLang)),
                 ...all.filter(t => !codes.has(t.originalLang))]).slice(0, limit);
}

/** Round-robin across `langs` in order; other languages go last. */
export function interleaveByLang(titles, langs) {
  const groups = langs.map(code => titles.filter(t => t.originalLang === code));
  const out = [];
  for (let i = 0; groups.some(g => i < g.length); i++) {
    for (const g of groups) if (i < g.length) out.push(g[i]);
  }
  return [...out, ...titles.filter(t => !langs.includes(t.originalLang))];
}

/**
 * Global trending - what the rest of the world is watching this week.
 *
 * This is /trending used correctly. The same endpoint was wrong for the hero
 * carousel, which is meant to be Indian and got Hollywood; here the global
 * result IS the point, so the row is honest about what it shows.
 */
export async function trendingGlobal({ limit = 18 } = {}) {
  const d = await j(tmdbUrl('/trending/movie/week'));
  return dedupe((d?.results || []).map(m => fromTmdb(m, 'movie'))).slice(0, limit);
}

/** Popular series worldwide, so the TV rails are not Indian-only. */
export async function trendingSeriesGlobal({ limit = 18 } = {}) {
  const d = await j(tmdbUrl('/trending/tv/week'));
  return dedupe((d?.results || []).map(m => fromTmdb(m, 'tv'))).slice(0, limit);
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

/** Streaming in India on one of these apps, on a subscription (not rent/buy). */
const onApps = (providers) => ({
  watch_region: 'IN',
  with_watch_providers: providers.join('|'),
  with_watch_monetization_types: 'flatrate',
});

/**
 * Newest films in the viewer's languages that are already streaming on their
 * apps. The old row asked for every language worldwide by release date and
 * measured 1/18 Indian on 2026-11-15.
 */
export async function recentlyAdded({ limit = 18, langs = DEFAULT_PREFS.langs,
                                      providers = INDIA_PROVIDERS } = {}) {
  const ask = (days) => j(tmdbUrl('/discover/movie', {
    ...onApps(providers),
    with_original_language: langs.join('|'),
    sort_by: 'primary_release_date.desc',
    'primary_release_date.gte': isoDaysAgo(days),
    'primary_release_date.lte': isoDaysAgo(0),
    'vote_count.gte': '3',
    include_adult: 'false',
  }));
  let d = await ask(180);
  // A quiet half-year (or one narrow language) must not leave a bare rail.
  if ((d?.results || []).length < 8) d = await ask(540);
  return dedupe((d?.results || []).map(m => fromTmdb(m, 'movie'))).slice(0, limit);
}

/**
 * A language rail: the last ~2 years by popularity first, then all-time
 * popular to fill. All-time alone led with decade-old hits.
 */
export async function languageRow(lang, { limit = 30 } = {}) {
  // Two pages: Top 10 and Trending claim the head of this list on the home
  // page, so one page left Tamil with 6 titles after dedupe.
  const page = (p) => j(tmdbUrl('/discover/movie', {
    with_original_language: lang,
    sort_by: 'popularity.desc',
    'primary_release_date.gte': isoDaysAgo(730),
    'primary_release_date.lte': isoDaysAgo(0),
    'vote_count.gte': '10',
    include_adult: 'false',
    page: String(p),
  }));
  const pages = await Promise.all([page(1), page(2)]);
  const fresh = dedupe(pages.flatMap(d => (d?.results || []).map(m => fromTmdb(m, 'movie'))));
  if (fresh.length >= limit) return dedupe(fresh).slice(0, limit);
  // Kannada measured 5 titles in 2 years at this vote floor.
  const all = await discoverByLang(lang, { limit: limit * 2 });
  return dedupe([...fresh, ...all]).slice(0, limit);
}

const dedupeRaw = (rows) => rows.filter((m, i) => rows.findIndex(x => x.id === m.id) === i);

/**
 * A genre rail across the viewer's languages: last ~5 years by popularity,
 * like the genre rows on Netflix and Prime Video home pages.
 */
export async function genreRow(genreId, { limit = 30, langs = DEFAULT_PREFS.langs } = {}) {
  // Two pages: the home page drops titles an earlier row already showed.
  const page = (p) => j(tmdbUrl('/discover/movie', {
    with_original_language: langs.join('|'),
    with_genres: String(genreId),
    sort_by: 'popularity.desc',
    'primary_release_date.gte': isoDaysAgo(5 * 365),
    'primary_release_date.lte': isoDaysAgo(0),
    'vote_count.gte': '10',
    include_adult: 'false',
    page: String(p),
  }));
  const pages = await Promise.all([page(1), page(2)]);
  return interleaveByLang(dedupe(pages.flatMap(d => (d?.results || [])
    .map(m => fromTmdb(m, 'movie')))), langs).slice(0, limit);
}

/** Upcoming films in the viewer's languages, soonest first ("Coming soon"). */
export async function comingSoon({ limit = 18, langs = DEFAULT_PREFS.langs } = {}) {
  const d = await j(tmdbUrl('/discover/movie', {
    with_original_language: langs.join('|'),
    region: 'IN',
    sort_by: 'popularity.desc',
    'primary_release_date.gte': isoDaysAgo(-1),
    'primary_release_date.lte': isoDaysAgo(-180),
    include_adult: 'false',
  }));
  return dedupe((d?.results || []).filter(m => m.poster_path)
    .map(m => fromTmdb(m, 'movie'))).slice(0, limit);
}

// TMDB genres that are never a "series to binge": soap, talk, reality, news.
const NOT_SERIES = '10766|10767|10764|10763';
// Daily soaps are often tagged Drama, so the genre filter misses them
// (Teri Meri Doriyaann, ~900 episodes). An episode count past this is a soap.
const SOAP_EPISODES = 80;

/**
 * Recent series in one or more languages that stream on the viewer's apps.
 * Replaces "Indian series", which measured 18/18 old Hindi soaps (median 2013).
 */
export async function ottSeries(langs, { limit = 18, providers = INDIA_PROVIDERS } = {}) {
  const params = {
    ...onApps(providers),
    with_original_language: [].concat(langs).join('|'),
    without_genres: NOT_SERIES,
    sort_by: 'popularity.desc',
    'first_air_date.gte': '2022-01-01',
    'vote_count.gte': '3',
    include_adult: 'false',
  };
  const d = await j(tmdbUrl('/discover/tv', params));
  // Hindi loses about half of a page to soaps, so take two pages.
  const d2 = (d?.total_pages || 1) > 1 ? await j(tmdbUrl('/discover/tv', { ...params, page: '2' })) : null;
  const pool = dedupeRaw([...(d?.results || []), ...(d2?.results || [])]).slice(0, limit + 12);
  // One detail lookup per candidate, cached 6 h like every TMDB call here.
  const details = await Promise.all(pool.map(m =>
    j(tmdbUrl(`/tv/${m.id}`), 4000).catch(() => null)));
  const kept = pool.filter((m, i) => !(details[i]?.number_of_episodes > SOAP_EPISODES));
  return dedupe(kept.map(m => fromTmdb(m, 'tv'))).slice(0, limit);
}

export const GENRES = [
  { id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }, { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' }, { id: 10751, name: 'Family' }, { id: 14, name: 'Fantasy' },
  { id: 36, name: 'History' }, { id: 27, name: 'Horror' }, { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' }, { id: 10749, name: 'Romance' }, { id: 878, name: 'Sci-Fi' },
  { id: 53, name: 'Thriller' }, { id: 10752, name: 'War' }, { id: 37, name: 'Western' },
];

export const SORTS = [
  { id: 'popularity.desc', name: 'Popular' },
  { id: 'vote_average.desc', name: 'Top rated' },
  { id: 'primary_release_date.desc', name: 'Newest' },
  { id: 'title.asc', name: 'A–Z' },
];

/**
 * Faceted browse. Every facet maps to a TMDB /discover parameter, so the URL
 * the user sees and the query we send stay in step.
 */
export async function discover({
  type = 'movie', langs = [], genres = [], yearFrom, yearTo,
  minRating, sort = 'popularity.desc', page = 1,
} = {}) {
  const isTv = type === 'tv';
  const params = {
    sort_by: isTv && sort.startsWith('primary_release_date') ? 'first_air_date.desc'
           : isTv && sort.startsWith('title') ? 'name.asc' : sort,
    page: String(page),
    include_adult: 'false',
    // Top-rated needs a real vote floor, or a title with one 10/10 vote wins.
    // At 50 the top was "The Way to the Heart" (9.9, near-unknown); at 300 it
    // is Shawshank and Demon Slayer. But 300 is far too strict for regional
    // cinema - Telugu fell to 3 results - so a language filter uses a lower
    // floor that still keeps RRR and Baahubali at the top.
    'vote_count.gte': sort.startsWith('vote_average')
      ? (langs.length ? '50' : '300')
      : '10',
  };
  if (langs.length) params.with_original_language = langs.join('|');
  if (genres.length) params.with_genres = genres.join(',');
  if (minRating) params['vote_average.gte'] = String(minRating);
  const dateKey = isTv ? 'first_air_date' : 'primary_release_date';
  if (yearFrom) params[`${dateKey}.gte`] = `${yearFrom}-01-01`;
  if (yearTo) params[`${dateKey}.lte`] = `${yearTo}-12-31`;

  const d = await j(tmdbUrl(`/discover/${isTv ? 'tv' : 'movie'}`, params), 12000);
  return {
    titles: dedupe((d?.results || []).map(m => fromTmdb(m, isTv ? 'tv' : 'movie'))),
    page: d?.page ?? page,
    totalPages: Math.min(d?.total_pages ?? 1, 500),
    totalResults: d?.total_results ?? 0,
  };
}

/**
 * A person's own filmography.
 *
 * Sorting by popularity returns talk shows and award ceremonies — they are
 * credited to the person but are not their work (measured: DiCaprio's top 5
 * were Fallon, SNL, Kimmel x2, Golden Globes). Vote count plus a billing
 * position separates real roles from guest spots.
 */
export async function personCredits(id, { limit = 20 } = {}) {
  const d = await j(tmdbUrl(`/person/${id}/combined_credits`));
  if (!d) return { name: null, titles: [] };
  const titles = (d.cast || [])
    .filter(c => c.poster_path && (c.vote_count || 0) >= 50
                 && c.order != null && c.order <= 10)
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
    .slice(0, limit)
    .map(c => fromTmdb(c, c.media_type === 'tv' ? 'tv' : 'movie'));
  return { titles: dedupe(titles) };
}

export async function personInfo(id) {
  const d = await j(tmdbUrl(`/person/${id}`));
  return d ? { id: d.id, name: d.name, profile: d.profile_path || null,
               knownFor: d.known_for_department || null, bio: d.biography || null } : null;
}

const isTitle = (m) => m.media_type === 'movie' || m.media_type === 'tv';

/**
 * Cinemeta's catalog search — fuzzy where TMDB's is literal.
 *
 * Measured: TMDB returns NOTHING for "pusspa", "bahuvali" or "salaar", while
 * Cinemeta returns Pushpa, Baahubali and Salaar for the same strings. It is
 * keyed on IMDb ids, so hits are converted to TMDB ids via /find — only for
 * the few that survive scoring, since each conversion is a request.
 */
async function cinemetaSearch(query, limit = 4) {
  const hit = (type) =>
    j(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`, 3000)
      .then(d => (d?.metas || []).map(m => ({ ...m, _type: type === 'series' ? 'tv' : 'movie' })))
      .catch(() => []);

  const metas = (await Promise.all([hit('movie'), hit('series')])).flat();

  const best = metas
    .map(m => ({ m, score: similarity(query, m.name) }))
    .filter(x => x.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    // Very short prefixes are inherently ambiguous; keep more candidates so
    // one exact-looking but unrelated result cannot hide a valid regional
    // title such as Vishwanath & Sons.
    .slice(0, query.replace(/\s+/g, '').length < 6 ? Math.max(limit, 12) : limit);

  const found = await Promise.all(best.map(({ m }) =>
    j(tmdbUrl(`/find/${m.imdb_id || m.id}`, { external_source: 'imdb_id' }), 2500)
      .then(async d => {
        const direct = (d?.movie_results || [])[0] || (d?.tv_results || [])[0];
        if (direct) return direct;
        const fallback = await j(tmdbUrl('/search/multi', { query: m.name, include_adult: 'false' }), 2500);
        return (fallback?.results || []).filter(isTitle)
          .sort((a, b) => similarity(m.name, b.title || b.name) - similarity(m.name, a.title || a.name))[0] || null;
      })
      .catch(() => null)));

  return found.filter(Boolean).map((r, i) => ({
    ...r, media_type: r.title ? 'movie' : 'tv',
    popularity: r.popularity ?? (best[i]?.score ?? 0) * 100,
  }));
}

/**
 * Search, tolerant of how Indian titles get romanised.
 *
 * TMDB's search is literal: "gita govindam" returned ZERO results for a film
 * that plainly exists, and "githa govindham" likewise. So when a literal
 * search comes back thin we retry with spelling variants and rank everything
 * by how closely it matches what was actually typed.
 */
export async function searchAll(q, { limit = 24, langs = DEFAULT_PREFS.langs } = {}) {
  const query = q?.trim();
  if (!query) return [];
  const scoreQuery = searchKey(query) || query;
  const pq = prepQuery(scoreQuery);

  // Local index first: synchronous, and it already holds the popular Indian
  // titles that TMDB's literal search ranks below Hollywood for a prefix.
  const local = lookupIndex(scoreQuery);
  // A prefix (or romanisation-prefix) hit in the index means the slow
  // spelling variants and Cinemeta would only add latency.
  const strong = local.some(x => x.tier >= TIER.SKEL_WORD_PREFIX);

  // Interactive path: a slow speculative lookup must never hold the response.
  // The exact query gets a normal budget; variants and typo repair get a short
  // one and drop out silently if they miss it. Measured before this: a typo
  // query took 6.4s because one variant sat on the 9s default.
  const ask = (term, ms = 2500) =>
    j(tmdbUrl('/search/multi', { query: term, include_adult: 'false' }), ms)
      .then(d => (d?.results || []).filter(isTitle))
      .catch(() => []);

  // `__rank` keeps the position TMDB returned each result in. It breaks ties
  // and lifts TMDB's top few, which can match on an alternative title that
  // our name matching never sees.
  const withRank = (rows, offset = 0) => rows.map((m, i) => { m.__rank = offset + i; return m; });

  // The exact query ALWAYS runs, so English and other titles stay findable.
  // Spelling variants run alongside it only when the index found nothing.
  const [exact, ...alts] = await Promise.all([
    ask(query, strong ? 2500 : 6000).then(rows => withRank(rows)),
    ...(strong ? [] : variants(query).map((v, i) =>
      ask(v, 2500).then(rows => withRank(rows, 100 + i * 100)))),
  ]);
  let raw = [...exact, ...alts.flat()];

  // Typo repair (Cinemeta is fuzzy where TMDB is literal) only when neither
  // the index nor TMDB produced a near-exact title. The bar is high on
  // purpose: TMDB answered "salaar" with "Salar", which a lower gate accepted.
  const best = [...raw, ...local.map(x => x.m)]
    .reduce((n, m) => Math.max(n, similarity(query, m.title || m.name)), 0);
  if (!strong && best < 0.95) {
    const [viaCinemeta, ...fixed] = await Promise.all([
      cinemetaSearch(query),
      ...typoFixes(query).map((v, i) => ask(v, 2500).then(rows => withRank(rows, 500 + i * 100))),
    ]);
    raw = [...raw, ...viaCinemeta, ...fixed.flat()];
  }

  // Merge by (type,id). A live TMDB record wins over the index copy because
  // it carries the overview and backdrop; the best tier from either is kept.
  const byKey = new Map();
  for (const { m, tier } of local) byKey.set(`${m.media_type}-${m.id}`, { m, tier });
  for (const m of raw) {
    const k = `${m.media_type}-${m.id}`;
    // Our own tiers first. Then the older similarity score, scaled below any
    // prefix tier, for romanisations the tiers miss ("gita govindam").
    // Then TMDB's own top five, which may match on an alias.
    const sim = searchScore(scoreQuery, m);
    const tier = Math.max(
      tierOf(pq, m),
      sim >= 0.5 ? 0.7 * Math.min(1, sim) : 0,
      m.__rank != null && m.__rank < 5 ? 0.4 : 0);
    const prev = byKey.get(k);
    const rank = Math.min(m.__rank ?? 999, prev?.m.__rank ?? 999);
    byKey.set(k, { m: { ...m, __rank: rank }, tier: Math.max(tier, prev?.tier || 0) });
  }

  return [...byKey.values()]
    .filter(x => x.tier > 0)
    .map(x => ({
      ...x,
      score: rankScore({ tier: x.tier, lang: x.m.original_language, votes: x.m.vote_count,
                         popularity: x.m.popularity, year: yearOf(x.m) }, langs),
    }))
    .sort((a, b) => (b.score - a.score) || ((a.m.__rank ?? 999) - (b.m.__rank ?? 999)))
    .slice(0, limit)
    .map(({ m }) => fromTmdb(m));
}

/** Fast single title — Cinemeta when we can, TMDB otherwise. */
export async function getTitle(type, id) {
  const ext = await j(tmdbUrl(`/${type}/${id}/external_ids`));
  const imdb = ext?.imdb_id;
  if (imdb) {
    const c = await j(`${CINEMETA}/meta/${type}/${imdb}.json`, 6000);
    const m = c?.meta;
    if (m?.name) {
      return {
        tmdbId: Number(id), imdbId: imdb, mediaType: type, title: m.name,
        overview: m.description ?? null, poster: m.poster ?? null,
        backdrop: m.background ?? null,
        year: m.year ? Number(String(m.year).slice(0, 4)) : null,
        rating: m.imdbRating ? Number(m.imdbRating) : null,
        genres: m.genre ?? [], cast: m.cast ?? [], runtimeMin: null,
        source: 'cinemeta',
      };
    }
  }
  const d = await j(tmdbUrl(`/${type}/${id}`));
  return d ? { ...fromTmdb(d, type), overview: d.overview, genres: (d.genres||[]).map(g=>g.name),
               runtimeMin: d.runtime ?? null, imdbId: d.imdb_id ?? imdb ?? null,
               cast: [], source: 'tmdb' } : null;
}

/**
 * Titles similar to this one — powers "More like this".
 *
 * TMDB's own /recommendations matches on theme and ignores language entirely,
 * which makes it close to useless for regional cinema. Measured 2026-08-31:
 * Sita Ramam (Telugu) returned 20/20 ENGLISH titles - Doctor Zhivago and a
 * 1927 silent film - and Kantara (Kannada folk horror) returned Get Out and
 * Barbarian. Both had a full 20 results, so the failure was relevance, not
 * coverage.
 *
 * So for a non-English title we discover within its OWN language and genres
 * first, and only fall back to TMDB's list to fill the row. For an English
 * title TMDB's recommendations are good, and lead.
 */
export async function similarTitles(type, id, { limit = 18 } = {}) {
  const detail = await j(tmdbUrl(`/${type}/${id}`));
  const genres = (detail?.genres || []).map(g => g.id).slice(0, 3);

  // TMDB's original_language is unreliable for Indian cinema: Kantara, a
  // Kannada film, is tagged 'en'. So trust origin_country too - a title made
  // in India is regional whatever the language field claims - and recover the
  // real language from spoken_languages when it disagrees.
  const claimed = detail?.original_language || null;
  const inIndia = (detail?.origin_country || []).includes('IN')
    || (detail?.production_countries || []).some(c => c.iso_3166_1 === 'IN');
  const spoken = (detail?.spoken_languages || [])
    .map(l => l.iso_639_1).filter(c => LANGS.some(x => x.code === c));
  const lang = (claimed && claimed !== 'en') ? claimed : (spoken[0] || claimed);
  const isRegional = Boolean((lang && lang !== 'en') || inIndia);

  /**
   * @param join ',' for AND (few, very close matches) or '|' for OR (many,
   *   same language but looser). Both are used: the tight set leads.
   */
  const sameLanguage = async (join) => {
    if (!isRegional || !genres.length || !lang) return [];
    // tmdbUrl appends `?api_key=...` itself, so params go in the SECOND
    // argument. Building the query into the path gives a url with two `?`
    // and TMDB silently ignores every filter - which looked exactly like the
    // original bug, English results for a Telugu film.
    const d = await j(tmdbUrl(`/discover/${type}`, {
      with_original_language: lang,
      // `|` is OR, `,` is AND. Comma means "History AND Romance", which for
      // Sita Ramam matched exactly 2 Telugu films in existence - itself and
      // one other. Pipe matches any of them: 159 results, led by Peddi, RRR
      // and Baahubali.
      with_genres: genres.join(join),
      sort_by: 'popularity.desc',
      // Enough votes to exclude the long tail of unranked uploads, low enough
      // that regional films still qualify - they poll far below Hollywood.
      'vote_count.gte': '20',
    }));
    return d?.results || [];
  };

  const tmdbPicks = async () => {
    const d = await j(tmdbUrl(`/${type}/${id}/recommendations`));
    let items = d?.results || [];
    if (items.length < 6) {
      const alt = await j(tmdbUrl(`/${type}/${id}/similar`));
      const seen = new Set(items.map(m => m.id));
      items = [...items, ...(alt?.results || []).filter(m => !seen.has(m.id))];
    }
    return items;
  };

  // Precise first, then broad. An AND match on all genres is the closest
  // thing TMDB can express - for Sita Ramam it finds Kanche, a Telugu period
  // romance, which is exactly right but is only ONE film. Widening to OR
  // gives 159 same-language titles (RRR, Baahubali, Devara) that belong in
  // the row but should not displace the close match at the front.
  const [tight, broad, tmdb] = await Promise.all([
    sameLanguage(','), sameLanguage('|'), tmdbPicks(),
  ]);
  const ordered = isRegional ? [...tight, ...broad, ...tmdb] : [...tmdb, ...broad];

  const seen = new Set([Number(id)]);          // never recommend the title itself
  const out = [];
  for (const m of ordered) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(fromTmdb(m, type));
    if (out.length >= limit) break;
  }
  return dedupe(out);
}

/** Episodes for one season, with stills. */
export async function seasonEpisodes(id, season) {
  const d = await j(tmdbUrl(`/tv/${id}/season/${season}`));
  return (d?.episodes || []).map(e => ({
    episode: e.episode_number,
    season: e.season_number,
    title: e.name,
    overview: e.overview || null,
    still: e.still_path || null,
    runtimeMin: e.runtime ?? null,
    airDate: e.air_date || null,
    rating: e.vote_average ?? null,
  }));
}

/**
 * The hero's title logo: the original language first (a Telugu film's
 * Telugu logo), then English, then a logo with no language (textless art).
 * Within a language, the best voted, then the widest. Null when none.
 */
export function pickLogo(logos, originalLang) {
  if (!Array.isArray(logos) || !logos.length) return null;
  const order = [originalLang || null, 'en', null].filter((l, i, a) => a.indexOf(l) === i);
  for (const lang of order) {
    const hits = logos.filter(l => l?.file_path && (l.iso_639_1 ?? null) === lang);
    if (!hits.length) continue;
    hits.sort((a, b) => ((b.vote_average || 0) - (a.vote_average || 0)) || ((b.width || 0) - (a.width || 0)));
    return hits[0].file_path;
  }
  return null;
}

/** Full record for the detail page — merges TMDB over the fast record. */
export async function getTitleFull(type, id) {
  // These do not depend on each other, and running them in series cost a full
  // TMDB round trip on the critical path: getTitle is itself two hops
  // (external_ids -> Cinemeta), so the page waited on three sequential calls.
  //
  // TMDB alone carries everything the page renders, and Cinemeta only supplies
  // an imdbId plus fallbacks. So the Cinemeta chain gets a short leash: if it
  // has not answered by the time TMDB has, the page ships without it rather
  // than holding the render for a field nothing above the fold uses.
  const [fast, rich] = await Promise.all([
    Promise.race([
      getTitle(type, id),
      new Promise(r => setTimeout(() => r(null), 1200)),
    ]),
    // `images` adds the title logos in the same call (no language filter:
    // TMDB then returns every language, and pickLogo chooses).
    j(tmdbUrl(`/${type}/${id}`, { append_to_response: 'credits,images' })),
  ]);
  if (!rich) return fast;
  // The rich producer owns seasons/credits even when the optional fast path loses its race.
  const seed = fast || fromTmdb(rich, type);
  const cast = (rich.credits?.cast || []).slice(0, 8).map(c => c.name);
  return {
    ...seed,
    overview: rich.overview || seed.overview,
    // TMDB path over Cinemeta's metahub URL: the row card already loaded this
    // exact TMDB URL, so it is a cache hit, and metahub can hang with no error.
    poster: rich.poster_path || seed.poster,
    backdrop: rich.backdrop_path || seed.backdrop,
    genres: (rich.genres || []).map(g => g.name).length
      ? (rich.genres || []).map(g => g.name) : seed.genres,
    runtimeMin: rich.runtime ?? rich.episode_run_time?.[0] ?? seed.runtimeMin,
    originalLang: rich.original_language ?? null,
    cast: cast.length ? cast : seed.cast,
    // Structured credits for the cast row — names alone cannot render photos.
    credits: (rich.credits?.cast || []).slice(0, 12).map(c => ({
      id: c.id, name: c.name, character: c.character || null, profile: c.profile_path || null,
    })),
    director: (rich.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name),
    writers: (rich.credits?.crew || [])
      .filter(c => c.job === 'Writer' || c.job === 'Screenplay').map(c => c.name).slice(0, 3),
    country: (rich.production_countries || []).map(c => c.name).slice(0, 2),
    tagline: rich.tagline || null,
    // TMDB title logo path (w500 on the hero); null shows the text title.
    logo: pickLogo(rich.images?.logos, rich.original_language),
    seasons: rich.number_of_seasons ?? null,
    seasonList: (rich.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ number: s.season_number, name: s.name, episodes: s.episode_count })),
    source: fast ? `${fast.source}+tmdb` : 'tmdb',
    enriched: true,
  };
}
