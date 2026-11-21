/**
 * "Add <L> audio from another server": the player side of one journey (Step 2,
 * Task 4). lib/player/addAudio.js owns the donor run (caps, budget, no repeat
 * donor); this owns what the player does around it:
 *   - one AbortController per run; cancel() on unmount, title/episode change,
 *     a plain pick, or a tap on ANOTHER add-audio entry;
 *   - a second tap on the SAME entry joins the run and only repeats the
 *     "Checking ..." notice;
 *   - a server 200 switches the picture (applyPair); a device that then fails
 *     to play it (fatal error, or no frame within tryMs) continues the run;
 *   - a spent run puts back the snapshot taken at the run's first switch, so
 *     stream, position, audio and wanted language are unchanged.
 * Pure of React so it can be tested without mounting Player.jsx.
 */
import { addAudioOffers, createAddAudioRun } from '../../lib/player/addAudio';
import { videoIdOf } from '../../lib/player/trackChoices';
import { ADD_AUDIO_TRY_MS, Copy } from '../../lib/player/loadingModel';

/**
 * The languages the menus offer as "Add <L> audio": one per language another
 * server lends and the playing stream lacks, Telugu first. During a pair the
 * playing id is `pair-<video>-<audio>`, no row: the video half stands in, and
 * `playingLanguages` (the pair's donor languages) is what it carries when the
 * native path has no audioTracks.
 */
export function addAudioLanguages({ sources = [], currentSourceId, audioTracks = [], playingLanguages = null }) {
  const id = videoIdOf(currentSourceId, sources);
  const playing = sources.find(s => s.id === id);
  if (!playing) return [];
  const tracks = audioTracks?.length ? audioTracks
    : (playingLanguages?.length ? playingLanguages.map(language => ({ language })) : []);
  return addAudioOffers(sources, playing, tracks).map(o => o.language);
}

/** The stream that plays a server pair answer: `video` picture, donor audio. */
export function pairedStream(video, donor, paired) {
  return {
    ...video,
    id: `pair-${video.id}-${donor.id}`,
    provider: `${video.provider}+${donor.provider}`,
    masterUrl: paired.url,
    hybrid: true,
    languages: donor.languages || [],
    selectableAudio: true,
  };
}

/**
 * One donor try: the server pair call (with the language), then the browser
 * decode check. Any non-ok answer (null, a 409 'not pairable', a throw) or an
 * undecodable pair is a failed try (null).
 */
export function makeCheckPair({ pairSources, pairDecodable, tmdbId, mediaType }) {
  return async (video, donor, language, signal) => {
    const paired = await pairSources(video, donor, { tmdbId, mediaType, language, signal });
    if (!paired?.url) return null;
    if (pairDecodable(paired.codecs) === false) return null;
    return paired;
  };
}

/**
 * Where a pair should start. The live position only when the element has
 * metadata (readyState >= 1) and is past 0; otherwise the run's own position.
 * After a restore the restored stream may still be loading and read 0 (RI1).
 */
export function resumePoint(video, fallback) {
  const t = video?.currentTime;
  if (video && video.readyState >= 1 && t > 0) return t;
  // No run position (a menu pair pick): the element's own value, as before.
  return fallback ?? (t || 0);
}

/** One stream's identity: the row id and the url that plays. */
export const streamKey = (src) => `${src?.id ?? ''}|${src?.masterUrl ?? ''}`;

/**
 * deps: {
 *   checkPair(video, donor, language, signal) -> Promise<paired|null>
 *   applyPair(video, donor, language, paired, at)  switch to the pair; `at`
 *                                               is the run's resume position
 *   snapshot() -> { key, at, ... } | null       what is on screen now
 *   position?() -> seconds                      playback position at the tap
 *   restore(snap)                               put that back
 *   notice(text)
 *   label?(donor) -> string                     server name in the notices
 *   setTimer?, clearTimer?, now?, tryMs?
 * }
 * The player calls streamChanged(streamKey(playing)) on EVERY stream change
 * and landed(key) on each loadeddata. The run knows the key it expects (the
 * stream it started on, its own pair, or its own restore); any other change
 * is not the run's and cancels it (I1, fix round 1).
 */
