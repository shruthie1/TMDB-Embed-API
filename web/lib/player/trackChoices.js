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
      // A row this browser cannot decode goes to the bottom of the menu.
      const u = (a.unsupported ? 1 : 0) - (b.unsupported ? 1 : 0);
      if (u !== 0) return u;
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
      unsupported: Boolean(s.unsupported),
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

/**
 * Which VIDEO row is on screen, given the id useResolve reports.
 *
 * A pairing plays under a synthetic id, `pair-<video id>-<audio id>` (plus
 * `-n<offset>` after a timing nudge; see Player.jsx pickPair). That id is not
 * any row, so comparing it to row ids ticked nothing and the Servers button
 * fell back to the FIRST row's name. Measured 2026-11-16 on movie/811941 with
 * Telugu standing: picking OneTouchTV pairs it with CastleTV's Telugu (POST
 * /hybrid/pair answered 200), so the picture really was OneTouchTV while the
 * menu showed no tick and the button read "CastleTV".
 *
 * The picture of a pair is its video half, so that is the row to mark. Ids
 * contain dashes ("CastleTV-0"), so the prefix is matched against the known
 * ids rather than split, longest first so "CastleTV-1" never claims
 * "pair-CastleTV-10-...".
 */
export function videoIdOf(currentSourceId, sources = []) {
  if (currentSourceId == null) return null;
  const list = (sources || []).filter((s) => s && s.id != null);
  if (list.some((s) => s.id === currentSourceId)) return currentSourceId;
  const id = String(currentSourceId);
  if (!id.startsWith('pair-')) return null;
  let best = null;
  for (const s of list) {
    const sid = String(s.id);
    if (id.startsWith(`pair-${sid}-`) && (best == null || sid.length > String(best).length)) {
      best = s.id;
    }
  }
  return best;
}

/**
 * One display label per video row, numbering a provider that appears twice.
 *
 * Shared by the rows and the Servers button so the button names the exact
 * row that is ticked ("CastleTV 2"), not just the provider. Numbered once
 * across the whole list, never per quality group: per-group numbering showed
 * "CastleTV 1" twice on movie/912649 (2026-09-22).
 */
export function videoLabels(choices = []) {
  const nameOf = (c) => c?.label || c?.provider || 'Server';
  const total = new Map();
  for (const c of choices) total.set(nameOf(c), (total.get(nameOf(c)) || 0) + 1);
  const shown = new Map();
  return choices.map((c) => {
    const name = nameOf(c);
    if ((total.get(name) || 0) < 2) return name;
    const n = (shown.get(name) || 0) + 1;
    shown.set(name, n);
    return `${name} ${n}`;
  });
}
