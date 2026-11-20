import { describe, it, expect, afterEach, vi } from 'vitest';
import { trendingIndia, trendingGlobal, trendingSeriesGlobal, similarTitles,
         LANGS, getTitleFull } from '../lib/catalog';

/**
 * `catalog.js` talks to TMDB over plain `fetch`, so stubbing it lets us assert
 * on the URLs it builds. Both behaviours below were live bugs: the queries
 * looked reasonable but quietly returned the wrong titles.
 */
const routes = (table) => {
  const calls = [];
  globalThis.fetch = vi.fn(async (url) => {
    calls.push(String(url));
    const hit = table.find(([match]) => String(url).includes(match));
    return { ok: true, json: async () => (hit ? hit[1] : { results: [] }) };
  });
  return calls;
};

const movie = (id, title, lang) => ({
  id, title, original_language: lang, poster_path: `/${id}.jpg`,
  release_date: '2026-01-01', vote_average: 7,
});

afterEach(() => { vi.restoreAllMocks(); delete globalThis.fetch; });

describe('trendingIndia', () => {
  it('asks TMDB for Indian titles instead of sorting a global list', async () => {
    const calls = routes([['/discover/movie', {
      results: [movie(1, 'Toxic', 'kn'), movie(2, 'Peddi', 'te'),
                movie(3, 'Karuppu', 'ta'), movie(4, 'Blast', 'ta'),
                movie(5, 'Jana Nayagan', 'ta'), movie(6, 'Dhurandhar', 'hi')],
    }]]);

    const out = await trendingIndia();

    // The whole point of the fix: the LANGUAGE filter is in the query, so a
    // week where Hollywood dominates cannot push The Odyssey into the hero.
    const discover = calls.find(u => u.includes('/discover/movie'));
    expect(discover).toBeTruthy();
    const langs = new URL(discover).searchParams.get('with_original_language');
    expect(langs.split('|').sort()).toEqual(LANGS.map(l => l.code).sort());
    expect(out.map(t => t.title)).toContain('Toxic');
    // /trending is global and its `region` param is ignored, so it must not be
    // the primary source any more.
    expect(calls.some(u => u.includes('/trending/'))).toBe(false);
  });

  it('falls back to trending rather than showing an near-empty banner', async () => {
    // A quiet release window: discover returns too few to fill a carousel.
    const calls = routes([
      ['/discover/movie', { results: [movie(1, 'Lone Regional Film', 'te')] }],
      ['/trending/movie/week', { results: [
        movie(90, 'The Odyssey', 'en'), movie(91, 'Kantara', 'kn'),
      ] }],
    ]);

    const out = await trendingIndia();
    const titles = out.map(t => t.title);

    expect(calls.some(u => u.includes('/trending/movie/week'))).toBe(true);
    // Indian titles still lead; the English filler only pads the tail.
    expect(titles.indexOf('Kantara')).toBeLessThan(titles.indexOf('The Odyssey'));
    expect(titles[0]).toBe('Lone Regional Film');
  });
});

describe('similarTitles', () => {
  it('puts precise same-language matches ahead of broad ones', async () => {
    // Sita Ramam: Telugu drama/romance. The tight (genre-AND) query is the
    // one that finds Kanche; the broad (genre-OR) query finds everything else.
    // Shipping only the broad query buried the best match.
    const calls = routes([
      ['/movie/999?', {
        id: 999, title: 'Sita Ramam', original_language: 'te',
        origin_country: ['IN'], genres: [{ id: 18 }, { id: 10749 }],
        spoken_languages: [{ iso_639_1: 'te' }],
      }],
      ['with_genres=18%2C10749', { results: [movie(11, 'Kanche', 'te')] }],
      ['with_genres=18%7C10749', { results: [movie(12, 'RRR', 'te'),
                                            movie(13, 'Baahubali', 'te')] }],
      ['/similar', { results: [movie(14, 'Some English Drama', 'en')] }],
    ]);

    const out = await similarTitles('movie', 999);
    const titles = out.map(t => t.title);

    expect(titles[0]).toBe('Kanche');
    expect(titles).toContain('RRR');
    expect(titles).not.toContain('Sita Ramam');   // never recommend itself
    // A regional title must be asked about in its own language.
    expect(calls.some(u => u.includes('with_original_language=te'))).toBe(true);
  });

  it('does not force a language filter onto an English title', async () => {
    const calls = routes([
      ['/movie/500?', {
        id: 500, title: 'The Odyssey', original_language: 'en',
        origin_country: ['US'], genres: [{ id: 12 }],
        spoken_languages: [{ iso_639_1: 'en' }],
      }],
      ['/similar', { results: [movie(21, 'Troy', 'en')] }],
    ]);

    const out = await similarTitles('movie', 500);

    expect(out.map(t => t.title)).toContain('Troy');
    expect(calls.some(u => u.includes('with_original_language=en'))).toBe(false);
  });
});

