/**
 * Transliteration-tolerant matching for Indian-language titles.
 *
 * Telugu, Tamil, Kannada and Malayalam titles are romanised inconsistently —
 * "Geetha Govindam" is written Gita/Geeta/Githa, Govindam/Govindham. TMDB's
 * search is literal, so "gita govindam" returns ZERO results for a film that
 * plainly exists (measured). These helpers close that gap.
 */

/**
 * Reduce a title to a spelling-insensitive skeleton.
 *
 * The rules collapse the ways the same Indian phoneme gets romanised:
 * aspirated consonants (dh/th/gh/bh -> d/t/g/b), doubled letters, long vowels
 * (ee/aa/oo -> e/a/o), and the v/w and j/z pairs. "geethagovindam",
 * "gitagovindham" and "geetagovindam" all reduce to the same key.
 */
export function skeleton(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip diacritics: Bāhubali -> Bahubali
    .replace(/[^a-z0-9]+/g, '')
    .replace(/ph/g, 'f')
    .replace(/sh/g, 's')
    .replace(/([bcdgjkpt])h/g, '$1')                    // dh->d, th->t, gh->g, bh->b
    .replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks')
    .replace(/w/g, 'v').replace(/z/g, 'j')
    // Long vowels first: 'ee'/'ea' and 'i' name the same sound in Geetha/Gita,
    // and 'oo'/'u' likewise. Collapsing doubles before this would strand them.
    .replace(/(ee|ea|ie)/g, 'i').replace(/oo/g, 'u')
    .replace(/(.)\1+/g, '$1')                           // remaining doubles
    .replace(/[aeiou]{2,}/g, m => m[0]);                // vowel runs -> first
}

/** Levenshtein, bounded — we only care about small edit distances. */
export function editDistance(a, b, max = 4) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let jj = 1; jj <= b.length; jj++) {
      const cost = a[i - 1] === b[jj - 1] ? 0 : 1;
      cur[jj] = Math.min(prev[jj] + 1, cur[jj - 1] + 1, prev[jj - 1] + cost);
      if (cur[jj] < best) best = cur[jj];
    }
    if (best > max) return max + 1;   // whole row exceeded the budget
    prev = cur;
  }
  return prev[b.length];
}

/**
 * 0..1 similarity between a query and a candidate title, spelling-insensitive.
 * 1 is an exact skeleton match; a prefix or contained match scores high, and
 * anything beyond a few edits scores 0.
 */
export function similarity(query, title) {
  // Titles carry subtitles the user does not type: "Pushpa: The Rise - Part 1"
  // scored 0 against "pushpa" because the whole string was compared. Score the
  // main title too and keep the better result.
  const head = String(title || '').split(/\s*[:\u2013-]\s+|\s*:\s*/)[0];
  if (head && head !== title) {
    return Math.max(scoreOne(query, title), scoreOne(query, head));
  }
  return scoreOne(query, title);
}

/**
 * The part of a search query that identifies a title. Users commonly add a
 * release year or a media type ("leo 2023 movie"); sending that text to the
 * provider is useful, but including it in title scoring unfairly penalises an
 * otherwise exact match.
 */
