import { describe, it, expect } from 'vitest';
import { fromTmdb, dedupe } from '../lib/catalog';

/**
 * Every card on every rail is shaped here, from four different TMDB endpoints
 * that each omit a different field. A wrong answer is silent: a card with the
 * wrong mediaType links to /title/tv/<movie-id> and 404s, and a null year or
 * rating renders as an empty gap rather than an error.
 */
describe('fromTmdb — media type inference', () => {
  it('trusts an explicit type over anything in the payload', () => {
    // discover/movie returns no media_type, so the caller passes it. That must
    // win even when the record looks like the other kind.
    expect(fromTmdb({ id: 3, title: 'Z', media_type: 'tv' }, 'movie').mediaType).toBe('movie');
  });

  it('uses media_type when trending returns a mixed list', () => {
    expect(fromTmdb({ id: 4, name: 'W', media_type: 'tv' }).mediaType).toBe('tv');
  });

  it('falls back to the shape of the record', () => {
    // A movie has `title`, a show has `name`. This is the last resort.
    expect(fromTmdb({ id: 1, title: 'X' }).mediaType).toBe('movie');
    expect(fromTmdb({ id: 2, name: 'Y' }).mediaType).toBe('tv');
  });

  it('calls a record with neither field a show, not a movie', () => {
    // Ambiguous, and pinned so the guess is deliberate: `m.title ? 'movie' :
    // 'tv'` means an untitled record becomes tv.
    expect(fromTmdb({ id: 9, first_air_date: '2020-01-01' }).mediaType).toBe('tv');
  });
});

describe('fromTmdb — fields that render', () => {
  it('reads the year from whichever date field the endpoint used', () => {
    expect(fromTmdb({ id: 1, title: 'X', release_date: '2026-08-07' }).year).toBe(2026);
    expect(fromTmdb({ id: 2, name: 'Y', first_air_date: '2026-12-25' }).year).toBe(2026);
  });

  it('returns null rather than NaN when there is no usable date', () => {
    // NaN would render as "NaN" on the card; null renders as nothing.
    expect(fromTmdb({ id: 7, title: 'B', release_date: '' }).year).toBeNull();
    expect(fromTmdb({ id: 7, title: 'B' }).year).toBeNull();
  });

  it('keeps a rating of zero, which || would have discarded', () => {
    // `vote_average ?? null` is deliberate: 0 is a real, unrated score and
    // `||` would turn it into null.
    expect(fromTmdb({ id: 6, title: 'A', vote_average: 0 }).rating).toBe(0);
    expect(fromTmdb({ id: 6, title: 'A' }).rating).toBeNull();
  });

  it('never leaves a card without a title', () => {
    expect(fromTmdb({ id: 5 }).title).toBe('Untitled');
  });

  it('normalises missing art to null, not undefined', () => {
    const t = fromTmdb({ id: 1, title: 'X' });
    expect(t.poster).toBeNull();
    expect(t.backdrop).toBeNull();
    expect(t.overview).toBeNull();
  });
});

describe('dedupe', () => {
  it('drops repeats by type and id, keeping the first', () => {
    // TMDB paging and merged feeds both produce duplicates; a repeated React
    // key is a rendering bug.
    const out = dedupe([
      { mediaType: 'movie', tmdbId: 1, title: 'first' },
      { mediaType: 'movie', tmdbId: 1, title: 'second' },
      { mediaType: 'tv', tmdbId: 1, title: 'a show' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('first');
  });

  it('treats the same id in different media types as distinct', () => {
    expect(dedupe([
      { mediaType: 'movie', tmdbId: 27205 },
      { mediaType: 'tv', tmdbId: 27205 },
    ])).toHaveLength(2);
  });
});
