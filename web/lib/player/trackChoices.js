/**
 * Video and audio as two INDEPENDENT choices.
 *
 * The player used to hand the viewer one fused row per combination - a
 * "showsst+CastleTV" entry sitting above the plain streams - so picking a
 * picture and picking a language were the same act, and every extra language
 * doubled the length of the source list. Two lists is the same information
 * with none of the multiplication: V video sources and A audio sources are
 * V+A rows, not V*A.
 *
 * WHAT COUNTS AS EACH
 *
 *   VIDEO  every source, ranked by resolution. Even an audio-only-ish stream
 *          carries a picture, so nothing is excluded here.
 *
 *   AUDIO  one entry per LANGUAGE, gathered from wherever it exists:
 *            - renditions inside the chosen video source  (switch in place)
 *            - renditions inside some OTHER source        (needs pairing)
 *            - a whole source that is single-language     (needs pairing)
 *
 * WHY A PAIR IS NOT ALWAYS POSSIBLE
 *
 * Measured 2026-09-22: on Devara, Castle ships ONE file with 4 tracks inside,
 * so its Telugu can be lifted onto showsst's 1080p picture. On Salaar, Castle
 * ships each language as its own muxed 720p file - there is no separate track
 * to lift, so choosing Telugu there means playing Castle's own picture too.
 *
 * That is a real property of the catalogue, not a bug, and the UI must show it
 * rather than offer a combination that cannot be built. `pairingFor` returns
 * how a given pair would play so the caller can say so plainly.
 */

/** Pixel height of a source's best level, for ranking. 0 when unknown. */
export function heightOf(s) {
  const fromLevels = (s?.levels || [])
    .map((l) => Number(l?.height) || 0)
    .reduce((m, h) => (h > m ? h : m), 0);
  if (fromLevels) return fromLevels;
  const m = String(s?.quality || '').match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}

/** Every source as a video choice, best picture first. */
export function videoChoices(sources = []) {
  return [...sources]
    .filter((s) => s && s.masterUrl)
    .sort((a, b) => {
      // A progressive file has no ladder and no ABR, so it loses to an HLS
      // source of the same height.
      const p = (a.progressive ? 1 : 0) - (b.progressive ? 1 : 0);
      if (p !== 0) return p;
      return heightOf(b) - heightOf(a);
    })
    .map((s) => ({
      id: s.id,
      label: s.provider,
      quality: s.quality,
      height: heightOf(s),
      source: s,
    }));
}

/**
 * Every distinct audio language, and where each one comes from.
 *
 * A language available INSIDE the chosen video source is always preferred over
 * the same language living in another source: switching an in-file rendition
 * keeps the playback position and needs no pairing at all.
 */
export function audioChoices(sources = [], videoSourceId = null, inFileTracks = []) {
  const out = [];
  const seen = new Set();

  // 1. Tracks already inside the chosen picture - the cheapest kind.
  for (const t of inFileTracks || []) {
    const name = String(t?.name || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: `track:${t.id}`, language: name, kind: 'in-file', trackId: t.id });
  }

  // 2. Languages carried by some other source.
  for (const s of sources) {
    if (!s || s.id === videoSourceId) continue;
    const langs = Array.isArray(s.languages) ? s.languages.filter(Boolean) : [];
    // A multi-language source with real renditions can give up any ONE of its
    // languages. A single-language source gives up only its own.
    const offered = s.selectableAudio ? langs : langs.slice(0, 1);
    for (const lang of offered) {
      const key = String(lang).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `src:${s.id}:${lang}`,
        language: String(lang),
        kind: s.selectableAudio ? 'pairable' : 'whole-source',
        sourceId: s.id,
        source: s,
      });
    }
  }

  return out;
}

/**
 * How the chosen (video, audio) pair would actually play.
 *
 * 'in-file'    - one stream, switch the rendition. Instant, keeps position.
 * 'pair'       - two providers muxed by the backend. Keeps the chosen picture.
 * 'substitute' - the audio only exists welded into its own file, so playing it
 *                REPLACES the picture. The caller should say so before doing it.
 */
export function pairingFor(videoChoice, audioChoice) {
  if (!audioChoice) return { mode: 'in-file', video: videoChoice, note: null };
  if (audioChoice.kind === 'in-file') {
    return { mode: 'in-file', video: videoChoice, trackId: audioChoice.trackId, note: null };
  }
  if (audioChoice.kind === 'pairable') {
    return {
      mode: 'pair', video: videoChoice, audio: audioChoice, note: null,
    };
  }
  // whole-source: the language is muxed into its own file.
  const from = heightOf(videoChoice?.source);
  const to = heightOf(audioChoice.source);
  return {
    mode: 'substitute',
    video: { ...audioChoice, source: audioChoice.source },
    audio: audioChoice,
    note: to && from && to < from
      ? `${audioChoice.language} is only available at ${audioChoice.source.quality}`
      : null,
  };
}
