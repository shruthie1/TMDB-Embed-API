import { languageName } from '../subtitles';

export const isKnownAudioLanguage = value => Boolean(value && !/^(?:track|audio|default|unknown|und|original)(?:\s*[-#]?\s*\d+)?$/i.test(String(value).trim()));

export const audioLanguageKey = value => String(languageName(value) || value || '').trim().toLowerCase();

export function trackAudioLanguage(track) {
  const language = track?.lang || track?.language;
  if (isKnownAudioLanguage(language)) return languageName(language) || language;
  const name = String(track?.name || '').replace(/^\[\d+\]\s*/, '');
  return isKnownAudioLanguage(name) ? name : null;
}

/** Playable audio evidence, never catalog availability alone. */
export function sourceAudioLanguages(source) {
  const real = Array.isArray(source?.audioLanguages) ? source.audioLanguages
    : Array.isArray(source?.audio) ? source.audio.map(a => a?.language).filter(Boolean) : null;
  const raw = source?.selectableAudio ? (real ?? source.languages ?? [])
    : (real?.length ? real : source?.languages || []).slice(0, 1);
  const found = new Map();
  for (const value of raw) {
    const name = /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(String(value)) ? languageName(value) || value : value;
    if (isKnownAudioLanguage(name) && audioLanguageKey(name)) found.set(audioLanguageKey(name), String(name));
  }
  return [...found.values()];
}

/** Both directions are rebuilt from cumulative results, including failed/retryable rows. */
export function languageSourceIndex(sources = []) {
  const byLanguage = new Map(), bySource = new Map();
  for (const source of sources) {
    if (!source?.id) continue;
    const languages = sourceAudioLanguages(source);
    bySource.set(source.id, languages);
    for (const language of languages) {
      const key = audioLanguageKey(language);
      if (!byLanguage.has(key)) byLanguage.set(key, { language, sources: [] });
      const rows = byLanguage.get(key).sources;
      if (!rows.some(s => s.id === source.id)) rows.push(source);
    }
  }
  return { byLanguage, bySource };
}
export function languageCandidates(sources, language) {
  return languageSourceIndex(sources).byLanguage.get(audioLanguageKey(language))?.sources || [];
}
