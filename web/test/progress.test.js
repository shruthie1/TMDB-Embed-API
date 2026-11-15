import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  saveProgress, getProgress, getNextUp, getContinueWatching, getShowProgress,
  getSeeds,
} from '../lib/progress';

// localStorage stand-in — the module is local-first by design.
// A fake clock too: ordering is by updatedAt, and real writes here land in
// the same millisecond, which would make order tests meaningless.
let now = 1_000_000;
const tick = (ms = 1000) => { now += ms; };

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
});

afterEach(() => vi.restoreAllMocks());

const ep = (season, episode, positionSec, durationSec = 2700, extra = {}) => ({
  mediaType: 'tv', tmdbId: 1396, season, episode,
  positionSec, durationSec, title: 'Breaking Bad', ...extra,
});

describe('saveProgress / getProgress', () => {
  it('keys a series entry by season and episode', () => {
    saveProgress(ep(1, 4, 600));
    expect(getProgress('tv', 1396, 1, 4).positionSec).toBe(600);
    expect(getProgress('tv', 1396, 1, 5)).toBeNull();
  });

  it('marks finished near the end, so it never resurfaces as resume', () => {
    saveProgress(ep(1, 1, 2695));
    expect(getProgress('tv', 1396, 1, 1).finished).toBe(true);
  });

  it('ignores a write with no duration', () => {
    saveProgress({ ...ep(1, 1, 60), durationSec: 0 });
    expect(getProgress('tv', 1396, 1, 1)).toBeNull();
  });
});

describe('getNextUp', () => {
  it('returns null for a show never started', () => {
    expect(getNextUp(1396)).toBeNull();
  });

  it('resumes the episode in progress', () => {
    saveProgress(ep(2, 3, 900));
    const n = getNextUp(1396);
    expect(n).toMatchObject({ season: 2, episode: 3, resume: true, positionSec: 900 });
  });

  it('resumes an episode watched only briefly, instead of skipping it', () => {
    // The reported bug: watch 45s of an episode, come back, and the player
    // opened the NEXT episode - skipping content never actually watched.
    // 45s is below the 60s "started" floor, and getNextUp treated anything
    // below that floor the same as finished.
    saveProgress(ep(2, 3, 45));
    expect(getNextUp(1396)).toMatchObject({
      season: 2, episode: 3, resume: true, positionSec: 45,
    });
  });

  it('resumes from the very first seconds of an episode', () => {
    // Even 5s in, the episode is the one to open. Nobody wants episode 4
    // because they glanced at episode 3.
    saveProgress(ep(1, 1, 5));
    expect(getNextUp(1396)).toMatchObject({ season: 1, episode: 1, resume: true });
  });

  it('still advances when an episode was genuinely finished', () => {
    // The guard against over-correcting: a finished episode must still roll on.
    saveProgress(ep(1, 4, 2695));
    expect(getNextUp(1396)).toMatchObject({ season: 1, episode: 5, resume: false });
  });

  it('advances to the next episode once one is finished', () => {
    saveProgress(ep(1, 4, 2695));
    const n = getNextUp(1396);
    expect(n).toMatchObject({ season: 1, episode: 5, resume: false, positionSec: 0 });
  });

  it('uses the most recent episode, not the highest numbered', () => {
    saveProgress(ep(1, 9, 2695));
    tick();
    saveProgress(ep(1, 2, 800));   // rewatching an earlier one, later
    expect(getNextUp(1396)).toMatchObject({ season: 1, episode: 2, resume: true });
  });

  it('resumes even a barely-touched episode rather than skipping ahead', () => {
    // This asserted the opposite until a viewer hit it: 20s in was treated as
    // "not really started", so returning to the show opened episode 2 and the
    // rest of episode 1 was silently skipped. Re-opening an episode someone
    // glanced at costs them one tap; skipping one costs them the episode.
    saveProgress(ep(1, 1, 20));
    expect(getNextUp(1396)).toMatchObject({ episode: 1, resume: true });
  });
});

// Breaking Bad's real shape — season 1 ends at 7, the series at S5E16.
const SEASONS = [
  { number: 1, episodes: 7 }, { number: 2, episodes: 13 },
  { number: 3, episodes: 13 }, { number: 4, episodes: 13 },
  { number: 5, episodes: 16 },
];

describe('getNextUp - season boundaries', () => {
  it('rolls over to the next season when a season ends', () => {
    saveProgress(ep(1, 7, 2695));
    expect(getNextUp(1396, SEASONS)).toMatchObject({ season: 2, episode: 1 });
  });

  it('never offers a phantom episode past a season end', () => {
    saveProgress(ep(1, 7, 2695));
    const n = getNextUp(1396, SEASONS);
    expect(n.episode).not.toBe(8);
  });

  it('marks a finished series rather than inventing S5E17', () => {
    saveProgress(ep(5, 16, 2695));
    const n = getNextUp(1396, SEASONS);
    expect(n.seriesEnded).toBe(true);
    expect(n.episode).toBe(16);
  });

  it('advances normally mid-season', () => {
    saveProgress(ep(2, 4, 2695));
    expect(getNextUp(1396, SEASONS)).toMatchObject({ season: 2, episode: 5 });
  });

  it('degrades to episode+1 when no season list is given', () => {
    saveProgress(ep(1, 7, 2695));
    expect(getNextUp(1396)).toMatchObject({ season: 1, episode: 8 });
  });
});