export function createAddAudioJourney(deps) {
  const {
    label = d => d?.provider || 'another server',
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = t => clearTimeout(t),
    now = Date.now,
    tryMs = ADD_AUDIO_TRY_MS,
  } = deps;
  let current = null;
  let playingKey = null;

  const checking = (s) => Copy.checkingAudio(s.language, s.lastTry?.server || 'servers',
    s.lastTry?.n || 1, s.lastTry?.total || s.run.next(now())?.total || 1);

  function stopWatch(s) {
    if (s.watch != null) clearTimer(s.watch);
    s.watch = null;
  }

  async function step(s) {
    const out = await s.run.attempt({
      tryOne: (donor, signal) => deps.checkPair(s.video, donor, s.language, signal),
      onTry: (donor, n, total) => {
        if (s !== current) return;
        s.lastTry = { server: label(donor), n, total };
        deps.notice(checking(s));
      },
      signal: s.controller.signal,
      now,
      tryMs,
    });
    if (s !== current || out.cancelled) return { cancelled: true };
    if (out.donor) {
      // Snapshot once, at the run's first switch. A device failure restores
      // it at once, so every later switch also starts from it.
      if (!s.snap) s.snap = deps.snapshot();
      const key = streamKey(pairedStream(s.video, out.donor, out.result));
      s.pending = { donor: out.donor, key };
      s.expect = key;
      deps.applyPair(s.video, out.donor, s.language, out.result, s.at);
      // No frame within the try time counts as a device failure.
      s.watch = setTimer(() => { s.watch = null; deviceFailed(); }, tryMs);
      return out;
    }
    // Spent. Any failed pair was already put back the moment it failed.
    current = null;
    deps.notice(Copy.noWorkingAudio(s.language));
    return out;
  }

  function stop() {
    const s = current;
    if (!s) return null;
    current = null;
    stopWatch(s);
    s.controller.abort();
    return s;
  }

  /** End the run; nothing late applies after this. */
  function cancel() { stop(); }

  /**
   * While a pair is on screen but has not landed, the stream from before the
   * run (snap), so a plain pick that fails goes back there, not to the pair.
   */
  function unsettled() {
    return current?.pending && current.snap ? current.snap : null;
  }

  /** The viewer tapped "Add <language> audio". */
  function start({ language, video, donors }) {
    if (current && current.language === language) {
      deps.notice(checking(current));
      return current.promise || Promise.resolve({ joined: true });
    }
    // Another entry: the old run stops. If its pair is still on screen, its
    // snapshot is still the stream the viewer was on, so the new run keeps it.
    const prev = stop();
    const carry = prev?.pending ? prev.snap : null;
    const s = {
      language, video,
      run: createAddAudioRun({ language, donors, startedAt: now() }),
      controller: new AbortController(),
      snap: carry,
      expect: prev?.pending ? prev.expect : playingKey,
      // The run's resume position: set at the tap, moved to the snapshot's
      // on a restore. A carried-over unsettled pair keeps the pre-run one.
      at: prev?.pending ? prev.at : (deps.position?.() ?? 0),
      pending: null, watch: null, lastTry: null, promise: null,
    };
    current = s;
    s.promise = step(s);
    return s.promise;
  }

  /**
   * The device failed to play the pair just applied. Ruling (APK parity):
   * put the previous stream back AT ONCE so playback goes on, keep checking
   * in the background, and switch again only when a later donor lands.
   * True when handled.
   */
  function deviceFailed() {
    const s = current;
    if (!s?.pending) return false;
    stopWatch(s);
    s.pending = null;
    if (s.snap) {
      s.expect = s.snap.key;
      if (s.snap.at != null) s.at = s.snap.at;
      deps.restore(s.snap);
    }
    deps.notice(checking(s));
    s.promise = step(s);
    return true;
  }

  /** The player's stream changed. Not the run's own change: the run ends. */
  function streamChanged(key) {
    playingKey = key;
    if (current && key !== current.expect) stop();
  }

  /** loadeddata of the stream `key`. Only the run's own pair ends it as added. */
  function landed(key) {
    const s = current;
    if (!s?.pending || key !== s.pending.key) return false;
    stopWatch(s);
    current = null;
    deps.notice(Copy.audioAdded(s.language, label(s.pending.donor)));
    return true;
  }

  return {
    start, cancel, deviceFailed, landed, streamChanged, unsettled,
    running: () => current != null,
    language: () => current?.language || null,
  };
}
