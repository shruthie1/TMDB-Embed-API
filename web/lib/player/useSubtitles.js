'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listSubtitles, loadTrack, getSubPrefs, setSubPrefs } from '../subtitles';
import { abortReason } from '../abortReason';

/**
 * Owns caption state: the available tracks, the chosen one, its blob url and
 * the viewer's size/timing preferences.
 *
 * Captions are an enhancement, never a dependency - the fetch is independent
 * of playback and a failure is silent, because a missing subtitle is not a
 * broken video.
 */
/**
 * Turn a list of per-candidate failures into one sentence a viewer can act on.
 *
 * Mistiming is the common case and the only one where the file was real and
 * the fault is upstream, so it gets named specifically; everything else falls
 * back to a plain statement rather than leaking an internal message.
 */
export function describeFailures(failures = [], tried = 0) {
  if (!failures.length) return 'That subtitle could not be loaded.';
  const mistimed = failures.filter(f => /spans \d+min/.test(String(f))).length;
  // `tried` counts the files behind ONE menu entry - its url plus alternates -
  // never the whole sheet. Saying "all N subtitles for this film" claimed a
  // scope this function does not have: the viewer saw six entries listed and a
  // message about three, which reads as a bug in the count. Describe the entry
  // that failed, and point at the others that are still worth trying.
  if (mistimed === failures.length) {
    return tried > 1
      ? `This subtitle is timed for a different cut (${tried} files tried). Try another.`
      : 'This subtitle is timed for a different cut. Try another.';
  }
  if (mistimed > 0) {
    return `Timing looks wrong on ${mistimed} of ${tried} files. Try another subtitle.`;
  }
  if (failures.every(f => /only \d+ cues/.test(String(f)))) {
    return 'The subtitles found are songs or trailers, not dialogue.';
  }
  return tried > 1 ? 'No usable subtitle for this release.'
                   : 'That subtitle could not be loaded.';
}

