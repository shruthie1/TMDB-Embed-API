/**
 * Subtitles.
 *
 * Streams carry none — every provider manifest has zero SUBTITLES tags
 * (measured across mapple/videasy/vidking) — so captions come from an external
 * catalogue. Stremio's OpenSubtitles addon is the one source that needs no key
 * and no account: OpenSubtitles' own API returns 403 without one and caps free
 * accounts at 5-20 downloads a day, and both SubDL and Wyzie now demand keys.
 *
 * Measured coverage: 24-99 subtitle files per title, including Indian cinema
 * (RRR 95, Baahubali 99, Pushpa 41, Kantara 33) and per-episode for series.
 */
const BASE = process.env.NEXT_PUBLIC_OPENSUBS_BASE || 'https://opensubtitles-v3.strem.io';

// ISO-639-2 as returned by the addon -> what a person calls it.
const NAMES = {
  eng: 'English', hin: 'Hindi', tel: 'Telugu', tam: 'Tamil', kan: 'Kannada',
  mal: 'Malayalam', ben: 'Bengali', mar: 'Marathi', guj: 'Gujarati',
  pan: 'Punjabi', urd: 'Urdu', spa: 'Spanish', fre: 'French', ger: 'German',
  ita: 'Italian', por: 'Portuguese', pob: 'Portuguese (BR)', rus: 'Russian',
  ara: 'Arabic', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zht: 'Chinese (Trad)',
  tur: 'Turkish', ind: 'Indonesian', may: 'Malay', tha: 'Thai', vie: 'Vietnamese',
  dut: 'Dutch', swe: 'Swedish', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish',
  pol: 'Polish', ces: 'Czech', cze: 'Czech', ell: 'Greek', heb: 'Hebrew',
  hun: 'Hungarian', ron: 'Romanian', rum: 'Romanian', ukr: 'Ukrainian',
  per: 'Persian', sin: 'Sinhala', hrv: 'Croatian', srp: 'Serbian', bul: 'Bulgarian',
};

/**
 * HLS manifests use ISO-639-1 (`te`), OpenSubtitles uses ISO-639-2 (`tel`).
 * Both reach this function, so both must resolve - otherwise a real Telugu
 * audio rendition renders as "TE". Region tags (`pt-BR`) are matched on the
 * full code first, then on the bare language.
 */
const SHORT = {
  en: 'eng', hi: 'hin', te: 'tel', ta: 'tam', kn: 'kan', ml: 'mal',
  bn: 'ben', mr: 'mar', gu: 'guj', pa: 'pan', ur: 'urd', es: 'spa',
  fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ru: 'rus', ar: 'ara',
  ja: 'jpn', ko: 'kor', zh: 'chi', tr: 'tur', id: 'ind', ms: 'may',
  th: 'tha', vi: 'vie', nl: 'dut', sv: 'swe', da: 'dan', nb: 'nor',
  no: 'nor', fi: 'fin', pl: 'pol', cs: 'ces', el: 'ell', he: 'heb',
  hu: 'hun', ro: 'ron', uk: 'ukr', fa: 'per', si: 'sin', hr: 'hrv',
  sr: 'srp', bg: 'bul',
};

export const languageName = (code) => {
  if (!code) return '';
  const raw = String(code);
  if (NAMES[raw]) return NAMES[raw];
  const lower = raw.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  if (lower === 'pt-br') return NAMES.pob;
  const base = lower.split('-')[0];
  return NAMES[SHORT[base]] || NAMES[base] || raw.toUpperCase();
};

// The household's languages first, then English, then everything else. A list
// of 99 files is useless if Telugu is buried at position 60.
// The catalogue tags English under several codes; treat them as one language.
const ENGLISH = new Set(['eng', 'en', 'eng-us', 'eng-gb']);

