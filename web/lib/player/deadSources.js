/**
 * Which sources died this session, by SOURCE ID.
 *
 * Keyed by provider name until 2026-11-16, and a name no longer identifies a
 * row: Devara (movie/811941) comes back as five CastleTV rows. One CastleTV
 * failure therefore marked all five dead, recovery found "no alternative"
 * while four untouched rows were still in hand, and with every row "dead" the
 * VaPlayer embed took over the stage. The id is the row's identity everywhere
 * else in the player, so it is the identity here too.
 *
 * A row with no id (older shapes) falls back to its provider name.
 */
export const deadKey = (s) => (s?.id != null ? s.id : s?.provider);

/** Record the row that just failed, by its id (or name when it has none). */
export function markDead(dead, { id = null, provider = null } = {}) {
  const key = id != null ? id : provider;
  if (key != null) dead.add(key);
  return dead;
}

/** The first playable row that has not died, or null. */
export function nextAlive(sources = [], dead = new Set()) {
  return (sources || []).find((s) => s?.masterUrl && !dead.has(deadKey(s))) || null;
}