describe('getContinueWatching', () => {
  it('drops a finished series from the rail', () => {
    saveProgress(ep(5, 16, 2695));
    expect(getContinueWatching(12, { 1396: SEASONS })).toHaveLength(0);
  });

  it('shows the next season opener after a season finale', () => {
    saveProgress(ep(1, 7, 2695));
    const [card] = getContinueWatching(12, { 1396: SEASONS });
    expect(card).toMatchObject({ season: 2, episode: 1 });
  });

  it('collapses a binged show to ONE card', () => {
    saveProgress(ep(1, 1, 2695));
    tick();
    saveProgress(ep(1, 2, 2695));
    tick();
    saveProgress(ep(1, 3, 900));
    const cw = getContinueWatching();
    expect(cw).toHaveLength(1);
    expect(cw[0]).toMatchObject({ tmdbId: 1396, season: 1, episode: 3 });
  });

  it('keeps a show whose last episode is finished, pointing at the next', () => {
    saveProgress(ep(1, 4, 2700));
    const cw = getContinueWatching();
    expect(cw).toHaveLength(1);
    expect(cw[0]).toMatchObject({ episode: 5, progressPct: 0 });
  });

  it('drops a finished movie but keeps one mid-watch', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 27205, positionSec: 8870,
                   durationSec: 8880, title: 'Inception' });   // 99.9% - finished
    saveProgress({ mediaType: 'movie', tmdbId: 100, positionSec: 600,
                   durationSec: 7000, title: 'Other' });
    const ids = getContinueWatching().map(p => p.tmdbId);
    expect(ids).toContain(100);
    expect(ids).not.toContain(27205);
  });

  it('orders by most recent activity across shows and movies', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 100, positionSec: 600,
                   durationSec: 7000, title: 'Old' });
    tick();
    saveProgress(ep(1, 2, 900));
    expect(getContinueWatching()[0].tmdbId).toBe(1396);
  });

  it('separates two different shows into two cards', () => {
    saveProgress(ep(1, 2, 900));
    saveProgress({ ...ep(1, 5, 700), tmdbId: 999, title: 'Panchayat' });
    expect(getContinueWatching()).toHaveLength(2);
  });

  it('keeps a film opened for only a few seconds', () => {
    // The rail used to require 60s (or 2%) before a movie counted. Open a
    // film, watch 40s, leave - and it vanished, which is exactly when you
    // most want it back. TV never had this gate; movies now match.
    saveProgress({ mediaType: 'movie', tmdbId: 42, positionSec: 40,
                   durationSec: 8880, title: 'Barely started' });
    expect(getContinueWatching().map(p => p.tmdbId)).toContain(42);
  });

  it('stacks the most recently opened title on top', () => {
    // "Queue or stack, not just any threshold": whatever was opened last
    // leads the rail, even when an older title is far further through.
    saveProgress({ mediaType: 'movie', tmdbId: 100, positionSec: 5000,
                   durationSec: 7000, title: 'Watched most of this' });
    tick();
    saveProgress({ mediaType: 'movie', tmdbId: 200, positionSec: 15,
                   durationSec: 7000, title: 'Just opened' });
    expect(getContinueWatching()[0].tmdbId).toBe(200);
  });

  it('still ignores a title that was never actually opened', () => {
    // Dropping the threshold must not resurrect a 0-second record.
    saveProgress({ mediaType: 'movie', tmdbId: 300, positionSec: 0,
                   durationSec: 7000, title: 'Never played' });
    expect(getContinueWatching().map(p => p.tmdbId)).not.toContain(300);
  });
});

describe('getShowProgress', () => {
  it('returns only that show, newest first', () => {
    saveProgress(ep(1, 1, 500));
    tick();
    saveProgress(ep(1, 2, 600));
    saveProgress({ ...ep(1, 1, 700), tmdbId: 999 });
    const rows = getShowProgress(1396);
    expect(rows).toHaveLength(2);
    expect(rows[0].episode).toBe(2);
  });
});


describe('getSeeds', () => {
  it('ignores a title barely started', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 1, positionSec: 90,
                   durationSec: 7000, title: 'Barely' });
    expect(getSeeds()).toHaveLength(0);
  });

  it('includes a title watched well into', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 1, positionSec: 3500,
                   durationSec: 7000, title: 'Halfway' });
    expect(getSeeds()[0]).toMatchObject({ tmdbId: 1, mediaType: 'movie' });
  });

  it('includes a finished title', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 2, positionSec: 6990,
                   durationSec: 7000, title: 'Done' });
    expect(getSeeds().map(s => s.tmdbId)).toContain(2);
  });

  it('collapses a binged series to one seed', () => {
    for (const e of [1, 2, 3]) {
      tick();
      saveProgress(ep(1, e, 2700));
    }
    const seeds = getSeeds();
    expect(seeds).toHaveLength(1);
    expect(seeds[0].tmdbId).toBe(1396);
  });

  it('returns the most recent first, capped', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 1, positionSec: 6990,
                   durationSec: 7000, title: 'Old' });
    tick();
    saveProgress({ mediaType: 'movie', tmdbId: 2, positionSec: 6990,
                   durationSec: 7000, title: 'New' });
    expect(getSeeds(1)).toEqual([{ mediaType: 'movie', tmdbId: 2, title: 'New',
                                   originalLang: null }]);
  });

  it('carries the original language so home rows can follow it', () => {
    saveProgress({ mediaType: 'movie', tmdbId: 3, positionSec: 6990,
                   durationSec: 7000, title: 'Pushpa', originalLang: 'te' });
    expect(getSeeds(1)[0]).toMatchObject({ tmdbId: 3, originalLang: 'te' });
    expect(getProgress('movie', 3).originalLang).toBe('te');
  });
});