// A subtitle split across discs covers HALF a film, and one timed to a
// camcorder or telecine recording follows a different edit. Both are only
// detectable after downloading - by which point the viewer has already clicked
// and waited - but the LISTING names them.
//
// Measured on tt0330373 (Goblet of Fire), 7 English tracks: this hides 5 of
// the 6 mistimed ones and NONE of the usable ones, taking the menu from 7
// entries to 2. The remaining miss is a DVDSCR whose name says nothing, which
// the post-download span check still catches.
const SPLIT_PART = /\bCD\s?\d\b|\bpart\s?\d\b|\bdisc\s?\d\b/i;
const CAM_SOURCE = /\b(TS|TELESYNC|CAM|HDCAM|TC|TELECINE)\b/i;

/**
 * True when the listing itself says this file cannot match the feature.
 *
 * Conservative on purpose: it reads only unambiguous markers, because hiding a
 * WORKING subtitle is worse than showing one that fails - the viewer can retry
 * a failure, but cannot retry something absent from the menu.
 */
export function isWrongCut(sub = {}) {
  const blob = [sub.subtitleFileName, sub.movieReleaseName, sub.releaseFormat]
    .filter(Boolean).join(' ');
  return SPLIT_PART.test(blob) || CAM_SOURCE.test(blob);
}

/**
 * Describe an English variant in words a viewer can choose between.
 *
 * The release name is the only metadata the catalogue gives, and it is exactly
 * what determines whether the timing lines up: a file cut for a 25fps Hindi
 * WEB-DL drifts against a 24fps Blu-ray of the same film.
 */
function variantLabel(s, index) {
  const name = `${s.subtitleFileName || ''} ${s.movieReleaseName || ''}`;
  const src = /blu-?ray|bdrip|brrip/i.test(name) ? 'Blu-ray'
            : /web-?dl|webrip|amzn|nf\b|zee5|hotstar/i.test(name) ? 'WEB-DL'
            : /hdrip|dvdrip|dvd/i.test(name) ? 'DVD/HD'
            : /hdtv/i.test(name) ? 'HDTV'
            : null;
  const cut = /extended/i.test(name) ? 'Extended'
            : /theatrical/i.test(name) ? 'Theatrical'
            : /director/i.test(name) ? "Director's cut"
            : null;
  const hi  = /\bsdh\b|hearing.?impaired|\bhi\b(?![a-z])/i.test(name) ? 'SDH' : null;
  // Resolution is the next most useful distinguisher when the source type is
  // unknown - a bare "English 3" tells a viewer nothing about which to try.
  const res = /2160p|\b4k\b|uhd/i.test(name) ? '2160p'
            : /1080p/i.test(name) ? '1080p'
            : /720p/i.test(name) ? '720p' : null;
  const bits = [cut, src || res, hi].filter(Boolean);
  return bits.length
    ? `English (${bits.join(' · ')})`
    : (index === 0 ? 'English' : `English · alternate ${index}`);
}

/**
 * How likely a file is to stay in sync, from the metadata alone.
 *
 * The catalogue exposes `fpsMilli` and a release name but no timing. What it
 * does give indirectly is the runtime the file was cut for — measured on RRR,
 * whose English variants span 172 to 180 minutes against TMDB's 187. The
 * 172-minute file is a 25fps Hindi cut and drifts badly; the 24fps ones do
 * not. So framerate and release type are the signal we have before download.
 */
