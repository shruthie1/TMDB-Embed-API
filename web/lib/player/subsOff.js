/**
 * Client-wide "subtitles off" choice (owner 2026-11-22).
 *
 * Once the viewer turns subtitles off in any player, no later title, episode,
 * provider switch or refresh may turn them on by itself. Only an explicit
 * pick of a track clears it. Not tied to a title. A fresh client has no key,
 * so the old auto-pick behaviour stays the default.
 */
const KEY = 'chitram:subs:off:v1';

export function getSubsOff() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setSubsOff(off) {
  try { localStorage.setItem(KEY, off ? '1' : '0'); } catch { /* private mode */ }
}