describe('global rows', () => {
  it('trendingGlobal is deliberately unfiltered - that is the row', async () => {
    const calls = routes([['/trending/movie/week', {
      results: [movie(1, 'The Odyssey', 'en'), movie(2, 'Toxic', 'kn')],
    }]]);

    const out = await trendingGlobal();

    // The hero had to STOP using this endpoint; this row exists to use it.
    // No language filter belongs here - a worldwide row that hides Hollywood
    // is not a worldwide row.
    expect(calls.some(u => u.includes('/trending/movie/week'))).toBe(true);
    expect(calls.some(u => u.includes('with_original_language'))).toBe(false);
    expect(out.map(t => t.title)).toEqual(['The Odyssey', 'Toxic']);
  });

  it('trendingSeriesGlobal asks for TV, not movies', async () => {
    const calls = routes([['/trending/tv/week', { results: [movie(3, 'Silo', 'en')] }]]);

    const out = await trendingSeriesGlobal();

    expect(calls.some(u => u.includes('/trending/tv/week'))).toBe(true);
    // mediaType drives the detail-page route, so a tv row emitting 'movie'
    // sends every card to the wrong URL.
    expect(out[0].mediaType).toBe('tv');
  });
});


describe('full title enrichment when the fast record is absent', () => {
  const rich = { id: 66732, name: 'Stranger Things', first_air_date: '2016-07-15',
    number_of_seasons: 5, seasons: [{ season_number: 1, name: 'Season 1', episode_count: 8 },
      { season_number: 2, name: 'Stranger Things 2', episode_count: 9 }],
    credits: { cast: [{ id: 1, name: 'Actor', character: 'Character', profile_path: '/actor.jpg' }], crew: [] },
    genres: [{ name: 'Drama' }], episode_run_time: [48], original_language: 'en' };
  it('keeps the season selector and credits when only the rich request succeeds', async () => {
    globalThis.fetch = vi.fn(async url => ({ ok: String(url).includes('append_to_response'), json: async () => rich }));
    const title = await getTitleFull('tv', 66732);
    expect(title.seasonList).toEqual([{ number: 1, name: 'Season 1', episodes: 8 }, { number: 2, name: 'Stranger Things 2', episodes: 9 }]);
    expect(title.seasons).toBe(5);
    expect(title.credits[0].name).toBe('Actor');
    expect(title.runtimeMin).toBe(48);
    expect(title.enriched).toBe(true);
  });
  it('keeps movie enrichment when only the rich request succeeds', async () => {
    globalThis.fetch = vi.fn(async url => ({ ok: String(url).includes('append_to_response'), json: async () => ({ ...rich, title: 'Movie', runtime: 95 }) }));
    const title = await getTitleFull('movie', 1);
    expect(title.runtimeMin).toBe(95);
    expect(title.cast).toEqual(['Actor']);
  });
  it('keeps a usable fast record when rich metadata fails', async () => {
    globalThis.fetch = vi.fn(async url => ({ ok: !String(url).includes('append_to_response'), json: async () => String(url).includes('external_ids') ? { imdb_id: 'tt1' } : { meta: { name: 'Fast title', year: '2016' } } }));
    expect((await getTitleFull('tv', 1)).title).toBe('Fast title');
  });
  it('returns no record when both producers fail', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }));
    expect(await getTitleFull('tv', 1)).toBeNull();
  });
});