function reliability(s, runtimeMin) {
  const name = `${s.subtitleFileName || ''} ${s.movieReleaseName || ''}`.toLowerCase();
  let score = 0;

  // Song-only and trailer files are the main trap - Baahubali's first Telugu
  // entry was "Dhivara Full Video Song" at 60 cues against the real 829.
  if (/\b(song|lyric|trailer|teaser|sample|preview)\b/.test(name)) score -= 100;

  // 24fps is what modern digital masters use. A 25fps file is a PAL-era cut
  // and runs ~4% fast against a 24fps source: minutes of drift by the end.
  if (s.fpsMilli === 24000 || s.fpsMilli === 23976) score += 30;
  else if (s.fpsMilli === 25000) score -= 20;

  // A named release usually means a real rip rather than a fragment, and
  // Blu-ray/WEB-DL timings match the streams these providers serve.
  if (/blu-?ray|web-?dl|bdrip/.test(name)) score += 12;
  else if (/webrip|hdrip|amzn|nf\b/.test(name)) score += 8;
  if (s.movieReleaseName) score += 2;

  // A "3h05m12s" style runtime in the name can be checked against TMDB.
  const stamp = name.match(/(\d)h(\d{2})m/);
  if (stamp && runtimeMin) {
    const mins = Number(stamp[1]) * 60 + Number(stamp[2]);
    const drift = Math.abs(mins - runtimeMin);
    if (drift <= 3) score += 25;
    else if (drift > 10) score -= 15;
  }
  return score;
}

/**
 * English caption tracks for a title, best first.
 *
 * English only, by choice: the catalogue returns up to 30 languages and the
 * household reads English subtitles, so a long list of languages nobody
 * selects is noise. What matters instead is picking WHICH English file, since
 * they are cut for different releases and a mismatched one drifts.
 *
 * @param {number} [runtimeMin] the film's runtime, used to sanity-check timing
 */
export async function listSubtitles({ imdbId, season = 0, episode = 0,
                                      runtimeMin = 0, signal } = {}) {
  // An IMDb id is the ONLY thing tying these files to this film. A missing or
  // malformed one must never reach the catalogue: `/subtitles/movie/undefined`
  // is exactly how a viewer ends up reading another film's dialogue.
  if (!/^tt\d{6,}$/.test(String(imdbId || ''))) return [];
  const path = season && episode
    ? `series/${imdbId}:${season}:${episode}`
    : `movie/${imdbId}`;
  let data;
  try {
    const r = await fetch(`${BASE}/subtitles/${path}.json`, { signal });
    if (!r.ok) return [];
    data = await r.json();
  } catch { return []; }

  const eng = (data?.subtitles || [])
    // Drop what the listing already condemns, so the menu offers only files
    // that can plausibly play. Anything subtler is caught after download.
    .filter(s => s.url && ENGLISH.has(s.lang) && !isWrongCut(s))
    .map(s => ({ raw: s, score: reliability(s, runtimeMin) }))
    .sort((a, b) => b.score - a.score);

  // De-duplicate on the label so the menu never shows the same description
  // twice; the loser stays as a fallback for that entry.
  const out = [];
  eng.forEach(({ raw }, i) => {
    const label = variantLabel(raw, out.length);
    const existing = out.find(o => o.name === label);
    if (existing) { existing.alternates.push(raw.url); return; }
    out.push({
      // `id` identifies the VARIANT, not the language. Every entry here is
      // English, so keying on the language code made all of them collide:
      // duplicate React keys, and picking any row selected the first.
      id: `${raw.lang}:${out.length}`,
      lang: raw.lang, name: label, url: raw.url,
      release: raw.movieReleaseName || raw.subtitleFileName || null,
      alternates: [],
    });
  });
  return out.slice(0, 6);   // six is already more choice than anyone wants
}

/**
 * SRT -> WebVTT.
 *
 * `<track>` accepts only WebVTT, and the catalogue serves SRT. The differences
 * that matter: a WEBVTT header, and `,` millisecond separators become `.`.
 */
/**
 * Cues that advertise rather than translate.
 *
 * Some uploads open with an OpenSubtitles promo (measured on Baahubali's
 * Malayalam track), which would be the first thing on screen.
 */
const PROMO = /(opensubtitles|subscene|addic7ed|podnapisi|api\.opensubtitles|www\.osdb|advertise your product|subtitles? by|encoded by|resync(ed)? by|please rate this subtitle)/i;

