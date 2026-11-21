import { describe, it, expect } from 'vitest';
import { posterSources } from '../lib/posterSources';

// w500: the size a phone card's srcset picks, so the detail poster is a cache hit.
const tmdb = 'https://image.tmdb.org/t/p/w500/a.jpg';
const mh = 'https://images.metahub.space/poster/small/tt0903747/img';

describe('posterSources', () => {
  it('uses TMDB first, metahub as fallback, when an IMDB id exists', () => {
    expect(posterSources({ poster: '/a.jpg', imdbId: 'tt0903747' })).toEqual([tmdb, mh]);
  });
  it('uses TMDB alone without an IMDB id', () => {
    expect(posterSources({ poster: '/a.jpg', imdbId: null })).toEqual([tmdb]);
  });
  it('keeps a poster URL the backend already chose', () => {
    expect(posterSources({ poster: mh, imdbId: 'tt0903747' })).toEqual([mh]);
  });
  it('returns nothing without a poster', () => {
    expect(posterSources({ poster: null, imdbId: 'tt1' })).toEqual([]);
  });
});
