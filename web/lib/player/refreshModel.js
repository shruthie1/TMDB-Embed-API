import { languageName } from '../subtitles';

/**
 * "Refresh sources" journey (owner 2026-11-22), the same words and states as
 * the APK's RefreshModel.kt:
 * idle -> refreshing -> updated / no change / failed -> cooldown -> idle.
 * Pure: the button, the source list and the failure card draw from it.
 */

/** At most one refresh per title in this window (owner: 30 s). */
export const REFRESH_COOLDOWN_MS = 30000;
/** Result lines hide after this. */
export const REFRESH_NOTE_MS = 3000;

export const RefreshCopy = Object.freeze({
  IDLE: 'Refresh sources',
  RUNNING: 'Refreshing…',
  FAILED: "Couldn't refresh. Try again.",
  NO_CHANGE: 'No new sources',
  NONE: 'No sources found yet',
  PLAYBACK_CONTINUES: 'Current playback continues',
  cooldown: (ms) => `Refresh again in ${Math.max(1, Math.ceil(Math.max(0, ms) / 1000))}s`,
  updated: (n, inLang, language) => `Updated: ${n} ${n === 1 ? 'source' : 'sources'} (${inLang} ${language})`,
});

export const RefreshState = Object.freeze({ IDLE: 'idle', REFRESHING: 'refreshing', COOLDOWN: 'cooldown' });

export const initialRefresh = Object.freeze({ running: false, note: null, noteUntil: 0, readyAt: 0, answered: [] });

export function refreshState(m, now) {
  if (m.running) return RefreshState.REFRESHING;
  if (m.readyAt > now) return RefreshState.COOLDOWN;
  return RefreshState.IDLE;
}

export function refreshLabel(m, now) {
  const s = refreshState(m, now);
  if (s === RefreshState.REFRESHING) return RefreshCopy.RUNNING;
  if (s === RefreshState.COOLDOWN) return RefreshCopy.cooldown(m.readyAt - now);
  return RefreshCopy.IDLE;
}

export const refreshNote = (m, now) => (m.note && now < m.noteUntil ? m.note : null);

export const refreshStart = (now, readyAt) => ({ ...initialRefresh, running: true, readyAt });
export const refreshFinish = (m, now, note) => ({ ...m, running: false, note, noteUntil: now + REFRESH_NOTE_MS });
/** Pressed during the cooldown: say when, never a dead control. */
export const refreshBlocked = (m, now, readyAt) =>
  ({ ...m, running: false, note: RefreshCopy.cooldown(readyAt - now), noteUntil: now + REFRESH_NOTE_MS, readyAt });

// A row may name its language ("Telugu") or tag it by code ("te", "tel"):
// both are the same language. languageName resolves codes; names pass through.
const langKey = (l) => String(languageName(String(l || '').trim()) || '').trim().toLowerCase();
const sameLang = (a, b) => Boolean(a) && Boolean(b) && langKey(a) === langKey(b);
const langsOf = (s) => [...(s?.languages || []), ...(s?.audioLanguages || []),
  ...((s?.audio || []).map((a) => a?.language)), ...((s?.audioTracks || []).map((t) => t?.language || t?.name))]
  .filter(Boolean);

/**
 * The result line. `failed`: nothing came back. Empty answer: none found. The
 * same urls as before: no new sources. Else the count, with how many carry the
 * viewer's language.
 */
export function refreshOutcome(beforeUrls, after, failed, preferred = 'Telugu') {
  if (failed) return RefreshCopy.FAILED;
  if (!after?.length) return RefreshCopy.NONE;
  const urls = new Set(after.map((s) => s.masterUrl || s.url));
  const before = beforeUrls instanceof Set ? beforeUrls : new Set(beforeUrls || []);
  if (before.size && before.size === urls.size && [...urls].every((u) => before.has(u))) return RefreshCopy.NO_CHANGE;
  const inLang = after.filter((s) => langsOf(s).some((l) => sameLang(l, preferred))).length;
  return RefreshCopy.updated(after.length, inLang, preferred);
}

/**
 * The one automatic start after a refresh: the source on screen had already
 * failed (failure card) and the refresh found rows. Never while one plays.
 */
export const refreshAutoStart = (errored, rows) => Boolean(errored) && Array.isArray(rows) && rows.length > 0;

// ---- Throttle, per title, shared by the title page and the player -------------

const last = new Map();
export const refreshKey = (type, id, season = 0, episode = 0) => `${type}:${id}:${season || 0}:${episode || 0}`;
/** When the next refresh of this title may run. */
export function refreshReadyAt(key) {
  const at = last.get(key);
  return at == null ? 0 : at + REFRESH_COOLDOWN_MS;
}
/** Claims the refresh slot for `key`; false while the cooldown runs. */
export function claimRefresh(key, now = Date.now()) {
  if (refreshReadyAt(key) > now) return false;
  last.set(key, now);
  return true;
}
/** Tests. */
export function resetRefreshThrottle() { last.clear(); }

/**
 * Gap 10.3: a refresh while a row plays replaces the list but never drops the
 * playing row: when the new answer lacks it, it stays at the end, selected.
 * `prev` is the list on screen, `next` the new one, `keepId` the playing row.
 */
export function keepPlayingRow(prev, next, keepId) {
  const keep = keepId != null ? (prev || []).find((p) => p.id === keepId) : null;
  return keep && !next.some((n) => n.id === keepId) ? [...next, keep] : next;
}