export function searchKey(q) {
  return String(q || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:movie|film|series|show|tv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreOne(query, title) {
  const q = skeleton(query), t = skeleton(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  // A containment match must be substantial: without this, the single letter
  // "a" scored 0.84 against "Baahubali" and any short query matched everything.
  const covers = q.length / t.length;

  // Whether the query lands on a WORD boundary in the original title, not just
  // somewhere in the space-stripped skeleton.
  //
  // skeleton() removes spaces, so "Rama Madhav" becomes "ramamadav" - which
  // startsWith("ramam") by pure coincidence of where the words meet. That
  // scored 0.92 for the query "ramam", above the 0.84 given to Sita Ramam,
  // which actually contains the word. A collision across a word boundary is
  // not a match and must not outrank a real one.
  // Diacritics must be folded BEFORE splitting, or "Bāhubali" splits into "b"
  // and "hubali" (the a-with-macron is not in a-z) and the word check fails on
  // exactly the titles it exists to serve.
  const words = String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const onWord = words.some(w => skeleton(w).startsWith(q));

  if (t.startsWith(q)) {
    // A prefix of the whole title still only counts as a strong match when it
    // is also a real word start.
    // A useful prefix does not need to be a third of the full title: vish
    // should match Vishwanath & Sons. Require a meaningful four-character
    // word prefix, rather than allowing one/two-letter noise to dominate.
    if (q.length >= 3 && onWord && covers < 0.34) return 0.88;
    if (q.length >= 3 && covers >= 0.34) return onWord ? 0.92 : 0.62;
    return 0.55 * covers;
  }
  if (t.includes(q)) {
    // A word inside the title beats a coincidental prefix across a boundary,
    // so "ramam" ranks Sita Ramam above Rama Madhav.
    if (q.length >= 4 && covers >= 0.34) return onWord ? 0.9 : 0.6;
    return 0.45 * covers;
  }
  const budget = Math.max(2, Math.floor(Math.max(q.length, t.length) * 0.25));
  const d = editDistance(q, t, budget);
  if (d > budget) return 0;
  return Math.max(0, 1 - d / Math.max(q.length, t.length));
}

/**
 * Spelling variants to ask TMDB for when a literal search comes back thin.
 *
 * Each rule rewrites one romanisation choice. Capped, because every variant
 * costs a request.
 */
export function searchScore(query, item) {
  const names = [item?.title, item?.name, item?.original_title, item?.original_name].filter(Boolean);
  const base = Math.max(0, ...names.map(name => similarity(query, name)));
  const words = String(item?.title || item?.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const regional = ['te', 'ta', 'kn', 'ml', 'hi'].includes(item?.original_language);
  const releaseYear = Number(item?.release_date?.slice(0, 4) || item?.first_air_date?.slice(0, 4));
  const token = words.some(w => skeleton(w) === skeleton(query));
  return base + (regional && token && words.length > 1 ? 0.08 : 0)
    + (regional && releaseYear >= new Date().getFullYear() - 3 ? 0.04 : 0);
}

export function variants(q, cap = 4) {
  const base = String(q || '').trim().toLowerCase();
  if (!base) return [];
  const out = new Set();

  // Per-word canonicalisation. Applying one rewrite at a time never reaches
  // the spelling TMDB indexes: from "githa govindham" no single swap yields
  // "geetha govindam", because BOTH words need fixing. So build two whole-
  // string forms - one long, one short - and let each word carry its own fix.
  const long = (w) => w
    .replace(/^g(i|ee|e)(th|t)?a$/, 'geetha')     // gita/githa/geeta -> geetha
    .replace(/dham$/, 'dam').replace(/tham$/, 'tam')
    .replace(/^([bcdfghjklmnpqrstvwxyz])i(?=[a-z])/, '$1ee');  // first syllable only
  const short = (w) => w
    .replace(/^g(i|ee|e)(th|t)?a$/, 'gita')
    .replace(/ee/g, 'i').replace(/aa/g, 'a')
    .replace(/dham$/, 'dam').replace(/tham$/, 'tam').replace(/th/g, 't');

  for (const form of [long, short]) {
    const v = base.split(/\s+/).map(form).join(' ');
    if (v !== base && v.length > 2) out.add(v);
  }

  // Then the single-rule swaps, for queries the canonical forms do not cover.
  const swaps = [
    [/dh/g, 'd'], [/th/g, 't'], [/ee/g, 'i'], [/aa/g, 'a'],
    [/v/g, 'w'], [/oo/g, 'u'],
  ];
  for (const [re, to] of swaps) {
    if (out.size >= cap) break;
    const v = base.replace(re, to);
    if (v !== base && v.length > 2) out.add(v);
  }
  return [...out].slice(0, cap);
}

/**
 * Corrections for ordinary typing mistakes, as opposed to spelling choices.
 *
 * Full single-edit expansion is far too expensive — "kantera" alone has 182
 * neighbours, and each is a request. These are the few classes that actually
 * occur and that TMDB then resolves: a doubled letter (pusspa -> pushpa), a
 * y/i ending (kalky -> kalki), a v/b slip (bahuvali -> bahubali), and a wrong
 * vowel in the final syllable (kantera -> kantara).
 */
export function typoFixes(q, cap = 4) {
  const base = String(q || '').trim().toLowerCase();
  if (base.length < 4) return [];
  const out = new Set();
  const add = (v) => { if (v && v !== base && v.length > 2) out.add(v); };

  add(base.replace(/([a-z])\1/g, '$1'));    // doubled letter -> single
  add(base.replace(/ss/g, 'sh'));           // pusspa -> pushpa
  add(base.replace(/y\b/g, 'i'));           // kalky -> kalki
  add(base.replace(/v/g, 'b'));             // bahuvali -> bahubali
  add(base.replace(/b/g, 'v'));
  add(base.replace(/v/g, 'w')); // vishvanath -> vishwanath
  add(base.replace(/w/g, 'v'));
  add(base.replace(/(?<=h)v/g, 'w'));
  // A wrong vowel in the last syllable: kantera -> kantara, devera -> devara.
  for (const [from, to] of [['e', 'a'], ['a', 'e'], ['i', 'a'], ['o', 'a']]) {
    add(base.replace(new RegExp(`${from}([a-z]{0,2})$`), `${to}$1`));
  }
  return [...out].slice(0, cap);
}
