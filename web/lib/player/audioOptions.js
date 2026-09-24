/**
 * One audio-language list, however the provider happens to ship the languages.
 *
 * Providers express "this film has five languages" in two completely different
 * ways, and the viewer should not have to know or care which one they got:
 *
 *   MUXED   one master carrying several tracks (CastleTV demux, NetMirror).
 *           Switching is an hls.js audioTrack change - instant, keeps position.
 *           Measured on 811941 (Devara): 4 tracks in one file.
 *
 *   PER-FILE one stream PER language, as separate sources. Switching means
 *           loading a different url. Measured on 770906 (Salaar): 13 streams
 *           that are really 6 languages x 2 qualities.
 *
 * Before this, only the muxed case reached the Audio button. On Salaar the
 * button showed a single dead entry reading "Telugu" while the other five
 * languages sat unlabelled in the Source list - the viewer had to open Source
 * and decode 13 near-identical rows to hear Hindi. Same film, same catalogue,
 * completely different experience, for a reason that is pure plumbing.
 */

/** Language of a source, when it carries exactly one. */
function soleLanguage(source) {
  const langs = Array.isArray(source?.languages) ? source.languages.filter(Boolean) : [];
  return langs.length === 1 ? String(langs[0]) : null;
}

/**
 * Build the audio menu.
 *
 * @param {object[]} audioTracks  in-file tracks from hls.js, if any
 * @param {string|number} currentAudio  active in-file track id
 * @param {object[]} sources  every source for this title
 * @param {string} currentSourceId  the source playing now
 * @returns {{options: object[], current: any, kind: 'muxed'|'sources'|'none'}}
 *   `options` are {id, name, kind}. A 'muxed' id is an hls.js track id; a
 *   'sources' id is a source id. `kind` tells the caller which handler to use.
 */
export function audioOptions({
  audioTracks = [], currentAudio, sources = [], currentSourceId = null,
} = {}) {
  // A real multi-track file always wins: switching inside one file keeps the
  // playback position, so it is strictly the better experience.
  if (Array.isArray(audioTracks) && audioTracks.length > 1) {
    return {
      kind: 'muxed',
      current: currentAudio,
      options: audioTracks.map((t) => ({ id: t.id, name: t.name, kind: 'muxed' })),
    };
  }

  // Otherwise look for sibling sources that each carry one language. Only
  // single-language sources are offered: a source listing three languages
  // cannot be presented as a choice of one.
  const byLang = new Map();
  for (const s of sources) {
    const lang = soleLanguage(s);
    if (!lang) continue;
    const seen = byLang.get(lang);
    // Several qualities of the same language collapse to one entry. Keep the
    // one already playing if it is among them, so opening the menu never
    // silently reassigns which file "Telugu" means; otherwise keep the first,
    // which is the ranked-best (rankSources already sorted by quality).
    if (!seen) { byLang.set(lang, s); continue; }
    if (s.id === currentSourceId) byLang.set(lang, s);
  }

  if (byLang.size > 1) {
    const current = sources.find((s) => s.id === currentSourceId);
    const currentLang = soleLanguage(current);
    return {
      kind: 'sources',
      current: currentLang ? byLang.get(currentLang)?.id ?? null : null,
      options: [...byLang.entries()].map(([name, s]) => ({ id: s.id, name, kind: 'sources' })),
    };
  }

  // Nothing to choose between. Fall back to whatever single track exists so
  // the button still reports what is playing - "this stream is Hindi" is real
  // information, and hiding the control made "no menu" ambiguous between
  // "one language" and "the player is broken".
  if (audioTracks.length === 1) {
    return {
      kind: 'muxed',
      current: currentAudio,
      options: [{ id: audioTracks[0].id, name: audioTracks[0].name, kind: 'muxed' }],
    };
  }
  const lang = soleLanguage(sources.find((s) => s.id === currentSourceId));
  if (lang) {
    return { kind: 'sources', current: currentSourceId, options: [{ id: currentSourceId, name: lang, kind: 'sources' }] };
  }
  return { kind: 'none', current: null, options: [] };
}