export function useSubtitles({ imdbId, season = 0, episode = 0, runtimeMin = 0, onError }) {
  const [subs, setSubs] = useState([]);
  const [currentSub, setCurrentSub] = useState(null);   // variant id | null = off
  const [subUrl, setSubUrl] = useState(null);           // blob: url for <track>
  const [prefs, setPrefsState] = useState({ scale: 1, offsetMs: 0 });
  // Whether a chosen track is still downloading. A reliable subtitle can cost
  // several sequential downloads - measured 12s across 18 candidates on
  // Baahubali 2, 7 of them rejected - and with no indication of that the
  // viewer cannot tell a slow load from a broken one.
  const [subLoading, setSubLoading] = useState(false);

  useEffect(() => { setPrefsState(getSubPrefs()); }, []);

  const updatePrefs = useCallback((patch) => setPrefsState(setSubPrefs(patch)), []);

  // Size is a CSS token, so changing it never reloads the track.
  useEffect(() => {
    document.documentElement.style.setProperty('--cue-scale', String(prefs.scale));
  }, [prefs.scale]);

  // Runtime is read through a ref, NOT depended on. The detail page paints
  // from a fast record that has no runtime and then overwrites it with the
  // full one, so runtimeMin goes 0 -> 187 shortly after the player opens.
  // Depending on it re-ran this effect and aborted the in-flight request, so
  // pressing Play early meant no captions on first play. It only refines the
  // ranking and the post-download span check; it must never restart the fetch.
  const runtimeRef = useRef(runtimeMin);
  runtimeRef.current = runtimeMin;

  useEffect(() => {
    // Why captions are missing is otherwise invisible: listSubtitles swallows
    // every failure by design (an enhancement must not break playback), so a
    // title with no imdbId and a title whose fetch failed look identical - an
    // empty sheet either way. Measured on King of Kotha (tt15134398): the
    // network showed ZERO requests to the subtitle host, which only says the
    // effect returned early, not why.
    //
    // window.__chitramSubs is a diagnostic, not state: nothing reads it, and
    // it is written before the guard so the "no imdbId" case is recorded too.
    const note = (stage, extra) => {
      try {
        window.__chitramSubs = {
          imdbId: imdbId ?? null, season, episode,
          runtimeMin: runtimeRef.current, stage, ...extra, at: Date.now(),
        };
      } catch { /* SSR, or a locked-down window */ }
    };
    note('start');
    if (!imdbId) { note('no-imdb-id'); return; }
    const ac = new AbortController();
    listSubtitles({ imdbId, season, episode,
                    runtimeMin: runtimeRef.current, signal: ac.signal })
      .then((list) => {
        setSubs(list);
        // An empty list and a failed fetch used to look identical from the
        // outside: listSubtitles turns every error into `[]`, and the caller
        // swallowed the rest. That made "no Subtitles section" a dead end -
        // it could be a network failure, an abort, a catalogue miss, or every
        // candidate filtered out, with nothing to tell them apart.
        note(list.length ? 'ok' : 'empty', { count: list.length });
      })
      .catch((err) => {
        // An abort is not a failure: React runs effects twice in dev, and a
        // source switch re-runs this one. Only a real error matters.
        note(ac.signal.aborted ? 'aborted' : 'error',
             { message: String(err?.message || err).slice(0, 120) });
      });
    return () => ac.abort(abortReason('subtitle list superseded or unmounted'));
  }, [imdbId, season, episode]);

  /**
   * Load the chosen track, falling back through its alternates.
   *
   * A file can fail three ways that only show up after download: it 404s, it
   * turns out to be a song or trailer with a handful of cues, or its cues stop
   * far short of the film because it was cut for a different release. Any of
   * those means try the next candidate rather than showing captions that drift
   * out of sync halfway through - that is what "reliable" costs.
   *
   * The blob url is revoked when replaced, or the player leaks one per switch.
   */
  /**
   * Turn on the best English track as soon as one is known.
   *
   * `listSubtitles` already ranks by reliability - release match, download
   * count, and a runtime check that rejects a file cut for a different
   * version - so the best candidate is simply the first. Nothing selected a
   * track before this, which is why captions never appeared unless a viewer
   * went looking for them in the menu.
   *
   * Only ever fires when nothing is chosen, so it cannot override a manual
   * pick or re-enable captions the viewer has deliberately turned off. That
   * is what `touched` records - `currentSub: null` alone cannot tell "not
   * started yet" from "switched off".
   */
  const touched = useRef(false);
  useEffect(() => {
    if (!subs.length) return;
    // A track list belongs to ONE title/episode. When the list is replaced -
    // next episode, or a new title in the same player - a currentSub held over
    // from the previous list names a track that no longer exists: the sheet
    // highlights no row (not even "Off", since currentSub is still truthy) and
    // the PREVIOUS episode's captions keep playing over the new one. Treat a
    // selection that is absent from the current list as no selection.
    const stale = currentSub && !subs.some(t => t.id === currentSub);
    if (currentSub && !stale) return;
    // `touched` records a deliberate "off", which must survive re-renders -
    // but not a change of title, whose tracks the viewer has never seen.
    if (touched.current && !stale) return;
    if (stale) touched.current = false;
    setCurrentSub(subs[0].id);
  }, [subs, currentSub]);

  const chooseSub = useCallback((id) => {
    touched.current = true;
    setCurrentSub(id);
  }, []);

  useEffect(() => {
    if (!currentSub) { setSubUrl(null); setSubLoading(false); return; }
    const track = subs.find(t => t.id === currentSub);
    if (!track) return;

    const ac = new AbortController();
    let url = null;
    let alive = true;
    // Clear the previous track immediately: leaving the old cues up while a
    // new language downloads is worse than a brief gap, because they are the
    // wrong words.
    setSubUrl(null);
    setSubLoading(true);

    (async () => {
      const candidates = [track.url, ...(track.alternates || [])];
      const failures = [];
      for (const candidate of candidates) {
        if (!alive) return;
        try {
          const u = await loadTrack(candidate, {
            signal: ac.signal, offsetMs: prefs.offsetMs,
            runtimeMin: runtimeRef.current,
          });
          if (!alive) { URL.revokeObjectURL(u); return; }
          url = u;
          setSubUrl(u);
          setSubLoading(false);
          return;
        } catch (err) {
          if (err?.name === 'AbortError') return;
          failures.push(err?.message || 'unknown');
        }
      }
      if (alive) {
        setSubLoading(false);
        // Say WHY, not just that it failed. `failures` was already collected
        // and then thrown away, so a viewer saw "no usable subtitle" whether
        // the file 404'd, was a trailer, or was simply timed for a different
        // cut - three different situations, one useless message.
        //
        // Measured on tt0330373 (Goblet of Fire): seven English tracks exist
        // and six are timed for shorter cuts, spanning 65-136 minutes against
        // a 157-minute film. Rejecting them is correct; reporting it as
        // "unusable" made a catalogue problem look like a broken player.
        onError?.(describeFailures(failures, candidates.length));
      }
    })();

    return () => {
      alive = false; ac.abort(abortReason('subtitle track superseded or unmounted'));
      // A teardown mid-download must not leave the spinner on forever; the
      // next run sets it again.
      setSubLoading(false);
      if (url) URL.revokeObjectURL(url);
    };
  }, [currentSub, subs, prefs.offsetMs, onError]);

  return { subs, currentSub, setCurrentSub: chooseSub, subUrl, subLoading, prefs, updatePrefs };
}