export function stripPromoCues(vtt) {
  const [header, ...blocks] = vtt.split(/\n\n+/);
  const kept = blocks.filter(b => {
    // Only the text lines matter - a timestamp never contains a promo.
    const text = b.split('\n').filter(l => !/-->/.test(l) && !/^\d+$/.test(l)).join(' ');
    return !PROMO.test(text);
  });
  return [header, ...kept].join('\n\n');
}

/**
 * Undo one round of UTF-8-decoded-as-Windows-1252.
 *
 * The corruption is in the FILE, not in our fetch: measured across 40
 * OpenSubtitles tracks, 0 were invalid UTF-8 but 10 already contained mojibake
 * that whoever uploaded them baked in (including two English tracks - Jawan
 * eng showed `Whoâ€¦` where the line is `Who…`). Re-decoding the response
 * differently cannot help, because the bytes we receive are valid UTF-8 for
 * the wrong characters.
 *
 * `â€¦` is what `…` (E2 80 A6) looks like when those three bytes are read as
 * cp1252 and re-encoded. Mapping the string back through cp1252 and reading it
 * as UTF-8 reverses exactly that.
 *
 * Deliberately conservative:
 *  - Only runs when the signature sequence is present, so a clean file is
 *    never touched.
 *  - Any character outside cp1252 - a real accent, Telugu, an emoji - makes
 *    the round-trip throw, and we keep the original. A track that is already
 *    correct therefore cannot be corrupted by this.
 */
