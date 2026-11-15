import { PREF_LANGS } from './prefs';

// `href` gives each row a "See all" into the equivalent browse view, so a
// rail is an entry point rather than a dead end capped at 18 titles.
//
// Section order follows the common pattern of OTT home pages. Sources read
// 2026-11-15: Netflix Tech Blog "Learning a Personalized Homepage" (rows
// ranked per member, repeats removed at page assembly; Continue Watching,
// Because you watched, Top 10, genre rows); Deadline and TheWrap on the July
// 2024 Prime Video redesign (bigger spotlight hero with Play/More, "Top 10 in
// <country>" and "Trending" rows). JioHotstar layout: no primary source found.
// Order used:
// spotlight carousel (the Hero, above these rows), Continue watching, a
// ranked Top 10 for the country, new releases, trending, "Because you
// watched", per-language rows, genre rows, My list, Coming soon.
//
// Per-language: "Latest <Lang> movies" (last ~2 years by popularity) and
// "Popular <Lang> shows" (recent series streaming in India). The earlier
// per-language "New on OTT" rows were dropped: measured 2026-11-15 they
// repeated the combined row (12 of the top-5 titles sat in two or more rows).
//
// `thin` hides a row that came back with fewer titles than that, after
// cross-row dedupe: per-language series coverage is uneven (Kannada 1).
const label = (code) => PREF_LANGS.find(l => l.code === code)?.label || code;

export const GENRE_ROWS = [
  { id: 28, label: 'Action' }, { id: 53, label: 'Thrillers' },
  { id: 35, label: 'Comedy' }, { id: 10749, label: 'Romance' },
  { id: 10751, label: 'Family' },
];

export function homeRows(langs) {
  const rows = [
    { kind: 'continue', label: 'Continue watching' },
    { kind: 'top10', label: 'Top 10 in India today', ranked: true, thin: 5 },
    { kind: 'recent', label: 'New on OTT', thin: 4,
      href: `/browse?sort=primary_release_date.desc&lang=${langs.join(',')}` },
    { kind: 'trending', label: 'Trending now', thin: 4,
      href: '/browse?sort=popularity.desc' },
  ];
  for (const code of langs) {
    rows.push({ kind: code, label: `Latest ${label(code)} movies`, thin: 4,
                href: `/browse?lang=${code}`, lang: code });
    rows.push({ kind: `series-${code}`, label: `Popular ${label(code)} shows`, thin: 6,
                href: `/browse?type=tv&lang=${code}` });
  }
  for (const g of GENRE_ROWS) {
    rows.push({ kind: `genre-${g.id}`, label: g.label, thin: 6,
                href: `/browse?genre=${g.id}&lang=${langs.join(',')}` });
  }
  rows.push({ kind: 'list', label: 'My list', href: '/list' });
  rows.push({ kind: 'upcoming', label: 'Coming soon', thin: 4 });
  return rows;
}

/**
 * Each title appears once, in the first row (in display order) that has it,
 * as Netflix does when it assembles a page. Personal rows (Continue watching,
 * My list) and the ranked Top 10 are never trimmed, but their titles are not
 * repeated below them.
 * A row still loading (undefined) is left as is and claims nothing.
 */
const PERSONAL = new Set(['continue', 'list']);

export function dedupeRows(rows, data) {
  const seen = new Set();
  const out = {};
  for (const { kind, ranked } of rows) {
    const titles = data[kind];
    if (!titles) { out[kind] = titles; continue; }
    // A ranked chart keeps every position: a gap at #3 would misreport it.
    out[kind] = PERSONAL.has(kind) || ranked
      ? titles
      : titles.filter(t => !seen.has(`${t.mediaType}-${t.tmdbId}`));
    for (const t of out[kind]) seen.add(`${t.mediaType}-${t.tmdbId}`);
  }
  return out;
}
