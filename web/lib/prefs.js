// Viewer preferences: which languages to rank first, in order. Local-first,
// like progress and the list.
//
// Shared by the browser (localStorage) and the route handlers (query-param
// parsing), so this file must not touch `window` at import time.
const KEY = 'chitram:prefs:v1';
// Fired on window after a save, so open pages refresh without a reload.
export const PREFS_EVENT = 'chitram:prefs';

export const PREF_LANGS = [
  { code: 'te', label: 'Telugu' },
  { code: 'ta', label: 'Tamil' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'kn', label: 'Kannada' },
];

// Every major streaming app in India (TMDB watch-provider ids, watch_region=IN,
// checked against /watch/providers on 2026-11-15). Fixed for everyone: the
// OTT rows mean "streaming somewhere in India", not "on apps you picked".
export const INDIA_PROVIDERS = [
  8,     // Netflix
  119,   // Prime Video
  2336,  // JioHotstar
  232,   // Zee5
  237,   // SonyLIV
  309,   // Sun NXT
  532,   // aha
  350,   // Apple TV
  482,   // ManoramaMAX
  515,   // MX Player
];

export const DEFAULT_PREFS = Object.freeze({
  langs: PREF_LANGS.map(l => l.code),
});

const LANG_CODES = new Set(PREF_LANGS.map(l => l.code));

/** Keep known codes, in the given order, without repeats. */
export function cleanLangs(list) {
  const out = [];
  for (const c of list || []) {
    const code = String(c).trim().toLowerCase();
    if (LANG_CODES.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Parse `te,ta,hi` from a query string. Empty or junk gives the default. */
export function parseLangs(str) {
  const out = cleanLangs(String(str || '').split(','));
  return out.length ? out : [...DEFAULT_PREFS.langs];
}

export function hasPrefs() {
  try { return Boolean(localStorage.getItem(KEY)); } catch { return false; }
}

/** Stored prefs; an old `providers` field is ignored. */
export function getPrefs() {
  try {
    const langs = cleanLangs(JSON.parse(localStorage.getItem(KEY) || 'null')?.langs);
    return { langs: langs.length ? langs : [...DEFAULT_PREFS.langs] };
  } catch {
    return { langs: [...DEFAULT_PREFS.langs] };
  }
}

export function savePrefs({ langs }) {
  const clean = cleanLangs(langs);
  const next = { langs: clean.length ? clean : [...DEFAULT_PREFS.langs] };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next })); } catch { /* server */ }
  return next;
}

/** Query string for the API: `langs=te,ta`. */
export function prefsQuery({ langs } = {}) {
  return langs?.length ? new URLSearchParams({ langs: langs.join(',') }).toString() : '';
}