// Any char that cp1252 maps to a HIGH byte (0x80-0xFF). Mojibake is a run of
// these where the original text had one non-ascii character: `\u2026` (E2 80 A6)
// becomes U+00E2 U+20AC U+00A6, so the first char is E2 - NOT the U+00C2/U+00C3
// pair that only appears for two-byte sequences. Requiring C2/C3 missed the
// reported case entirely.
const MOJIBAKE = /[\u00c0-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122][\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/;

// The eight cp1252 positions that do not match their unicode code point.
// Without these, a repaired line loses its curly quotes and dashes.
const CP1252_TO_BYTE = new Map([
  ['\u20ac', 0x80], ['\u201a', 0x82], ['\u0192', 0x83], ['\u201e', 0x84],
  ['\u2026', 0x85], ['\u2020', 0x86], ['\u2021', 0x87], ['\u02c6', 0x88],
  ['\u2030', 0x89], ['\u0160', 0x8a], ['\u2039', 0x8b], ['\u0152', 0x8c],
  ['\u017d', 0x8e], ['\u2018', 0x91], ['\u2019', 0x92], ['\u201c', 0x93],
  ['\u201d', 0x94], ['\u2022', 0x95], ['\u2013', 0x96], ['\u2014', 0x97],
  ['\u02dc', 0x98], ['\u2122', 0x99], ['\u0161', 0x9a], ['\u203a', 0x9b],
  ['\u0153', 0x9c], ['\u017e', 0x9e], ['\u0178', 0x9f],
]);

export function fixMojibake(text) {
  if (!text || !looksMangled(text)) return text;
  // Per LINE, not per file. Strict decoding is what makes this safe - it
  // rejects text that was not produced by this mis-decode - but one stray byte
  // anywhere then vetoed the whole track: measured on a 176KB Jawan track,
  // a single invalid byte left all 91 corrupted lines untouched. Scoping the
  // round-trip to a line keeps the strictness and contains the damage.
  return text.split('\n').map(repairLine).join('\n');
}

// OpenSubtitles' utf8 re-encoder sometimes guesses Windows-1250 instead:
// the music note E2 99 AA comes back as U+00E2 U+2122 U+015E, and U+015E is
// not in cp1252. Reverse map built once; bytes 1250 leaves undefined are skipped.
const CP1250_TO_BYTE = (() => {
  const map = new Map();
  try {
    const dec = new TextDecoder('windows-1250', { fatal: true });
    for (let b = 0x80; b <= 0xff; b++) {
      try { map.set(dec.decode(new Uint8Array([b])), b); } catch { /* undefined in 1250 */ }
    }
  } catch { /* no windows-1250 decoder: cp1252 only */ }
  return map;
})();

function roundTrip(line, table) {
  const bytes = new Uint8Array([...line].map((ch) => {
    const code = table.get(ch) ?? ch.codePointAt(0);
    // Not representable in this code page, so the line was not produced by
    // the mis-decode we are undoing.
    if (code > 0xff) throw new Error('not in code page');
    // Latin-1 code points the code page maps elsewhere would round-trip wrong.
    if (code >= 0x80 && code <= 0xff && !table.has(ch) && table === CP1250_TO_BYTE) throw new Error('not cp1250');
    return code;
  }));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// The cp1250 shape of the same bug: a UTF-8 lead byte (C2-F4) followed by a
// continuation byte (80-BF), both read as cp1250. `\u015b` (C5 9B) becomes
// U+0139 U+203A, and U+0139 is outside MOJIBAKE's first class.
const MOJIBAKE_1250 = (() => {
  if (!CP1250_TO_BYTE.size) return null;
  const esc = ch => '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0');
  const lead = [], cont = [];
  for (const [ch, b] of CP1250_TO_BYTE) {
    if (b >= 0xc2 && b <= 0xf4) lead.push(esc(ch));
    if (b >= 0x80 && b <= 0xbf) cont.push(esc(ch));
  }
  return new RegExp(`[${lead.join('')}][${cont.join('')}]`);
})();

function looksMangled(s) {
  return MOJIBAKE.test(s) || (MOJIBAKE_1250 != null && MOJIBAKE_1250.test(s));
}

function repairLine(line) {
  if (!looksMangled(line)) return line;
  try { return roundTrip(line, CP1252_TO_BYTE); } catch { /* try cp1250 */ }
  if (!CP1250_TO_BYTE.size) return line;
  try { return roundTrip(line, CP1250_TO_BYTE); } catch {
    return line;                       // already correct, or not this bug
  }
}


export function srtToVtt(srt) {
  const body = String(srt)
    .replace(/^﻿/, '')                       // strip BOM
    .replace(/\r\n|\r/g, '\n')
    // 00:00:01,500 --> 00:00:03,000
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    // Cue numbers are optional in VTT and harmless, so they stay.
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/** Fetch a track and hand back a blob: url a <track> element can use. */
/**
 * The last cue's timestamp, in minutes — the runtime this file was cut for.
 *
 * This is the only certain reliability signal, and it is only available after
 * download. Measured on RRR: English variants end between 172 and 180 minutes
 * against TMDB's 187, and the 172-minute file drifts badly.
 */
export function trackSpanMin(vtt) {
  // The LATEST cue, not the last one written. Subtitle files are not reliably
  // ordered: measured on tt0330373 (Goblet of Fire), file 191411 ends with a
  // cue at 01:11 while its true final line is at 01:51, cue 274 of 412. Reading
  // the last entry measured 71 minutes instead of 111 and rejected a track that
  // was 40 minutes longer than we thought.
  let max = 0;
  for (const m of String(vtt).matchAll(/(\d{2,}):(\d{2}):(\d{2})[.,]\d{3}\s*-->/g)) {
    const mins = Number(m[1]) * 60 + Number(m[2]);
    if (mins > max) max = mins;
  }
  return max;
}

/**
 * Fetch a track and hand back a blob url a `<track>` can use.
 *
 * `runtimeMin` enables a post-download sanity check: a file whose cues stop
 * far short of the film was cut for a different release and will drift, so the
 * caller can try the next variant rather than showing captions that slide out
 * of sync halfway through.
 */
export async function loadTrack(url, { signal, offsetMs = 0, runtimeMin = 0 } = {}) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`subtitle fetch failed: ${r.status}`);
  // Repair before parsing, so cue text and any WEBVTT header are both fixed.
  const text = fixMojibake(await r.text());
  let vtt = /^WEBVTT/.test(text.trim()) ? text : srtToVtt(text);
  vtt = stripPromoCues(vtt);

  const cues = (vtt.match(/-->/g) || []).length;
  // A handful of cues is a song or trailer file, not a subtitle track.
  if (cues < 20) throw new Error(`subtitle has only ${cues} cues`);

  if (runtimeMin) {
    const span = trackSpanMin(vtt);
    // Credits and a trailing logo mean a track legitimately ends a few minutes
    // early; 12% short means it was timed for a different cut.
    if (span && span < runtimeMin * 0.88) {
      throw new Error(`subtitle spans ${span}min against a ${runtimeMin}min film`);
    }
  }

  if (offsetMs) vtt = shiftVtt(vtt, offsetMs);
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
}

