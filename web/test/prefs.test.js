// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getPrefs, savePrefs, hasPrefs, parseLangs, prefsQuery,
         DEFAULT_PREFS, INDIA_PROVIDERS } from '../lib/prefs';
import { homeRows, dedupeRows } from '../lib/homeRows';

beforeEach(() => { localStorage.clear(); });

describe('prefs', () => {
  it('defaults to the five Indian languages', () => {
    expect(hasPrefs()).toBe(false);
    expect(getPrefs()).toEqual({ langs: ['te', 'ta', 'hi', 'ml', 'kn'] });
  });

  it('saves in order, drops unknown codes, and ignores an old providers field', () => {
    savePrefs({ langs: ['hi', 'xx', 'te', 'hi'], providers: [8] });
    expect(hasPrefs()).toBe(true);
    expect(getPrefs()).toEqual({ langs: ['hi', 'te'] });
    localStorage.setItem('chitram:prefs:v1', JSON.stringify({ langs: ['ta'], providers: [8] }));
    expect(getPrefs()).toEqual({ langs: ['ta'] });
  });

  it('falls back to defaults on an empty choice or corrupt storage', () => {
    savePrefs({ langs: [] });
    expect(getPrefs()).toEqual({ ...DEFAULT_PREFS });
    localStorage.setItem('chitram:prefs:v1', '{bad');
    expect(getPrefs().langs).toEqual(DEFAULT_PREFS.langs);
  });

  it('parses query params defensively', () => {
    expect(parseLangs('ta,te')).toEqual(['ta', 'te']);
    expect(parseLangs('')).toEqual(DEFAULT_PREFS.langs);
    expect(parseLangs('<script>')).toEqual(DEFAULT_PREFS.langs);
    expect(prefsQuery({ langs: ['te', 'hi'] })).toBe('langs=te%2Chi');
  });

  it('uses every major India OTT app for the OTT rows', () => {
    expect(INDIA_PROVIDERS).toEqual(expect.arrayContaining([8, 119, 2336, 232, 237, 309, 532]));
  });
});

describe('homeRows', () => {
  it('follows the OTT home pattern, languages in preference order', () => {
    const kinds = homeRows(['hi', 'te']).map(r => r.kind);
    expect(kinds).toEqual([
      'continue', 'top10', 'recent', 'trending',
      'hi', 'series-hi', 'te', 'series-te',
      'genre-28', 'genre-53', 'genre-35', 'genre-10749', 'genre-10751',
      'list', 'upcoming',
    ]);
    expect(homeRows(['hi']).find(r => r.kind === 'top10').ranked).toBe(true);
  });

  it('shows each discovery title once, in the first row that has it', () => {
    const t = (id) => ({ mediaType: 'movie', tmdbId: id });
    const rows = homeRows(['te']);
    const out = dedupeRows(rows, {
      continue: [t(1)], top10: [t(1), t(2)], recent: [t(2), t(3)],
      trending: [t(3), t(4)], te: [t(4), t(5)], 'series-te': undefined, list: [t(5)],
    });
    expect(out.continue).toEqual([t(1)]);
    // The ranked chart keeps every position even when Continue has #1.
    expect(out.top10).toEqual([t(1), t(2)]);
    expect(out.recent).toEqual([t(3)]);
    expect(out.trending).toEqual([t(4)]);
    expect(out.te).toEqual([t(5)]);
    expect(out['series-te']).toBeUndefined();
    expect(out.list).toEqual([t(5)]);
  });
});
