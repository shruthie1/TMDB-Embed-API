import { searchKey, searchScore, similarity, variants, typoFixes } from './fuzzy';
import { abortReason } from './abortReason';

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

export async function trendingIndia({ limit = 18 } = {}) {
  // /trending is GLOBAL and its `region` parameter is ignored, so sorting its
  // results only reorders whatever Hollywood is trending that week. Measured
  // 2026-08-31: 0 of 20 results were Indian-language, and the hero banner led
  // with The Odyssey. Discover actually filters, so ask it directly.
  const recent = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const d = await j(tmdbUrl('/discover/movie', {
    with_original_language: LANGS.map(l => l.code).join('|'),
    sort_by: 'popularity.desc',
    // Low enough that a regional release still qualifies - Indian films poll
    // far below Hollywood on TMDB - high enough to skip unranked uploads.
    'vote_count.gte': '15',
    'primary_release_date.gte': recent,
  }));
  const found = (d?.results || []).map(m => fromTmdb(m, 'movie'));
  if (found.length >= 6) return dedupe(found).slice(0, limit);

  // A quiet release window is possible; fall back to global trending with the
  // Indian titles pulled to the front rather than showing an empty banner.
  const g = await j(tmdbUrl('/trending/movie/week'));
  const all = (g?.results || []).map(m => fromTmdb(m, 'movie'));
  const codes = new Set(LANGS.map(l => l.code));
  return dedupe([...found,
                 ...all.filter(t => codes.has(t.originalLang)),
                 ...all.filter(t => !codes.has(t.originalLang))]).slice(0, limit);
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

export async function recentlyAdded({ limit = 18 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const d = await j(tmdbUrl('/discover/movie', {
    sort_by: 'primary_release_date.desc',
    'primary_release_date.gte': from,
    'primary_release_date.lte': today,
    'vote_count.gte': '8',
  }));
  return dedupe((d?.results || []).slice(0, limit).map(m => fromTmdb(m, 'movie')));
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
export async function searchAll(q, { limit = 24 } = {}) {
  const query = q?.trim();
  if (!query) return [];
  const scoreQuery = searchKey(query) || query;

  // Interactive path: a slow speculative lookup must never hold the response.
  // The exact query gets a normal budget; variants and typo repair get a short
  // one and drop out silently if they miss it. Measured before this: a typo
  // query took 6.4s because one variant sat on the 9s default.
  const ask = (term, ms = 2500) =>
    j(tmdbUrl('/search/multi', { query: term, include_adult: 'false' }), ms)
      .then(d => (d?.results || []).filter(isTitle))
      .catch(() => []);

  /**
   * TMDB's own relevance, kept as a signal rather than thrown away.
   *
   * Our similarity() rewards a match at the START of a title, which is wrong
   * for the way these titles are built: for "ramam" it scored Ramam Raghavam
   * and even Rama Madhav (which does not contain "ramam" at all) at 0.920,
   * while Sita Ramam - the film actually wanted, and TMDB's own first result -
   * got 0.840 and fell to third.
   *
   * TMDB ranked it first for a reason. `rank` records the position each result
   * arrived in so that ordering can break ties, instead of being discarded.
   */
  const withRank = (rows, offset = 0) => rows.map((m, i) => { m.__rank = offset + i; return m; });

  // The exact query ALWAYS runs, in parallel with the spelling variants, and
  // the results are merged. Normalisation must never cost an exact match: if
  // what was typed is itself the indexed spelling, it has to win, and if it is
  // a variant that TMDB happens to know, that must not be dropped either.
  const [exact, ...alts] = await Promise.all([
    ask(query, 6000).then(rows => withRank(rows)),
    ...variants(query).map((v, i) => ask(v, 2500).then(rows => withRank(rows, 100 + i * 100))),
  ]);
  let raw = [...exact, ...alts.flat()];

  // Only if nothing convincing came back do we spend requests on typo repair
  // — ordinary mistyping rather than a spelling choice (pusspa -> pushpa,
  // kalky -> kalki, kantera -> kantara). Bounded, and skipped on a good hit.
  // Cinemeta stays a FALLBACK rather than the primary source, measured over 18
  // queries: it is 3.6x slower (1592ms vs 446ms), it misses series entirely
  // unless asked separately ("breaking bad" -> El Camino), and quality is
  // near-even (TMDB better on 2, Cinemeta on 3). But it is genuinely fuzzy
  // where TMDB is literal, so it must fire whenever TMDB looks unconvincing.
  //
  // The bar is deliberately high: TMDB answered "salaar" with "Salar" (0.15),
  // which a lower gate would have accepted while Cinemeta held the real
  // Salaar at 1.00. Only a near-exact hit skips the fallback.
  const best = raw.reduce((n, m) => Math.max(n, similarity(query, m.title || m.name)), 0);
  if (best < 0.95) {
    const [viaCinemeta, ...fixed] = await Promise.all([
      cinemetaSearch(query),
      ...typoFixes(query).map((v, i) => ask(v, 2500).then(rows => withRank(rows, 500 + i * 100))),
    ]);
    raw = [...raw, ...viaCinemeta, ...fixed.flat()];
  }

  const seen = new Set();
  return raw
    .map(m => ({
      m,
      // TMDB often stores an Indian title in `original_title` while its
      // display title is translated. Treat both as aliases for ranking.
      score: searchScore(scoreQuery, m),
    }))
    // Keep a floor so a variant search cannot drag in unrelated titles.
    .filter(({ m, score }) => {
      const k = `${m.media_type}-${m.id}`;
      if (seen.has(k) || score < 0.3) return false;
      seen.add(k); return true;
    })
    // Score, then TMDB's own order, then popularity.
    //
    // The score is BUCKETED to 0.1 before comparing: our similarity is a rough
    // instrument and treating 0.92 as meaningfully better than 0.84 is what
    // demoted Sita Ramam below a title that merely started with the query.
    // Within a bucket, whatever TMDB ranked first wins - it has the better
    // relevance model - and only then does popularity break the tie.
    .sort((a, b) =>
      (Math.round(b.score * 10) - Math.round(a.score * 10))
      || ((a.m.__rank ?? 99) - (b.m.__rank ?? 99))
      || ((b.m.popularity || 0) - (a.m.popularity || 0)))
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
    j(tmdbUrl(`/${type}/${id}`, { append_to_response: 'credits' })),
  ]);
  if (!fast) return rich ? fromTmdb(rich, type) : null;
  if (!rich) return fast;
  const cast = (rich.credits?.cast || []).slice(0, 8).map(c => c.name);
  return {
    ...fast,
    overview: rich.overview || fast.overview,
    backdrop: rich.backdrop_path || fast.backdrop,
    genres: (rich.genres || []).map(g => g.name).length
      ? (rich.genres || []).map(g => g.name) : fast.genres,
    runtimeMin: rich.runtime ?? rich.episode_run_time?.[0] ?? fast.runtimeMin,
    originalLang: rich.original_language ?? null,
    cast: cast.length ? cast : fast.cast,
    // Structured credits for the cast row — names alone cannot render photos.
    credits: (rich.credits?.cast || []).slice(0, 12).map(c => ({
      id: c.id, name: c.name, character: c.character || null, profile: c.profile_path || null,
    })),
    director: (rich.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name),
    writers: (rich.credits?.crew || [])
      .filter(c => c.job === 'Writer' || c.job === 'Screenplay').map(c => c.name).slice(0, 3),
    country: (rich.production_countries || []).map(c => c.name).slice(0, 2),
    tagline: rich.tagline || null,
    seasons: rich.number_of_seasons ?? null,
    seasonList: (rich.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ number: s.season_number, name: s.name, episodes: s.episode_count })),
    source: `${fast.source}+tmdb`,
    enriched: true,
  };
}