/* ── Viewer preferences ────────────────────────────────────────────────────
   Caption size and timing offset are per-person and per-screen, so they are
   remembered rather than re-set every session. */
const PREF_KEY = 'chitram:subs:v1';

// Medium. Was 1 when the ladder was 0.62/1/1.3/1.6; after the ladder moved
// (2026-11-20) a default of 1 matched no preset, so no size button showed as
// chosen and the default sat between Medium and Large.
const DEFAULTS = { scale: 0.82, offsetMs: 0 };

// A choice saved on the old ladder keeps its NAME: Medium stays Medium.
const LEGACY_SCALE = { 0.62: 0.5, 1: 0.82, 1.3: 1.05, 1.6: 1.3 };

export function getSubPrefs() {
  try {
    const p = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
    if (LEGACY_SCALE[p.scale] != null) p.scale = LEGACY_SCALE[p.scale];
    return p;
  }
  catch { return { ...DEFAULTS }; }
}

export function setSubPrefs(next) {
  const merged = { ...getSubPrefs(), ...next };
  try { localStorage.setItem(PREF_KEY, JSON.stringify(merged)); } catch { /* private mode */ }
  return merged;
}

// Multipliers on the picture-relative base size (see .cue-text in globals.css).
//
// The low end is deliberately wider than the high end. Small was 0.8, which on
// a 390px phone picture put it 13.1px against Medium's 16.4px - a 3.3px step
// that read as "slightly medium" rather than small, which is what the viewer
// reported. 0.62 gives a step you can actually see (2026-11-21: still too big,
// now 0.5; a saved 0.62 maps to it), and the steps grow towards
// the top so each preset stays distinguishable from its neighbour.
export const SIZES = [
  { key: 0.5, label: 'Small' },
  { key: 0.82, label: 'Medium' },
  { key: 1.05, label: 'Large' },
  { key: 1.3, label: 'Extra large' },
];

/**
 * Shift every cue by `ms`.
 *
 * Subtitle files are timed against a particular release, and providers serve
 * a different cut often enough that a fixed track drifts. Re-timing the cues
 * is the only reliable fix: `<track>` exposes no offset, and adjusting
 * `startTime` on live cues is not honoured consistently across browsers.
 */
export function shiftVtt(vtt, ms) {
  if (!ms) return vtt;
  const shift = (t) => {
    const [h, m, rest] = t.split(':');
    const [sec, msec] = rest.split('.');
    let total = (+h * 3600 + +m * 60 + +sec) * 1000 + +msec + ms;
    if (total < 0) total = 0;
    const hh = Math.floor(total / 3600000);
    const mm = Math.floor((total % 3600000) / 60000);
    const ss = Math.floor((total % 60000) / 1000);
    const mss = total % 1000;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:` +
           `${String(ss).padStart(2, '0')}.${String(mss).padStart(3, '0')}`;
  };
  return vtt.replace(/(\d{2}:\d{2}:\d{2}\.\d{3})/g, (m0) => shift(m0));
}
