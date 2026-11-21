import { languageName } from '../subtitles';

// mul (several) and zxx (no speech) name no language: the APK and server hide them too.
export const isKnownAudioLanguage = value => Boolean(value && !/^(?:track|audio|default|unknown|und|original|mul|zxx)(?:\s*[-#]?\s*\d+)?$/i.test(String(value).trim()));

// One region rule with the server (streamSchema canonicalLanguage) and the APK
// (Ranking.languageLabel): '_' is '-', and only a 2-letter, 4-letter or 3-digit
// subtag strips (te_IN, zh-Hant, es-419). A compound such as tel-hin keeps both
// parts rather than becoming Telugu and dropping Hindi.
const REGION_SUBTAG = /^(?:[a-z]{2}|[a-z]{4}|\d{3})$/i;
function codeLanguageName(value) {
  const tag = String(value ?? '').trim().replace(/_/g, '-');
  if (!tag) return '';
  const parts = tag.split('-');
  if (parts.length > 2 || (parts.length === 2 && !REGION_SUBTAG.test(parts[1]))) return tag.toUpperCase();
  return languageName(tag);
}

export const audioLanguageKey = value => String(codeLanguageName(value) || value || '').trim().toLowerCase();

let knownNames = null;
/** Lower-case display name -> display name, for every language languageName knows. */
function knownLanguageNames() {
  if (knownNames) return knownNames;
  knownNames = new Map();
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const a of letters) for (const b of letters) {
    for (const code of [a + b, ...[...letters].map(c => a + b + c)]) {
      const name = languageName(code);
      if (name && name !== code.toUpperCase()) knownNames.set(name.toLowerCase(), name);
    }
  }
  return knownNames;
}

const CODE_TAG = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i;
export const displayLanguage = value => {
  const tag = String(value).replace(/_/g, '-');
  return CODE_TAG.test(tag) ? codeLanguageName(tag) || value : value;
};

/** True when value names a language languageName knows (Telugu, te, TEL). */
export const isResolvedLanguage = value => Boolean(value) && knownLanguageNames().has(String(displayLanguage(value)).toLowerCase());

// Codec, channel and caption words that collide with ISO codes: 'HE-AAC' is not
// Hebrew, '2CH' is not Chamorro.
const CODE_STOPLIST = new Set(['HE', 'LC', 'AAC', 'AC', 'EAC', 'DD', 'DDP', 'DTS', 'ATMOS', 'CH', 'SD', 'HD', 'SDH',
  'DV', 'PCM', 'HI', 'AD', 'VO', 'ORI', 'LAT', 'ALT', 'BR', 'IN', 'MA']);

/**
 * Language named in a track label: 'Telugu 5.1', 'TEL - Stereo', 'HE-AAC Telugu'.
 * Strips a leading [n] index. Pass 1: a full language name anywhere (any case) wins.
 * Pass 2: an ALL-CAPS 2-3 letter code (TEL, TE), skipping codec/channel words.
 * Lowercase short words such as 'per' or 'it' never count. When nothing resolves,
 * the whole cleaned label is kept.
 */
export function languageFromTrackName(name) {
  const cleaned = String(name || '').replace(/^\[\d+\]\s*/, '').trim();
  const tokens = cleaned.match(/[A-Za-z]+/g) || [];
  for (const token of tokens) {
    const named = knownLanguageNames().get(token.toLowerCase());
    if (named) return named;
  }
  for (const token of tokens) {
    if (token.length > 3 || token !== token.toUpperCase() || CODE_STOPLIST.has(token)) continue;
    const coded = languageName(token);
    if (coded && coded !== token.toUpperCase()) return coded;
  }
  return isKnownAudioLanguage(cleaned) ? cleaned : null;
}

// Words a label may carry beside its language and still name only that
// language: codec, channel and track words. Not BR, LAT or IN: those qualify
// the language (Portuguese BR, Spanish LAT). Same list as server streamSchema.js
// and APK Ranking.kt TRACK_WORDS.
const TRACK_WORDS = new Set(['he', 'lc', 'aac', 'ac', 'eac', 'dd', 'ddp', 'dts', 'atmos', 'ch', 'sd', 'hd', 'sdh',
  'dv', 'pcm', 'hi', 'ad', 'vo', 'ori', 'alt', 'ma', 'e', 'stereo', 'mono', 'surround', 'audio', 'track',
  'dolby', 'digital', 'plus', 'original', 'main', 'default', 'kbps']);

/**
 * The ONE language a label names ('Telugu 5.1', 'Hindi AAC 2.0', 'TEL'), or null.
 * Strict form of languageFromTrackName, same as the server's and the APK's
 * trackNameLanguage: a word is a language when it is a full name in any case, or
 * an ALL-CAPS 2-3 letter code not in the stoplist. Null when the label names two
 * languages or carries any other word ('Portuguese (Brazil)'), so nothing is lost.
 */
export function trackNameLanguage(name) {
  const cleaned = String(name || '').replace(/^\[\d+\]\s*/, '').trim();
  const found = new Set();
  for (const token of cleaned.match(/[A-Za-z]+/g) || []) {
    const lower = token.toLowerCase();
    let lang = knownLanguageNames().get(lower);
    if (!lang && token.length >= 2 && token.length <= 3 && token === token.toUpperCase() && !CODE_STOPLIST.has(token)) {
      const coded = languageName(token);
      if (coded && knownLanguageNames().has(coded.toLowerCase())) lang = coded;
    }
    if (lang) found.add(lang);
    else if (!TRACK_WORDS.has(lower)) return null;
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Final-review I1 (2026-11-21): providers copy an und rendition's NAME into the
 * tag ('Telugu 5.1'). A tag that is not a real language is read as a name, then
 * the name is; only when neither names one does the raw tag stand, as before.
 */
function tagOrNameLanguage(tag, name) {
  if (isResolvedLanguage(tag)) return String(displayLanguage(tag));
  return (isKnownAudioLanguage(tag) ? trackNameLanguage(tag) : null) ?? trackNameLanguage(name);
}

export function trackAudioLanguage(track) {
  const language = track?.lang || track?.language;
  if (isKnownAudioLanguage(language) && !isResolvedLanguage(language)) {
    const named = tagOrNameLanguage(language, track?.name);
    if (named) return named;
  }
  if (isKnownAudioLanguage(language)) return languageName(language) || language;
  return languageFromTrackName(track?.name);
}

/** Language of one audio[] entry: its tag first, then the tag and name read as labels (I1). */
function renditionLanguage(entry) {
  const tag = entry?.language || entry?.lang;
  const named = tagOrNameLanguage(tag, entry?.name);
  if (named) return named;
  if (isKnownAudioLanguage(tag)) return String(displayLanguage(tag));
  return languageFromTrackName(entry?.name);
}

/** In-stream renditions with a known language, so a pick can name the exact track. */
export function sourceAudioRenditions(source) {
  if (!Array.isArray(source?.audio)) return [];
  const out = [];
  for (const entry of source.audio) {
    const language = renditionLanguage(entry);
    const key = language && audioLanguageKey(language);
    if (!key) continue;
    out.push({ language, key, uri: entry?.uri ?? null, name: entry?.name ?? null, default: Boolean(entry?.default) });
  }
  return out;
}

/**
 * The stream list's languages[] as a floor under renditions. When at least one
 * rendition names a real language, the renditions are the truth and languages[]
 * adds nothing (NetMirror's post.php names languages the master lacks). When none
 * does (all und, unnamed or 'Director Commentary'), every resolvable languages[]
 * entry not yet covered is added, so Telugu is never hidden behind a commentary.
 */
export function withLanguageFloor(renditionLanguages = [], languages = []) {
  if (renditionLanguages.some(isResolvedLanguage)) return [...renditionLanguages];
  const out = [...renditionLanguages];
  const keys = new Set(out.map(audioLanguageKey));
  for (const language of languages || []) {
    const key = audioLanguageKey(language);
    if (!isResolvedLanguage(language) || keys.has(key)) continue;
    keys.add(key);
    out.push(language);
  }
  return out;
}

/**
 * The ONE language of a single-language source (selectableAudio false): the first
 * rendition that names a real language; else the first real languages[] entry;
 * else the first raw entry, as before. Decided on the full rendition list.
 */
export function singleAudioLanguage(renditionLanguages = [], languages = []) {
  const pick = renditionLanguages.find(isResolvedLanguage) ?? (languages || []).find(isResolvedLanguage)
    ?? (renditionLanguages.length ? renditionLanguages : languages || [])[0];
  return pick == null ? [] : [pick];
}

/** Playable audio evidence, never catalog availability alone. */
export function sourceAudioLanguages(source) {
  const languages = source?.languages || [];
  const hasAudio = Array.isArray(source?.audio) && source.audio.length > 0;
  const real = Array.isArray(source?.audioLanguages) ? source.audioLanguages
    : Array.isArray(source?.audio) ? sourceAudioRenditions(source).map(r => r.language) : null;
  // An explicitly empty audio[] still means "no audio choice"; entries that resolve
  // to nothing fall back to the languages[] floor.
  const raw = source?.selectableAudio
    ? (real == null ? languages : hasAudio ? withLanguageFloor(real, languages) : real)
    : singleAudioLanguage(real || [], languages);
  const found = new Map();
  for (const value of raw) {
    // A languages[] entry such as 'Telugu 5.1' (a name copied into a tag, I1).
    const name = isKnownAudioLanguage(value) && !isResolvedLanguage(value)
      ? trackNameLanguage(value) ?? displayLanguage(value) : displayLanguage(value);
    if (isKnownAudioLanguage(name) && audioLanguageKey(name)) found.set(audioLanguageKey(name), String(name));
  }
  return [...found.values()];
}

/**
 * Both directions are rebuilt from cumulative results, including failed/retryable rows.
 * byLanguage entries carry renditions: sourceId -> in-stream rendition, or null when
 * the source only lists the language for the whole stream.
 */
export function languageSourceIndex(sources = []) {
  const byLanguage = new Map(), bySource = new Map();
  for (const source of sources) {
    if (!source?.id) continue;
    const languages = sourceAudioLanguages(source);
    const renditions = sourceAudioRenditions(source);
    bySource.set(source.id, languages);
    for (const language of languages) {
      const key = audioLanguageKey(language);
      if (!byLanguage.has(key)) byLanguage.set(key, { language, sources: [], renditions: new Map() });
      const entry = byLanguage.get(key);
      if (!entry.sources.some(s => s.id === source.id)) entry.sources.push(source);
      if (!entry.renditions.get(source.id)) entry.renditions.set(source.id, renditions.find(r => r.key === key) || null);
    }
  }
  return { byLanguage, bySource };
}
export function languageCandidates(sources, language) {
  return languageSourceIndex(sources).byLanguage.get(audioLanguageKey(language))?.sources || [];
}

/**
 * Servers a language pick may switch to: never the playing source. Its own
 * tracks were already tried as a rendition switch; switching to it again is a
 * silent no-op (switchSource returns on the same row), so the pick looked dead.
 */
export function languageSwitchCandidates(sources, language, currentId) {
  return languageCandidates(sources, language).filter(s => !s.unsupported && (currentId == null || s.id !== currentId));
}
