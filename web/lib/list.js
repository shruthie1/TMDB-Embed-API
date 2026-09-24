// My List — local-first, same as progress. Supabase sync lands in M3.
const KEY = 'chitram:list:v1';

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };
const idOf = (type, id) => `${type}:${id}`;

export function inList(type, id) {
  return Boolean(read()[idOf(type, id)]);
}

/** @returns {boolean} the new saved state */
export function toggleList(t) {
  const all = read();
  const k = idOf(t.mediaType, t.tmdbId);
  if (all[k]) { delete all[k]; write(all); return false; }
  all[k] = {
    mediaType: t.mediaType, tmdbId: t.tmdbId, title: t.title,
    poster: t.poster, year: t.year, addedAt: Date.now(),
  };
  write(all);
  return true;
}

export function getList(limit = 40) {
  return Object.values(read()).sort((a, b) => b.addedAt - a.addedAt).slice(0, limit);
}
