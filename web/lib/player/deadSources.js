import { languageName } from '../subtitles';

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

const langKey = (l) => String(languageName(l) || '').trim().toLowerCase();

/** Pixel height from a quality claim: "1080p" -> 1080, "4K" -> 2160, "Auto" -> null. */
export function qualityHeight(q) {
  const t = String(q || '').toLowerCase();
  if (/\b(4k|uhd|2160)/.test(t)) return 2160;
  const m = t.match(/(\d{3,4})p?/);
  return m ? Number(m[1]) : null;
}

/**
 * The playable row to fail over to, or null. Never a dead row.
 *
 * A failover must not change the spoken language. Providers differ in audio
 * for one title (RRR, movie/579974), so the first alive row in list order can
 * swap Telugu for Hindi with nobody asking for it. Only the viewer's own
 * language pick may cross languages; that path calls switchSource with `lang`
 * and never comes through here.
 *
 * `opts.lang`   the language PLAYING now (name or code). Ranks rows:
 *               carries it (a hybrid row lists its paired audio languages, so
 *               it counts), then rows that declare no languages (may carry it;
 *               a server switch never pairs, owner rule 2026-11-21), then
 *               rows that declare only other languages.
 * `opts.height` the height playing now; nearer heights first within a rank.
 * List order breaks ties. With no opts this is the first alive row, as before.
 */
export function nextAlive(sources = [], dead = new Set(), { lang = null, height = null } = {}) {
  const want = lang ? langKey(lang) : '';
  const h = Number(height) > 0 ? Number(height) : null;
  const langRank = (s) => {
    if (!want) return 0;
    const langs = (Array.isArray(s.languages) ? s.languages : []).filter(Boolean);
    if (langs.some((l) => langKey(l) === want)) return 0;
    return langs.length ? 2 : 1;
  };
  const dist = (s) => {
    if (h == null) return 0;
    const sh = qualityHeight(s.quality);
    return sh == null ? Infinity : Math.abs(sh - h);
  };
  const ranked = (sources || [])
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s?.masterUrl && !dead.has(deadKey(s)))
    .map((r) => ({ ...r, l: langRank(r.s), d: dist(r.s) }))
    .sort((a, b) => a.l - b.l || (a.d === b.d ? 0 : a.d < b.d ? -1 : 1) || a.i - b.i);
  return ranked.length ? ranked[0].s : null;
}
