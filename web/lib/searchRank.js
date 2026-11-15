import { skeleton, editDistance } from './fuzzy';

/**
 * Prefix-first ranking for search, built for how people type Indian titles:
 * a few letters ("pu", "sala"), loose romanisation ("bahubali") or one typo
 * ("kalky"). Pure functions, so ranking is testable without TMDB.
 *
 * score = 3 * tier + 1 * preferred language + 0.6 * log10(votes)
 *       + 0.6 * log10(popularity) + 0.2 if released 2015 or later
 *
 * Measured 2026-11-15 on 17 prefix queries: TMDB's own order put the wanted
 * Indian title in the top 5 for 4/17; this formula over the local index plus
 * TMDB results gave 16/17 in the prototype.
 */

export const TIER = {
  EXACT: 1, PREFIX: 0.9, WORD_PREFIX: 0.8, SKEL_PREFIX: 0.7,
  SKEL_WORD_PREFIX: 0.65, TYPO: 0.6,
};

/** Lowercase, fold diacritics, keep words of a-z0-9 separated by one space. */
export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Everything matchTier needs about one name, computed once. */
export function prepName(name) {
  const n = norm(name);
  const words = n ? n.split(' ') : [];
  const swords = words.map(w => skeleton(w)).filter(Boolean);
  return { n, words, sn: swords.join(' '), swords, cn: swords.join('') };
}

export function prepQuery(q) {
  const p = prepName(q);
  return { ...p, cq: p.cn };
}

function typoNear(cq, target) {
  for (const len of [cq.length, cq.length + 1]) {
    if (len > target.length) continue;
    if (editDistance(cq, target.slice(0, len), 1) <= 1) return true;
  }
  return false;
}

/** How well a query matches one prepared name, as a TIER value or 0. */
export function matchTier(pq, pn) {
  if (!pq.n || !pn.n) return 0;
  if (pn.n === pq.n) return TIER.EXACT;
  if (pn.n.startsWith(pq.n)) return TIER.PREFIX;
  if (pn.n.includes(` ${pq.n}`)) return TIER.WORD_PREFIX;
  if (pq.sn) {
    if (pn.sn.startsWith(pq.sn)) return TIER.SKEL_PREFIX;
    if (pn.sn.includes(` ${pq.sn}`)) return TIER.SKEL_WORD_PREFIX;
  }
  // One typo, only for queries long enough that one edit is not most of it.
  // A one-word query is compared with WHOLE words: as a prefix test, "ramam"
  // is one edit from "ramay" and pulled Ramayana above Sita Ramam.
  if (pq.cq.length >= 4) {
    if (pq.swords.length > 1) {
      if (typoNear(pq.cq, pn.cn)) return TIER.TYPO;
    } else if (pn.swords.some(w => editDistance(pq.cq, w, 1) <= 1)) {
      return TIER.TYPO;
    }
  }
  return 0;
}

export function rankScore({ tier, lang, votes, popularity, year }, langs = []) {
  return 3 * tier
    + (lang && langs.includes(lang) ? 1 : 0)
    + 0.6 * Math.log10(1 + Math.max(0, votes || 0))
    + 0.6 * Math.log10(1 + Math.max(0, popularity || 0))
    + ((year || 0) >= 2015 ? 0.2 : 0);
}

/** Best tier over a TMDB-shaped record's display and original titles. */
export function tierOf(pq, m) {
  const names = [m.title, m.name, m.original_title, m.original_name].filter(Boolean);
  let best = 0;
  for (const name of names) best = Math.max(best, matchTier(pq, prepName(name)));
  return best;
}

export const yearOf = (m) =>
  Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || 0;
