import { describe, it, expect, afterEach, vi } from 'vitest';
import { trendingIndia, trendingGlobal, trendingSeriesGlobal, similarTitles,
         LANGS } from '../lib/catalog';

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
