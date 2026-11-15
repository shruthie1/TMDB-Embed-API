// Watch progress. Local-first so it works with the VM or Supabase down;
// Supabase sync lands in M3.
const KEY = 'chitram:progress:v1';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }
}
function write(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

const idOf = (t, id, s = 0, e = 0) => `${t}:${id}:${s}:${e}`;

/** Started enough to be worth resuming — not a stray click or a seek to 0. */

export function saveProgress({ mediaType, tmdbId, season = 0, episode = 0,
                               positionSec, durationSec, title, poster,
                               epTitle = null, originalLang = null }) {
  if (!durationSec || positionSec == null) return;
  const all = read();
  // Percentage-based, so a 22-min episode and a 3-hour film behave the same.
  const pct = Math.min(100, (positionSec / durationSec) * 100);
  const finished = positionSec >= Math.min(durationSec - 30, durationSec * 0.95);
  all[idOf(mediaType, tmdbId, season, episode)] = {
    mediaType, tmdbId, season, episode, positionSec, durationSec,
    pct, finished, title, poster, epTitle,
    // Kept so home rows can follow the languages actually watched.
    originalLang: originalLang || null, updatedAt: Date.now(),
  };
  write(all);
}

export function getProgress(mediaType, tmdbId, season = 0, episode = 0) {
  return read()[idOf(mediaType, tmdbId, season, episode)] || null;
}

/** Every stored entry for one show, newest first. */
export function getShowProgress(tmdbId) {
  return Object.values(read())
    .filter(p => p.mediaType === 'tv' && p.tmdbId === tmdbId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * What to play when you press Play on a series.
 *
 * Resume the last episode if it is genuinely mid-watch; otherwise point at the
 * one after it. Returns null for a show never started, so the caller falls back
 * to S1E1.
 *
 * `seasons` is TMDB's season list ([{number, episodes}]). Without it we cannot
 * know where a season ends, and would offer phantom episodes — Breaking Bad
 * S1E8 (season 1 has 7) or S5E17 (the series ends at S5E16). Pass it whenever
 * it is available; omitting it degrades to the naive episode+1.
 */
export function getNextUp(tmdbId, seasons = null) {
  const [last] = getShowProgress(tmdbId);
  if (!last) return null;
  // ANY unfinished episode resumes, however little of it was watched. This
  // used to require `started(last)` - over 60s - so watching 45s of an episode
  // and coming back opened the NEXT one, skipping content never seen. The 60s
  // floor is right for the Continue Watching rail, where it keeps accidental
  // taps off the shelf, but it is wrong here: once a show is on the rail, the
  // episode you left is the episode you want.
  if (!last.finished) {
    return { ...last, resume: true };
  }

  // Finished — advance, rolling over at a season boundary.
  let season = last.season, episode = last.episode + 1;
  if (seasons?.length) {
    const count = seasons.find(s => s.number === last.season)?.episodes;
    if (count && episode > count) {
      const next = seasons.find(s => s.number === last.season + 1);
      // No next season: the series is finished. Offer a rewatch of the last
      // episode rather than an episode that does not exist.
      if (!next) return { ...last, resume: false, seriesEnded: true };
      season = next.number;
      episode = 1;
    }
  }

  return {
    mediaType: 'tv', tmdbId, season, episode,
    positionSec: 0, durationSec: 0, pct: 0, finished: false,
    title: last.title, poster: last.poster, epTitle: null,
    resume: false, afterFinished: last.finished,
  };
}

/**
 * Continue watching.
 *
 * One card per title: a series collapses to a single entry showing the next
 * episode to play, so bingeing a show cannot crowd out everything else.
 */
export function getContinueWatching(limit = 12, seasonsByShow = null) {
  const all = Object.values(read());

  // No minimum watch time. Opening a film and leaving after 40s used to drop
  // it entirely - the rail is a STACK of what you last opened, so the thing
  // you just watched is always on top, whatever the threshold would have said.
  // TV already worked this way (see getNextUp); movies now match it.
  const movies = all
    .filter(p => p.mediaType !== 'tv' && !p.finished && p.positionSec > 0);

  // Group series by show, keeping only the most recent activity per show.
  const shows = new Map();
  for (const p of all) {
    if (p.mediaType !== 'tv') continue;
    const cur = shows.get(p.tmdbId);
    if (!cur || p.updatedAt > cur.updatedAt) shows.set(p.tmdbId, p);
  }

  const series = [];
  for (const [tmdbId, last] of shows) {
    const next = getNextUp(tmdbId, seasonsByShow?.[tmdbId] || null);
    if (!next) continue;
    // A finished series has nothing to continue — drop it from the rail.
    if (next.seriesEnded) continue;
    // A show whose last episode was finished still belongs here — the next
    // episode is exactly what you came back for. Progress shows 0 for it.
    series.push({ ...next, updatedAt: last.updatedAt });
  }

  return [...movies, ...series]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map(p => ({ ...p, progressPct: p.pct }));
}

/**
 * The titles worth basing recommendations on.
 *
 * Prefers what you actually finished or got well into — a title abandoned
 * after two minutes says nothing about taste. Series collapse to one entry so
 * a binge cannot make every suggestion about one show.
 */
export function getSeeds(limit = 3) {
  const all = Object.values(read());
  const byTitle = new Map();
  for (const p of all) {
    // 25% in, or finished, is the bar for "this reflects a preference".
    if (!p.finished && p.pct < 25) continue;
    const k = `${p.mediaType}:${p.tmdbId}`;
    const cur = byTitle.get(k);
    if (!cur || p.updatedAt > cur.updatedAt) byTitle.set(k, p);
  }
  return [...byTitle.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map(p => ({ mediaType: p.mediaType, tmdbId: p.tmdbId, title: p.title,
                 originalLang: p.originalLang || null }));
}
