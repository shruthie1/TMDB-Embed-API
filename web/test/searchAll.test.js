import { describe, it, expect, afterEach, vi } from 'vitest';
import { searchAll, recentlyAdded, ottSeries, interleaveByLang } from '../lib/catalog';
import { INDIA_PROVIDERS } from '../lib/prefs';

// Fixed TMDB fixtures; the committed local index supplies the Indian side.
const routes = (table) => {
  const calls = [];
  globalThis.fetch = vi.fn(async (url) => {
    calls.push(String(url));
    const hit = table.find(([match]) => String(url).includes(match));
    return { ok: true, json: async () => (hit ? hit[1] : { results: [] }) };
  });
  return calls;
};
afterEach(() => { vi.restoreAllMocks(); delete globalThis.fetch; });

const m = (id, title, lang, votes, pop, date = '2010-01-01') => ({
  id, media_type: 'movie', title, original_title: title, original_language: lang,
  vote_count: votes, popularity: pop, release_date: date,
});

describe('searchAll ranking', () => {
  it('puts Pushpa first for "push" over an English exact-title film', async () => {
    const calls = routes([['/search/multi', { results: [
      m(1, 'Push', 'en', 2500, 6), m(2, 'Pushing Tin', 'en', 600, 3),
    ] }]]);
    const out = await searchAll('push');
    expect(out[0].title).toMatch(/^Pushpa/);
    // A strong index hit skips spelling variants and Cinemeta.
    expect(calls.filter(u => u.includes('/search/multi'))).toHaveLength(1);
    expect(calls.some(u => u.includes('cinemeta'))).toBe(false);
  });

  it('keeps English titles findable', async () => {
    routes([['/search/multi', { results: [
      m(157336, 'Interstellar', 'en', 38000, 40, '2014-11-05'),
    ] }]]);
    const out = await searchAll('interstellar');
    expect(out[0].title).toBe('Interstellar');
  });

  it('ranks by the viewer language order it is given', async () => {
    routes([['/search/multi', { results: [] }]]);
    const te = await searchAll('dev', { langs: ['te'] });
    expect(te[0].originalLang).toBe('te');
  });
});

describe('home rows', () => {
  it('asks for preferred languages streaming on any India OTT app', async () => {
    const calls = routes([['/discover/movie', { results: [m(5, 'Peddi', 'te', 70, 9)] }]]);
    await recentlyAdded({ langs: ['te', 'hi'] });
    const u = new URL(calls[0]);
    expect(u.searchParams.get('with_original_language')).toBe('te|hi');
    expect(u.searchParams.get('watch_region')).toBe('IN');
    expect(u.searchParams.get('with_watch_providers').split('|').map(Number))
      .toEqual(INDIA_PROVIDERS);
    expect(u.searchParams.get('with_watch_monetization_types')).toBe('flatrate');
  });

  it('drops daily soaps from OTT series by episode count', async () => {
    routes([
      ['/discover/tv', { total_pages: 1, results: [
        { id: 10, name: 'Farzi', original_language: 'hi' },
        { id: 11, name: 'Teri Meri Doriyaann', original_language: 'hi' },
      ] }],
      ['/tv/10?', { number_of_episodes: 8 }],
      ['/tv/11?', { number_of_episodes: 900 }],
    ]);
    const out = await ottSeries('hi');
    expect(out.map(t => t.title)).toEqual(['Farzi']);
  });

  it('interleaves trending by language preference', () => {
    const t = (id, lang) => ({ tmdbId: id, originalLang: lang });
    const out = interleaveByLang([t(1, 'hi'), t(2, 'hi'), t(3, 'te'), t(4, 'en')], ['te', 'hi']);
    expect(out.map(x => x.tmdbId)).toEqual([3, 1, 2, 4]);
  });
});
