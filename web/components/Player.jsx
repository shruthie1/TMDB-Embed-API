'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PlayerControls from './PlayerControls';
import VideoMenu from './player/VideoMenu';
import { audioLanguageKey, isKnownAudioLanguage, languageSwitchCandidates, sourceAudioLanguages, trackAudioLanguage } from '../lib/player/languageSources';
import { Loading, NextUp, PlayerError } from './player/overlays';
import TvBar from './player/TvBar';
import Icon from './Icon';
import { listSources, poster, reportPlayback } from '../lib/api';
import { isTv as isTvMode, readOverride } from '../lib/dpad';
import { isVidaa, mediaKeyAction, MEDIA_SEEK_SECS, tvPlayerKey } from '../lib/tvKeys';
import { forgetProvider, rememberProvider } from '../lib/lastProvider';
import { abortReason } from '../lib/abortReason';
import useAudioSync from '../lib/player/useAudioSync';
import useNetmirrorSources from '../lib/player/useNetmirrorSources';
import useSwitchGuard from '../lib/player/useSwitchGuard';
import useStaleRefresh from '../lib/player/staleRefresh';
import { videoChoices, videoIdOf } from '../lib/player/trackChoices';
import {
  CHECK_SERVER, Copy, Reason, RowState, labelRows, loadingView, reasonFromText,
} from '../lib/player/loadingModel';
import EmbedStage from './player/EmbedStage';
import useFocusTrap from './useFocusTrap';
import { VA_EMBED_ID, vaEmbedChoice, shouldAutoEmbed } from '../lib/player/vaEmbed';
import { markDead, nextAlive, qualityHeight } from '../lib/player/deadSources';
import { fatalAction } from '../lib/player/fatalPolicy';
import { canFailOver, offlineAction, retryResumeAt } from '../lib/player/offlineRecovery';
import { runtimeVerdict } from '../lib/player/runtimeCheck';
import {
  SWITCH_HARD_MS, SWITCH_TICK_MS, advanceNotice, advanceTarget, beginSourceSwitch, hasLife, tickSourceSwitch,
} from '../lib/player/switchFlow';
import { createWarmScheduler } from '../lib/player/warmSources';
import useNoPictureGuard from '../lib/player/useNoPictureGuard';
import { pairSources, listSources as listBackendSources } from '../lib/backend';
import { canCast, castBody, prepareCast } from '../lib/cast';
import { pairDecodable } from '../lib/player/codecSupport';
import { pairDonors } from '../lib/player/addAudio';
import { makeNotice } from '../lib/player/notice';
import { createAddAudioJourney, makeCheckPair, pairedStream, resumePoint, streamKey } from './player/addAudioJourney';
import {
  useResolve, useHls, useRecovery, useControlVisibility, HIDE_MS, HIDE_TV_MS,
  useSubtitles, useEpisodeProgress, useDeviceCapability, useCueOverlay,
  useRotateFullscreen, toggleFullscreen,
  useNetworkStatus,
  configFor, isTvDevice, tvLevelCap, networkLevelCap, defaultLevelCap,
} from '../lib/player';

/**
 * The player.
 *
 * This component composes hooks and renders; it holds no timers and no
 * derived playback state. Each behaviour has exactly one owner:
 *
 *   useResolve            the SSE resolve, sources, progress log
 *   useHls                attaching hls.js, the quality ladder, audio
 *   useRecovery           the stall ladder
 *   useControlVisibility  whether the control bar is showing
 *   useSubtitles          caption tracks and preferences
 *   useEpisodeProgress    watch position and the next episode
 *   useRotateFullscreen   rotate-to-fullscreen and its activation problem
 *
 * That rule exists because the previous 887-line version had 34 write sites
 * into a handful of shared values, and every regression was two of them
 * racing. See lib/player/README.md.
 */
function playbackDevice() {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';
  if (/TV|Tizen|webOS|AFT[A-Z]|SMART-TV/i.test(ua)) return 'tv';
  if (window.matchMedia?.('(max-width: 600px)').matches) return 'mobile';
  return 'desktop';
}

function playbackConnection() {
  if (typeof navigator === 'undefined') return null;
  return navigator.connection?.effectiveType || null;
}

/** Move playback by `d` seconds, clamped to the media. */
function seekBy(video, d) {
  if (!video?.duration) return;
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + d));
}

// The offline banner's words, also used by the error card an outage leaves.
const OFFLINE_MESSAGE = "You're offline. Playback will resume when the connection returns.";

export default function Player({ title, startAt = 0, season = 0, episode = 0,
                                 epTitle = null, onClose, onNext }) {
  const videoRef = useRef(null);
  /**
   * A transient message over the picture.
   *
   * It clears itself. Nothing ever cleared it before, so every notice - a
   * subtitle error, the autoplay warning, a picture-fit change - stayed on
   * screen for the rest of the film once shown. Keyed by an id so an identical
   * repeat message still restarts the timer rather than being swallowed.
   */
  const [notice, setNoticeState] = useState(null);
  const noticeSeq = useRef(0);
  // opts.holdMs keeps a notice up longer (the add-audio "Checking …" line,
  // I1); every other notice clears after NOTICE_MS.
  const setNotice = useCallback((text, opts) => {
    setNoticeState(makeNotice(text, ++noticeSeq.current, opts));
  }, []);
  // Take a notice down only while it is still the one shown.
  const clearNotice = useCallback((text) => {
    setNoticeState((n) => (n && n.text === text ? null : n));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNoticeState(null), notice.ms);
    return () => clearTimeout(t);
  }, [notice]);
  const [playing, setPlaying] = useState(false);
  // Has a frame ever been painted for THIS stream? Distinct from `playing`,
  // which follows pause/resume: this is one-way per stream, so the initial
  // loader does not re-arm every time the viewer pauses. Declared here rather
  // than beside `switching`, which sits below the effects that set it.
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  // Startup failover is a single escape from a slow first source. It must not
  // reset on every replacement stream, otherwise two slow sources produce a
  // visible provider carousel every 8 seconds.
  const startupFallbackUsedRef = useRef(false);
  // Position to restore across a source switch, so swapping provider never
  // costs your place in the film.
  const resumeAt = useRef(0);
  // Last position that played in this title, for a Retry after the element reset.
  const lastPlayedAtRef = useRef(0);
  // The stream that fired `playing`, so a frame from the OLD stream can never
  // count as a server switch landing (see startSourceSwitch).
  const playedStreamRef = useRef(null);

  const resolve = useResolve({
    mediaType: title.mediaType, tmdbId: title.tmdbId, season, episode,
  });
  const { stream, sources, currentSource, currentSourceId, sourcesPending, error,
          mergeSources } = resolve;
  const online = useNetworkStatus();
  // True when the error on screen was set while offline: the connection
  // coming back then retries everything (offlineAction 'retryAll').
  const errorWhileOfflineRef = useRef(false);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // Declared with the end card below; the online effect reaches it here.
  const retryAllRef = useRef(null);

  const isTv = title.mediaType === 'tv' && episode > 0;
  const epTag = isTv ? `S${season}E${episode}` : null;

  // switchSource is declared further down (it depends on beginSwitch), so the
  // recovery path reaches it through a ref rather than being reordered around
  // hooks that must keep their current order.
  const switchSourceRef = useRef(null);
  const recoverBySwitchingRef = useRef(null);
  const sourceListRef = useRef([]);
  const currentSourceRef = useRef(null);
  const currentSourceIdRef = useRef(null);
  sourceListRef.current = sources;
  currentSourceRef.current = currentSource;
  currentSourceIdRef.current = currentSourceId;

  // The VaPlayer embed is on the stage (see vaEmbed below). Declared here
  // because the key handler must step aside while it is.
  const [embedOn, setEmbedOn] = useState(false);
  const embedOnRef = useRef(false);
  embedOnRef.current = embedOn;

  // A manual pick that fails goes back to what was playing, at the same
  // position, with a one-line notice. See lib/player/useSwitchGuard.js.
  // `stopSwitchRef` clears the switch overlay; beginSwitch is declared below.
  const stopSwitchRef = useRef(null);
  // Declared with switchSource below; onFatal reaches it through this ref.
  const failSwitchRef = useRef(null);
  const switchGuard = useSwitchGuard({
    revert: (prev) => {
      stopSwitchRef.current?.();
      resumeAt.current = prev.at || 0;
      resolve.setError(null);
      resolve.switchSource(prev);
    },
    onRevert: setNotice,
  });
  // "Add <L> audio from another server" (Step 2). One journey object for the
  // player's life; its deps are filled below (addAudioDeps) once applyPair and
  // snapshot exist. onFatal and the frame listener reach it from here.
  const addAudioDeps = useRef({});
  const [addAudioJourney] = useState(() => createAddAudioJourney({
    checkPair: (...a) => addAudioDeps.current.checkPair(...a),
    applyPair: (...a) => addAudioDeps.current.applyPair(...a),
    snapshot: () => addAudioDeps.current.snapshot(),
    position: () => addAudioDeps.current.position(),
    restore: (snap) => addAudioDeps.current.restore(snap),
    notice: (text, opts) => addAudioDeps.current.notice(text, opts),
    clearNotice: (text) => addAudioDeps.current.clearNotice(text),
    label: (donor) => addAudioDeps.current.label(donor),
  }));
  useEffect(() => () => addAudioJourney.cancel(), [addAudioJourney]);
  // A pick whose signed url expired while the page sat open gets one fresh
  // url from its provider before the guard reverts. See staleRefresh.js.
  const staleRefresh = useStaleRefresh({
    fetchRows: (target) => listBackendSources(title.mediaType, title.tmdbId, {
      season, episode, provider: String(target.provider).toLowerCase(), refresh: true,
    }),
    apply: (target, fresh) => {
      resolve.replaceSource(target.id, fresh);
      resolve.switchSource({ ...target, ...fresh, id: target.id });
    },
    giveUp: () => { if (!failSwitchRef.current?.('stale url')) switchGuard.fail(); },
    currentId: () => currentSourceIdRef.current,
  });
  // Rows that failed a server switch. Taken out of the menus (owner: a failed
  // server is not kept selectable). Keyed by url, so a re-resolve that mints
  // a fresh url for the same row brings it back.
  const [sourceChooserOpen, setSourceChooserOpen] = useState(false);
  useEffect(() => setSourceChooserOpen(false), [title.mediaType, title.tmdbId, season, episode]);
  const closeSourceChooser = () => {
    setSourceChooserOpen(false);
    playerRef.current?.querySelector('[data-action="choose-server"]')?.focus();
  };
  const [failedUrls, setFailedUrls] = useState(() => new Set());
  // What the menus offer: every row except the ones that failed a switch.
  const menuSources = useMemo(
    () => (failedUrls.size ? sources.filter((s) => !failedUrls.has(s.masterUrl)) : sources),
    [sources, failedUrls]);
  // The label a viewer sees for a row ("CastleTV 2"). ONE map per title,
  // over the full list with failed rows included (loadingModel labelRows), so
  // a name never changes during a start: the overlay, the advance toast, the
  // server chip and the Servers menu all read it. It used to be re-numbered
  // over the menu list, which drops failed rows, so one moment showed
  // "Switching to CastleTV 4" beside "playing CastleTV 3" (loading-ux finding 4).
  const titleKey = `${title.mediaType}:${title.tmdbId}:${season}:${episode}`;
  const rowLabelsRef = useRef({ key: null, map: {} });
  const rowLabels = useMemo(() => {
    const prev = rowLabelsRef.current.key === titleKey ? rowLabelsRef.current.map : {};
    const map = labelRows(prev, videoChoices(sources).map((c) => c.source));
    rowLabelsRef.current = { key: titleKey, map };
    return map;
  }, [sources, titleKey]);
  const rowLabel = useCallback((id, fallback) => {
    const vid = videoIdOf(id, sources);
    return (vid != null && rowLabels[vid]) || fallback || 'That server';
  }, [rowLabels, sources]);

  /*
   * The loading screen's clock and attempts (lib/player/loadingModel.js).
   * One clock from Play (or an episode change) to the first frame, never
   * reset per overlay. Each source put on screen is one attempt; `k` in
   * "k of n tried" is their count, so it only goes up.
   */
  const playAtRef = useRef(Date.now());
  const searchAtRef = useRef(playAtRef.current);
  const firstListSizeRef = useRef(0);
  const [framedOnce, setFramedOnce] = useState(false);
  const framedOnceRef = useRef(false);
  const [attempts, setAttempts] = useState([]);
  const attemptsRef = useRef([]);
  // Why the open attempt is about to end, set where the failure is known
  // (onFatal) and read where the next attempt begins.
  const pendingReasonRef = useRef(null);
  const [loadNow, setLoadNow] = useState(() => Date.now());
  const putAttempts = useCallback((next) => { attemptsRef.current = next; setAttempts(next); }, []);
  const closeAttempt = useCallback((reason, state = RowState.FAILED) => {
    const list = attemptsRef.current;
    const last = list[list.length - 1];
    if (!last || last.endedAt != null) return;
    putAttempts([...list.slice(0, -1), { ...last, endedAt: Date.now(), state,
      reason: state === RowState.PLAYING || state === RowState.LEFT ? null : (reason || Reason.STOPPED) }]);
  }, [putAttempts]);
  // `asked`: the viewer picked another server, so the row being left closes
  // as LEFT (neutral, not counted as tried), never as a failure.
  const beginAttempt = useCallback((id, asked = false) => {
    if (id == null) return;
    const last = attemptsRef.current[attemptsRef.current.length - 1];
    if (last && last.endedAt == null && last.id === id) return;
    if (last && last.endedAt == null) {
      if (asked) closeAttempt(null, RowState.LEFT);
      else closeAttempt(pendingReasonRef.current);
    }
    pendingReasonRef.current = null;
    putAttempts([...attemptsRef.current,
      { id, startedAt: Date.now(), endedAt: null, state: RowState.STARTING, reason: null }]);
  }, [closeAttempt, putAttempts]);
  useEffect(() => {
    playAtRef.current = Date.now();
    searchAtRef.current = playAtRef.current;
    firstListSizeRef.current = 0;
    framedOnceRef.current = false;
    setFramedOnce(false);
    pendingReasonRef.current = null;
    putAttempts([]);
  }, [titleKey, putAttempts]);

  /**
   * Recover from a dead stream without going back to the network.
   *
   * A resolve usually validates SEVERAL providers and keeps them in `sources`,
   * each with its own masterUrl - switching costs no round-trip at all. Falling
   * straight to resolve.load(true) threw that away: it cleared the stream, reset
   * the progress log and re-resolved from scratch, so a stale url meant a
   * spinner and 3-16s even though a working source was already in hand.
   *
   * Measured on the live box, that is the common case rather than the rare one:
   * of 95 validation failures, the two retried today both came back healthy on
   * the next attempt (vidzee and vidking, expired signed urls), and titles
   * routinely carry 5 sources.
   *
   * Returns true when it took over, so the caller only re-resolves as a last
   * resort. Never picks the source that just died.
   */
  // Sources whose url died THIS session, by source ID (lib/player/
  // deadSources.js: a provider name covers several rows). Skipped when
  // recovering, because
  // `provider !== currentSource` alone is not enough: after one switch the
  // original becomes eligible again, so two stale urls could hand the player
  // back and forth between them.
  //
  // Not repaired here, deliberately. Re-extracting costs a median 8.4-9.0s of
  // Chromium on a 2-core VM, and we would be spending it on a source nobody is
  // watching any more - the switch already restored the picture. The resolver
  // repairs it lazily instead: validate-on-read drops the stale row, and the
  // race re-extracts once on a 403 (see isExpiredReason) the next time this
  // title is resolved.
  const deadSources = useRef(new Set());
  // What is PLAYING (language, height), read by recoverBySwitching so a
  // failover keeps the spoken language. Filled after useHls below, because
  // the callback is declared before `hls` exists.
  const failoverCtxRef = useRef({ lang: null, height: null });
  // What a playback report needs, refreshed every render. Handlers below are
  // attached once per stream, so they must read this rather than close over
  // props that will be stale by the time an event fires.
  const reportCtx = useRef({});
  reportCtx.current = {
    mediaType: title.mediaType, tmdbId: title.tmdbId, season, episode,
    provider: resolve.currentSource,
    // The server reduces this to a media identity (signature dropped), so the
    // learned ranking can tell two files from one provider apart.
    mediaUrl: stream?.masterUrl || null,
  };
  // One success report per stream.
  const reportedRef = useRef(false);
  const streamStartedAt = useRef(null);
  const playbackStats = useRef({ count: 0, totalMs: 0, activeSince: null, recoveries: 0 });
  // A manifest can be perfectly valid while belonging to the wrong title.
  // Keep this per stream so a bad provider is rejected before `playing` can
  // record it as a successful playback.
  const runtimeMismatchRef = useRef(false);
  // Metrics captured at the first frame. The success report can be deferred
  // until the runtime check can run, but startupMs must stay the first-frame
  // time: it feeds cachedStartupMaxMs and the learned ranking.
  const firstFrameMetricsRef = useRef(null);
  // Held in a ref of its own because reportMetrics is a useCallback([]) that
  // several handlers close over. Reading `resolve` directly there would capture
  // the first render's object and quietly go stale if the hook ever returns a
  // new one; a ref-of-ref cannot.
  const requestedAtRef = useRef(null);
  requestedAtRef.current = resolve.requestedAt ?? null;
  const reportMetrics = useCallback(() => {
    const s = playbackStats.current;
    const activeMs = s.activeSince ? Date.now() - s.activeSince : 0;
    return {
      // Time from the stream url arriving to the first frame. Deliberately
      // UNCHANGED, because it is not only a stat: it is compared against
      // cachedStartupMaxMs (8000) to decide whether to skip a cached source,
      // and it carries 1.5x weight in RANK. Widening it to include the resolve
      // would add 1.3s on a cache hit and 14.4s on a cold one (7-day p50s,
      // live VM), pushing ordinary rows past 8s and skipping caches that are
      // perfectly fine. Same number, same meaning, same threshold.
      startupMs: streamStartedAt.current ? Date.now() - streamStartedAt.current : 0,
      // What the viewer actually experiences: press Play to first frame,
      // resolve included. Reported alongside rather than instead, so the two
      // clocks are never mixed in one column and the gap between them IS the
      // resolve cost. Falls back to 0 when no request was recorded.
      waitMs: requestedAtRef.current?.current
        ? Date.now() - requestedAtRef.current.current
        : 0,
      stallCount: s.count,
      stallMs: s.totalMs + activeMs,
      recoveryCount: s.recoveries,
      device: playbackDevice(),
      connection: playbackConnection(),
      // The language playing (or chosen) when the report fires. Recorded as
      // context only: no langOk is sent, so it never becomes audio evidence.
      audioLang: failoverCtxRef.current?.lang || null,
    };
  }, []);

  const recoverBySwitching = useCallback((reason = 'switch') => {
    closeAttempt(pendingReasonRef.current || reasonFromText(reason));
    if (resolve.currentSource) {
      markDead(deadSources.current,
        { id: resolve.currentSourceId, provider: resolve.currentSource });
      forgetProvider(title.mediaType, title.tmdbId, resolve.currentSource, season, episode);
      // We are abandoning this source, so say why. Without this the knowledge
      // dies with the tab and the same bad source is chosen again next time.
      reportPlayback({ ...reportCtx.current, ...reportMetrics(), ok: false, reason });
    }
    const alt = nextAlive(resolve.sources, deadSources.current, failoverCtxRef.current);
    if (!alt) return false;
    switchSourceRef.current?.(alt);
    return alt;
  }, [resolve, reportMetrics, closeAttempt, title.mediaType, title.tmdbId, season, episode]);
  recoverBySwitchingRef.current = recoverBySwitching;

  const rejectRuntimeMismatch = useCallback(() => {
    const expected = Number(title.runtimeMin);
    const actual = Number(videoRef.current?.duration) / 60;
    if (runtimeMismatchRef.current
        || runtimeVerdict(expected, videoRef.current?.duration) !== 'mismatch') return false;
    runtimeMismatchRef.current = true;
    const reason = `runtime mismatch (${Math.round(actual)}m vs ${Math.round(expected)}m)`;
    reportPlayback({ ...reportCtx.current, ...reportMetrics(), ok: false, reason });
    // The stream is technically valid, so HLS will not raise a fatal error.
    // Treat the identity mismatch like any other dead source and use an
    // already validated alternative before asking the resolver again.
    if (!recoverBySwitching(reason)) resolve.load(true);
    return true;
  }, [title.runtimeMin, recoverBySwitching, reportMetrics, resolve]);

  // Confirm the stream as good, once per stream, and only when the runtime
  // check has passed. While runtimeMin or the duration is unknown nothing is
  // sent: the durationchange/poll effect below calls this again when the
  // check can run. A truncated file confirmed early ranked first forever.
  const confirmPlayback = useCallback(() => {
    if (reportedRef.current || runtimeMismatchRef.current || !startedRef.current) return false;
    if (runtimeVerdict(title.runtimeMin, videoRef.current?.duration) !== 'ok') return false;
    reportedRef.current = true;
    const c = reportCtx.current;
    rememberProvider(c.mediaType, c.tmdbId, c.provider, c.season, c.episode);
    reportPlayback({ ...c, ...(firstFrameMetricsRef.current || reportMetrics()),
      provider: c.provider, ok: true });
    return true;
  }, [title.runtimeMin, reportMetrics]);

  const onFatal = useCallback((data, hls) => {
    if (addAudioJourney.deviceFailed()) return; // add-audio: restore, check next
    // A viewer's own pick failed: put back what they were watching instead of
    // jumping to the first source in the list or covering the picture.
    // An expired signed url on the viewer's own pick: renew it once before
    // going back to the previous server.
    if (switchGuard.isPending() && fatalAction(data).kind === 'stale'
        && staleRefresh.tryRefresh(
          sourceListRef.current.find((s) => s.id === currentSourceIdRef.current))) return;
    // A server switch in flight that failed outright: drop that server and
    // move on to the next alive one (same language first), as the timeout does.
    const fa = fatalAction(data);
    // Offline, every source fails the same way. Blame none of them: end any
    // switch being judged, show the offline note, and retry on 'online'.
    if (fa.failover && !canFailOver(globalThis.navigator?.onLine)) {
      failSwitchRef.current?.('offline');
      resolve.setError({ message: OFFLINE_MESSAGE });
      return;
    }
    pendingReasonRef.current = reasonFromText(fa.kind);
    if (fa.failover && failSwitchRef.current?.(fa.reason || fa.kind)) return;
    if (switchGuard.fail()) return;
    // A 403/410 means the signed url went stale. Another provider's url is
    // almost certainly still good, so try that FIRST - it resumes at the same
    // position with no network round-trip - and only re-resolve if this was
    // the last source we had.
    const action = fatalAction(data);
    if (action.kind === 'stale') {
      if (!recoverBySwitching()) resolve.load(true);
      return;
    }
    if (!action.failover) {
      try { hls?.startLoad(); } catch { /* torn down */ }
      return;
    }
    // Any other dead source: fail over to the next validated one first. It is
    // already in memory, so this costs no round trip. recoverBySwitching
    // marks this source dead and reports why, so the list cannot loop.
    // Only with nothing left does the viewer see an error.
    const who = currentSourceRef.current || 'This server';
    const whoLabel = rowLabel(currentSourceIdRef.current, who);
    const alt = recoverBySwitching(action.reason);
    if (alt) {
      // Before the first frame the loading card already says this.
      if (framedOnceRef.current) {
        // It was playing, so it stopped; it did not fail to start.
        setNotice(advanceNotice(whoLabel, rowLabel(alt.id, alt.provider),
          action.kind === 'novideo' || action.kind === 'codecs', true));
      }
      return;
    }
    // (recoverBySwitching already reported this source's failure.)
    // hls.js's own text ("manifestLoadError") names no provider and tells a
    // viewer nothing, so an unreachable origin gets plain words.
    resolve.setError({ message: action.kind === 'unreachable'
      ? `${who} is not responding, and no other server is left. Try again in a moment.`
      : action.message });
  }, [resolve, recoverBySwitching, switchGuard, staleRefresh, setNotice, rowLabel, addAudioJourney]);

  // Declared before useHls, which captures it in onHlsReady.
  const hlsInstance = useRef(null);
  /**
   * A TV gets leaner buffers and a 1080p ceiling.
   *
   * Resolved ONCE: useHls reads config through a ref, but a new object identity
   * every render is the exact hazard that once re-attached hls.js in a loop
   * until the tab ran out of memory.
   */
  const onTvDevice = useMemo(() => isTvDevice(), []);

  /**
   * Native controls instead of ours, on a TV.
   *
   * Fire TV's Silk is Chrome 70. Our overlay leans on :has() (Chrome 105),
   * min() (79), ResizeObserver, sticky-in-scroller and a capture-phase key
   * handler - and the reported symptom is that the settings sheet does not
   * open there. I cannot test that engine: a Silk user-agent on a modern
   * Chrome reported everything healthy while the real device failed.
   *
   * `<video controls>` on Fire TV was built and tested by Amazon against their
   * own remote, so it cannot be broken by our CSS or our key handling. The
   * source picker moves OUTSIDE the video, where native controls cannot reach
   * it - and on a TV that is the control that matters, because switching
   * provider is the real remedy for buffering.
   *
   * ?native=1 / ?native=0 overrides the guess and is remembered, so a wrong
   * call on either side costs one URL rather than a rebuild.
   */
  // Shares readOverride with ?tv=, so both remember for the same 24h and
  // neither can strand a laptop in the 10-foot layout indefinitely. These were
  // two near-identical copies before, and only one of them expired.
  //
  // NOT on VIDAA. Odin's native bar is a desktop bar driven by an on-screen
  // pointer: the remote cannot reach its buttons, which was the reported
  // "player is built for a mouse". There our own bar, which the D-pad drives
  // end to end, is the better default.
  const useNative = useMemo(
    () => readOverride('chitram.native', 'native',
      () => onTvDevice && !isVidaa(typeof navigator === 'undefined' ? '' : navigator.userAgent)),
    [onTvDevice]);
  /**
   * Remote-control key model. isTv() is the same sniff as onTvDevice plus the
   * remembered ?tv= override, so a desktop with ?tv=1 drives the player
   * exactly as a TV does. onTvDevice alone stays the buffer-profile switch.
   */
  const tvRemote = useMemo(() => isTvMode(), []);
  // A hybrid stream (video from one provider, audio renditions from another)
  // needs looser gap handling: the two sides share a cut but not a segmentation,
  // so fragment boundaries drift by up to ~2s and the default 0.5s maxBufferHole
  // stalls every seek. See HLS_CONFIG_HYBRID for the measurements.
  //
  // Read from the backend's own flag rather than sniffed from the URL, so only a
  // stream we actually assembled gets the looser tolerances.
  const isHybrid = Boolean(stream?.hybrid)
    || /\+/.test(String(stream?.provider || ''));
  const hlsConfig = useMemo(
    () => configFor({ tv: onTvDevice, hybrid: isHybrid }),
    [onTvDevice, isHybrid],
  );
  // The language the viewer last chose, which survives a source switch.
  //
  // Starts undefined so useHls falls back to the build-time PREFERRED_LANGUAGE
  // until the viewer actually expresses a preference; once they do, THAT wins
  // on every subsequent source. Held here rather than in useHls because a
  // paired/substituted language never goes through hls.pickAudio at all.
  const [wantLang, setWantLang] = useState(null);

  const hls = useHls({ videoRef, stream, onFatal, config: hlsConfig,
    preferredLanguage: wantLang, onLanguage: setWantLang,
    onHlsReady: (h) => { hlsInstance.current = h; } });
  const discoveredTracksRef = useRef(null);
  discoveredTracksRef.current = { tracks: hls.audioTracks, selected: hls.currentAudio };
  // Same fallback as switchSource: the viewer's pick, else the track playing
  // (initialAudioTrack auto-picks Telugu without ever setting wantLang).
  failoverCtxRef.current = {
    lang: wantLang
      || hls.audioTracks?.find((t) => t.id === hls.currentAudio)?.name
      || null,
    height: qualityHeight(sources?.find((s) => s.id === currentSourceId)?.quality)
      || hls.levels?.[hls.currentLevel]?.height
      || null,
  };

  // Audio playing over a black screen raises no hls.js error (HEVC on Chrome
  // Android, The Paradise 2026-11-19). Treat it as fatal so the normal
  // failover path and its toast run. Not for the embed or an audio-only row.
  useNoPictureGuard({
    videoRef,
    streamKey: stream?.masterUrl || null,
    enabled: !embedOn && !stream?.audioOnly,
    onNoPicture: () => onFatal({ details: 'noVideoFrames', fatal: true,
      message: 'This device cannot show the picture for this stream.' }, hlsInstance.current),
  });

  // A browser can report the network back before hls.js has decided to retry
  // its last fragment. Nudge it once, and retry playback if the element was
  // paused by the outage. This is intentionally best-effort; the normal HLS
  // recovery ladder still owns provider switching.
  // Record whether an error appeared while offline (any producer: onFatal,
  // failSwitch, a resolve that failed offline).
  useEffect(() => {
    errorWhileOfflineRef.current = Boolean(error)
      && (!onlineRef.current || !canFailOver(globalThis.navigator?.onLine));
  }, [error]);

  useEffect(() => {
    const act = offlineAction({ online, error, errorWhileOffline: errorWhileOfflineRef.current });
    // The error card came from the outage: retry everything now it is back.
    if (act === 'retryAll') { errorWhileOfflineRef.current = false; retryAllRef.current?.(); return; }
    if (act !== 'nudge' || !stream) return;
    try { hls.hlsRef.current?.startLoad?.(); } catch { /* hls may be tearing down */ }
    const v = videoRef.current;
    if (v?.paused) v.play().catch(() => {});
  }, [online, stream, error, hls.hlsRef]);

  const retryNetwork = useCallback(() => {
    try { hls.hlsRef.current?.startLoad?.(-1); } catch { /* best-effort */ }
    videoRef.current?.play?.().catch(() => {});
  }, [hls.hlsRef]);

  /**
   * Keep ABR off rungs a TV box cannot decode in real time.
   *
   * A dropped-frame stall from a 4K rung looks identical to a network problem,
   * so this bounds what ABR reaches for. Re-applied per stream because the
   * ladder belongs to the source, and cleared for a non-TV so a shared cache
   * of this component never leaks a cap onto a laptop.
   */
  useEffect(() => {
    const h = hlsInstance.current;
    if (!h) return;
    const levels = h.levels || [];
    const tvCap = onTvDevice ? tvLevelCap(levels) : -1;
    // Every web segment is relayed through /api/seg and billed as Vercel
    // egress, so the 4K rung costs ~2.6x the bytes for a picture no screen in
    // this household can show. Applies everywhere, not just on a TV; the
    // manual quality picker sets currentLevel and is unaffected.
    const defaultCap = defaultLevelCap(levels);
    const network = typeof navigator !== 'undefined' ? navigator.connection : null;
    const apply = (connection) => {
      const netCap = networkLevelCap(levels, connection);
      const caps = [tvCap, netCap, defaultCap].filter(i => i >= 0);
      if (!caps.length) { h.autoLevelCapping = -1; return; }
      const cap = caps.sort((a, b) => (levels[a]?.height || Infinity) - (levels[b]?.height || Infinity))[0];
      h.autoLevelCapping = cap;
    };
    apply(network);
    const onChange = () => apply(navigator.connection);
    network?.addEventListener?.('change', onChange);
    return () => network?.removeEventListener?.('change', onChange);
  }, [onTvDevice, stream, hls.levels]);

  const recovery = useRecovery({
    videoRef, hlsRef: hls.hlsRef, stream, online, titleKey,
    // A STALL is a dead source too, so take the same route a 403 does:
    // switch to another provider first, and only re-resolve if this was the
    // last one we had.
    //
    // This used to call resolve.load(true) directly, which re-resolves and is
    // handed the SAME top-ranked source back - so a provider that stalls
    // stalled again, and the viewer sat buffering with validated alternatives
    // unused in the cache. Observed on Karuppu (tmdb 1367220): mapple's 4K
    // stalls where vidking's 1600p plays immediately.
    //
    // recoverBySwitching marks the current source dead first, so the ladder
    // cannot hand back the provider that just failed.
    // A source that never started (`startup`) only switches: with nothing
    // left, the ladder's own 'stuck' stage offers the manual escape instead
    // of a refresh=1 fan-out every 25s against rate-limited providers.
    onReResolve: ({ startup = false } = {}) => {
      if (!canFailOver(globalThis.navigator?.onLine)) return;  // outage, not a dead source
      playbackStats.current.recoveries += 1;
      if (!recoverBySwitching(startup ? 'startup stall' : 'stall') && !startup) resolve.load(true);
    },
  });

  /**
   * Learn what this device can decode, and cap to it.
   *
   * This is the half that ABR cannot do: a box whose decoder cannot keep up
   * drops frames while the bytes arrive perfectly on time, so no bandwidth
   * estimate - however fast - would ever notice. Dropped frames are the only
   * signal that separates "the network is slow" from "this hardware cannot
   * play this rung", and the two need opposite responses.
   */
  useDeviceCapability({
    videoRef, hlsRef: hls.hlsRef, stream,
    onCap: (h) => setNotice(`Playing at ${h}p — this device was dropping frames above it.`),
  });

  const subtitles = useSubtitles({
    imdbId: title.imdbId, season, episode,
    // The runtime lets the picker reject a file cut for a different length -
    // measured on RRR, whose English variants span 172-180min against 187.
    runtimeMin: title.runtimeMin || 0,
    onError: setNotice,
  });

  /**
   * Captions are painted by us, not the browser.
   *
   * The UA positions cues against the <video> ELEMENT; object-fit:contain
   * letterboxes the picture inside it, so on a 1280x900 element showing a
   * 16:9 film the cues landed 90px below the picture, in the black bar - and
   * further out on a taller window. Our own overlay is sized to the picture.
   */
  /**
   * How the picture fills the screen.
   *
   * A window that is not 16:9 letterboxes - measured 172px of black on each
   * side of a 1578px window. `contain` shows the whole frame with bars,
   * `cover` fills the screen and crops the overhang, `fill` stretches. Every
   * TV player offers this because the right answer depends on the film and on
   * how much the viewer minds either bars or a crop.
   */
  const [fit, setFit] = useState('width');
  // 'Fit width' is the default on EVERY device and every film starts there
  // (owner call, 2026-11-21: the picture uses the full screen width, nothing in
  // the frame cut). A crop or a stretch is a per-film judgement - choosing one
  // for a wide film should not silently carry to the next - so the previous
  // choice is deliberately not restored. The picker is one press away.
  //
  // The value is still WRITTEN on change, so nothing else that reads
  // chitram.fit breaks; it is simply not read back at startup.
  const cycleFit = useCallback(() => {
    setFit(f => {
      const next = f === 'width' ? 'contain' : f === 'contain' ? 'cover' : f === 'cover' ? 'fill' : 'width';
      try { localStorage.setItem('chitram.fit', next); } catch { /* private mode */ }
      // No toast. A fit change is the most self-evident action in the player -
      // the picture visibly reframes - so naming it puts a card over the very
      // frame the viewer is looking at to judge the change.
      return next;
    });
  }, []);

  /**
   * Set a specific fit mode.
   *
   * cycleFit only advances to the next one, which suits a single icon button.
   * The TV bar shows all three at once, so it needs to pick one directly - and
   * the persistence and the notice have to happen either way, so both paths go
   * through here.
   */
  const applyFit = useCallback((next) => {
    if (!['width', 'contain', 'cover', 'fill'].includes(next)) return;
    setFit(next);
    try { localStorage.setItem('chitram.fit', next); } catch { /* private mode */ }
    // Silent, like cycleFit: the reframe is its own feedback, and the settings
    // sheet already shows which mode is selected.
  }, []);

  const cues = useCueOverlay({ videoRef, subUrl: subtitles.subUrl, fit,
                               enabled: !useNative });

  const ep = useEpisodeProgress({
    videoRef, title, season, episode, epTitle, enabled: Boolean(onNext),
  });

  // Controls stay up while a menu is open or playback is paused — hiding them
  // mid-interaction is the classic player annoyance.
  const [menuOpen, setMenuOpen] = useState(false);

  /**
   * Refresh the source list each time the settings sheet opens.
   *
   * The background quality upgrade lands seconds after playback starts, so a
   * list built only from the resolve response shows one entry forever - a
   * viewer on the fast 800p source never saw the 4K ladder appear. Asking on
   * open means the menu is always current as of the moment it was opened,
   * which is the only moment it is read.
   *
   * Read-only on the server: this never starts a resolve.
   */
  useEffect(() => {
    // On a TV there is no settings sheet to open, so gating on menuOpen alone
    // left TvBar showing whatever the first resolve returned - one source,
    // with nothing to switch to. The native path asks once playback starts and
    // again a few seconds later, which is when the background providers land.
    if (!menuOpen && !(useNative && stream)) return;
    const ac = new AbortController();
    const ask = () => listSources(title.mediaType, title.tmdbId,
                                  { season, episode, signal: ac.signal })
      .then(found => {
        // null means the request failed; keep what we already have rather
        // than emptying a menu the viewer is looking at.
        if (found?.length) mergeSources(found);
      })
      .catch(() => { /* a stale list is better than an empty one */ });
    ask();
    // The extra providers finish after the winner, so one later look catches
    // them without polling.
    const again = useNative ? setTimeout(ask, 9000) : null;
    return () => { ac.abort(abortReason('embed lookup superseded or unmounted')); if (again) clearTimeout(again); };
    // `mergeSources`, NOT `resolve`. useResolve returns a fresh object literal
    // every render, so depending on it re-ran this effect on every render -
    // and the effect calls mergeSources, which sets state, which renders again.
    // That loop is what made the settings sheet flicker and swallow clicks:
    // every row was being replaced faster than a press could land on it.
    // mergeSources is a useCallback with no deps, so it is stable.
  }, [menuOpen, useNative, stream, title.mediaType, title.tmdbId, season, episode,
      mergeSources]);

  /**
   * NetMirror, as its own flow.
   *
   * The backend skips NetMirror in the main list whenever Castle's demux
   * already offers Telugu (apiServer.js GATED_BY_DEMUX): NetMirror takes 5-22s
   * and rate limits per IP, and the first picture should not wait on it. But
   * that dropped it entirely - each NetMirror row is a different audio
   * language / platform (Netflix Telugu, Prime Hindi...), and none of them
   * reached the Source list.
   *
   * So ask for it separately, once per title, after playback has started, and
   * merge whatever comes back. The picture never waits; the rows appear when
   * they land. When the main list already carried NetMirror this is a cache
   * hit on the server and merges onto the same rows.
   *
   * Keyed on whether a stream EXISTS, not on the stream object: a source
   * switch replaces the object, and must not re-ask or cancel this.
   */
  const netmirrorSources = useNetmirrorSources({
    hasStream: Boolean(stream), mediaType: title.mediaType, tmdbId: title.tmdbId,
    season, episode, mergeSources,
  });
  // Buffering keeps the bar up, so a stall shows where playback is instead
  // of a frozen picture with nothing on it.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return undefined;
    const on = () => setStalled(true);
    const off = () => setStalled(false);
    v.addEventListener('waiting', on);
    v.addEventListener('playing', off);
    v.addEventListener('emptied', off);
    return () => {
      v.removeEventListener('waiting', on);
      v.removeEventListener('playing', off);
      v.removeEventListener('emptied', off);
      setStalled(false);
    };
  }, [stream, videoRef]);
  const controls = useControlVisibility({
    holdOpen: menuOpen || !playing || stalled,
    surface: videoRef.current?.parentElement ?? null,
    hideMs: (onTvDevice || tvRemote) ? HIDE_TV_MS : HIDE_MS,
  });

  /** The player root — the element that goes fullscreen, and the cue-lift base. */
  const playerRef = useRef(null);
  // aria-modal: Tab stays in the player instead of walking to the page behind.
  useFocusTrap(playerRef);
  const revealControls = controls.reveal;
  // The bar control a remote last stood on: revealing the bar returns there.
  const lastBarFocus = useRef(null);
  useEffect(() => {
    const root = playerRef.current;
    if (!root) return undefined;
    const onIn = (e) => { if (e.target.closest?.('.pctl')) lastBarFocus.current = e.target; };
    root.addEventListener('focusin', onIn);
    return () => root.removeEventListener('focusin', onIn);
  });

  /**
   * Rotate-to-fullscreen.
   *
   * Fullscreened on the .player root rather than the <video>: the control bar,
   * the cue layer and the settings sheet are all siblings of the video, and
   * fullscreening the video alone would leave every one of them behind on a
   * page nobody can see. Disabled on the native-controls path, where the UA's
   * own player owns the fullscreen affordance.
   */
  const rotate = useRotateFullscreen({
    boxRef: playerRef,
    enabled: Boolean(stream) && !useNative,
  });

  /**
   * Record real interactions so a rotation can spend their activation.
   *
   * Listened for at the root in the capture phase rather than wired into each
   * handler: every control already stops propagation to keep taps off the
   * picture, so a bubbling listener would never see the play button - the one
   * tap most likely to precede a rotation. These are exactly the event types
   * the HTML spec counts as activation triggers, so nothing else is worth
   * recording.
   */
  const armRotate = rotate.arm;
  useEffect(() => {
    const root = playerRef.current;
    if (!root) return;
    const evts = ['pointerdown', 'pointerup', 'touchend', 'keydown'];
    evts.forEach(n => root.addEventListener(n, armRotate, { capture: true, passive: true }));
    return () => evts.forEach(n =>
      root.removeEventListener(n, armRotate, { capture: true }));
  }, [armRotate, stream]);

  /**
   * How far to lift captions so the control bar does not cover them.
   *
   * CSS cannot answer this. The bar is a strip at the foot of the WINDOW while
   * the picture is a letterboxed box floating inside it, so whether they touch
   * at all is a relationship between two boxes. The flat 96px this replaced -
   * and the 26% that replaced that - lifted the caption even when the bar was
   * nowhere near the picture. Measured from the live DOM on a tall narrow
   * window: the picture ended at y499 and the bar began at y1054, 555px apart,
   * yet the caption still rose 36px inside a 138px-tall picture.
   *
   * The lift is the actual overlap, and 0 whenever they do not meet.
   */
  useEffect(() => {
    const root = playerRef.current;
    if (!root) return;
    const apply = () => {
      const bar = root.querySelector('.pctl-bottom');
      const layer = root.querySelector('.cue-layer');
      if (!bar || !layer || !controls.visible) {
        root.style.setProperty('--cue-lift', '0px');
        return;
      }
      const b = bar.getBoundingClientRect();
      const l = layer.getBoundingClientRect();
      // Only the part of the bar that actually sits over the picture.
      const overlap = Math.max(0, l.bottom - b.top);
      // Never lift past the picture: on a very short picture a full-height bar
      // would push the caption out of the frame entirely.
      root.style.setProperty('--cue-lift', `${Math.min(overlap, l.height * 0.4)}px`);
    };
    apply();
    // The bar animates in, so its box is not final on the first frame.
    const t = setTimeout(apply, 260);
    window.addEventListener('resize', apply);
    return () => { clearTimeout(t); window.removeEventListener('resize', apply); };
  }, [controls.visible, cues.box, cues.text]);

  /**
   * Lock the page behind the player.
   *
   * The player is a fixed, full-screen dialog, but the detail page underneath
   * kept its own scroll - so its scrollbar showed over the film and a stray
   * wheel or D-pad press scrolled a page nobody could see. The offset is
   * restored on close, or leaving the player would jump you to the top of a
   * page you had scrolled.
   */
  useEffect(() => {
    const y = window.scrollY;
    const { overflow, position, top, width } = document.body.style;
    // position:fixed rather than overflow:hidden alone - iOS Safari ignores
    // the latter on body and keeps rubber-banding.
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${y}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.position = position;
      document.body.style.top = top;
      document.body.style.width = width;
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    };
  }, []);

  /**
   * Keyboard and remote control of playback.
   *
   * The help overlay has always advertised nine player shortcuts and NONE of
   * them existed - no keydown handler lived in the player at all. On a laptop
   * that was a missing nicety; on a TV it made the player a trap, because the
   * only way out was the X button inside a control bar that hides itself and
   * that the D-pad could not reach.
   *
   * Back/Escape closes. TV remotes send Backspace or BrowserBack rather than
   * Escape, and some Tizen/webOS builds report keyCode 461/10009 with no
   * usable `key`, so all of those are treated as Back.
   */
  useEffect(() => {
    // Native controls own the remote entirely: Amazon's bar handles play,
    // seek and volume, and a capture-phase handler competing with it is
    // exactly the kind of interference this mode exists to avoid. Back still
    // needs to work, so that alone is kept.
    const onKey = (e) => {
      const el = document.activeElement;
      // Never steal keys from a text field or a native select.
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const v = videoRef.current;

      // Remote media keys (VIDAA sends bare keyCodes 415/19/413/417/412).
      // Stop leaves the film, the same as Back.
      const media = mediaKeyAction(e);
      const isBack = e.key === 'Escape' || e.key === 'Backspace'
        || e.key === 'BrowserBack' || e.key === 'GoBack'
        || e.keyCode === 461 || e.keyCode === 10009 || e.keyCode === 8
        || media === 'stop';
      // Inside the embed their player owns the keys; only Back is ours.
      if (embedOnRef.current && !isBack) return;
      if (isBack) {
        // A menu is the innermost layer: close that first, so Back means
        // "up one level" rather than always "leave the film".
        if (menuOpen) { setMenuOpen(false); e.preventDefault(); return; }
        e.preventDefault();
        onClose?.();
        return;
      }
      if (!v) return;

      // A focused control owns Enter, Space AND the arrows - that is how a
      // remote's OK presses a button and how the D-pad moves between them.
      // Declared before the native branch because both paths need it.
      const onControl = el && el !== document.body
        && el.matches?.('button, a, [role="button"], [role="menuitemradio"], input');

      /**
       * Seeking works on BOTH paths.
       *
       * The native branch used to stop here, on the assumption that Fire TV's
       * own control bar owns the remote - but its arrow handling is not
       * reliable, and standing down entirely left the viewer with no way to
       * skip at all. Left/right seek is the single most-used control on a
       * remote, so it is handled here regardless.
       *
       * Only when focus is NOT on a control: arrows are also how the D-pad
       * moves between buttons, and stealing them there would trap focus. The
       * `onControl` guard above already returns for Enter and Space; this is
       * the same idea for the arrows.
       */
      // FastForward/Rewind are dedicated keys, so unlike the arrows they seek
      // even with focus on a control, and on the native path too.
      if (media === 'forward' || media === 'rewind') {
        seekBy(v, media === 'forward' ? MEDIA_SEEK_SECS : -MEDIA_SEEK_SECS);
        e.preventDefault();
        return;
      }
      // Explicit Play and Pause are idempotent, so they are safe on the native
      // path too, where a TV defaults (VIDAA included) and where the native
      // bar may or may not handle the remote's vendor keyCodes.
      if (media === 'play') { v.play().catch(() => {}); e.preventDefault(); return; }
      if (media === 'pause') { v.pause(); e.preventDefault(); return; }

      /**
       * TV remote on our own bar: one rule, in tvPlayerKey (lib/tvKeys.js).
       * Left/Right seek and OK toggles unless focus is on a visible control;
       * Up/Down bring the bar up with focus on Play, so the bar is always one
       * press away and focus never starts on an invisible button.
       */
      if (tvRemote && !useNative) {
        const onSlider = el?.getAttribute?.('role') === 'slider';
        const bar = playerRef.current?.querySelector('.pctl');
        const inBar = Boolean((onControl || onSlider) && bar?.contains(el));
        // A card over the film (Next episode, an error, the embed bar) owns
        // its own buttons: OK on "Play next" must press it, not pause.
        if (onControl && !inBar && playerRef.current?.contains(el)) return;
        const act = tvPlayerKey({ key: e.key, controlsVisible: controls.visible, focusInBar: inBar });
        if (act) {
          if (act === 'rewind') seekBy(v, -MEDIA_SEEK_SECS);
          else if (act === 'forward') seekBy(v, MEDIA_SEEK_SECS);
          else if (act === 'toggle') { v.paused ? v.play().catch(() => {}) : v.pause(); }
          else if (act === 'enter-bar') {
            // Back to the control used last, else Play.
            const last = lastBarFocus.current;
            const target = last && bar?.contains(last) ? last
              : playerRef.current?.querySelector('.pctl [data-primary]');
            target?.focus({ preventScroll: true });
          }
          revealControls();
          e.preventDefault();
          return;
        }
        if (inBar) return;                    // the bar's: dpad moves, OK presses
      }

      if (useNative) {
        if (onControl) return;               // let the D-pad navigate
        const step = e.shiftKey ? 60 : 10;
        if (e.key === 'ArrowRight') { seekBy(v, step); e.preventDefault(); return; }
        if (e.key === 'ArrowLeft')  { seekBy(v, -step); e.preventDefault(); return; }
        // Everything else on native belongs to the UA's own controls.
        return;
      }

      // Arrows are the D-pad's navigation keys on a TV, so they must not scrub
      // while a remote moves between buttons. That was implemented as
      // `controls.visible`, which is wrong on a LAPTOP: any mouse move or key
      // press reveals the controls, so left/right were swallowed almost all of
      // the time and the seek keys appeared dead.
      //
      // The real condition is whether focus is sitting ON a control, which is
      // what `onControl` already tells us and is how Enter and Space are
      // handled just below. A keyboard user with focus on the picture now
      // seeks; a remote moving across the button row still navigates.
      const navigating = (onTvDevice || tvRemote) && (controls.visible || onControl);
      const seek = (d) => { if (v.duration) v.currentTime =
        Math.max(0, Math.min(v.duration, v.currentTime + d)); };

      // Enter and Space belong to a focused control - that is how a remote's OK
      // presses a button. Space defers on a TV ONLY: there, focus is the only
      // way to point at anything, so a button legitimately holds it. On a
      // laptop the pointer does the pointing and focus is merely left behind by
      // the last click, so after touching any control once Space was handed to
      // that button for the rest of the film - play/pause looked dead until the
      // viewer clicked the picture to move focus away. Enter still defers
      // everywhere, being the unambiguous "activate the focused thing" key.
      if (onControl && e.key === 'Enter') return;
      if (onControl && (onTvDevice || tvRemote) && (e.key === ' ' || e.key === 'Spacebar')) return;
      // Off-TV Space is the player's, so stop the browser ALSO scrolling the
      // page or re-firing the button focus was left on.
      if (onControl && (e.key === ' ' || e.key === 'Spacebar')) e.preventDefault();

      // Toggle only off the native path: there the UA's own bar may toggle
      // too, and two toggles cancel out.
      if (media === 'toggle') {
        v.paused ? v.play().catch(() => {}) : v.pause();
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case ' ': case 'Spacebar': case 'k':
          v.paused ? v.play().catch(() => {}) : v.pause(); break;
        case 'l': seek(10); break;
        case 'j': seek(-10); break;
        case 'ArrowRight': if (navigating) return; seek(10); break;
        case 'ArrowLeft':  if (navigating) return; seek(-10); break;
        case 'ArrowUp':    if (navigating) return;
          v.volume = Math.min(1, v.volume + 0.1); v.muted = false; break;
        case 'ArrowDown':  if (navigating) return;
          v.volume = Math.max(0, v.volume - 0.1); break;
        case 'm': v.muted = !v.muted; break;
        case 'f':
          // The player box on desktop/Android; the <video> native path on iPhone.
          toggleFullscreen(playerRef.current || v.parentElement);
          break;
        case 'c': setMenuOpen(o => !o); break;
        default:
          if (/^[0-9]$/.test(e.key) && v.duration) {
            v.currentTime = v.duration * (Number(e.key) / 10);
            break;
          }
          return;   // not ours: leave it for the D-pad
      }
      e.preventDefault();
    };
    // Capture, so the player owns these keys before the global D-pad handler
    // turns an arrow into a focus move.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [videoRef, onClose, menuOpen, controls.visible, revealControls, useNative, onTvDevice, tvRemote]);

  /**
   * When the bar fades out, focus leaves it.
   *
   * Otherwise focus stays on a button nobody can see, and the next Left/Right
   * walks the invisible row instead of seeking. With focus back on the page
   * the next key is the "bar hidden" case in tvPlayerKey.
   */
  useEffect(() => {
    if (!tvRemote || controls.visible) return;
    const a = document.activeElement;
    if (a && a !== document.body && playerRef.current?.querySelector('.pctl')?.contains(a)) a.blur();
  }, [tvRemote, controls.visible]);

  // Opening the player leaves focus on the page's Play button BEHIND it. On a
  // remote that is an invisible focus; drop it so the first key is the
  // player's.
  useEffect(() => {
    if (!tvRemote) return;
    const a = document.activeElement;
    if (a && a !== document.body && !playerRef.current?.contains(a)) a.blur();
  }, [tvRemote]);

  // Feed the stall ladder real byte-level progress, so it can tell a slow
  // stream from a stuck one.
  useEffect(() => {
    const h = hls.hlsRef.current;
    if (!h) return;
    const note = () => recovery.noteProgress();
    h.on('hlsFragLoading', note);
    h.on('hlsFragBuffered', note);
    return () => { try { h.off('hlsFragLoading', note); h.off('hlsFragBuffered', note); } catch {} };
  }, [hls.hlsRef, recovery, stream]);

  // The loading screen's seconds tick until the first frame of this start.
  useEffect(() => {
    if (framedOnce || error) return undefined;
    setLoadNow(Date.now());
    const id = setInterval(() => setLoadNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [framedOnce, error]);

  // Every stream put on screen is an attempt (the first answer, a failover,
  // a pick). A pair id counts as its video row.
  useEffect(() => {
    if (!stream) return;
    const id = currentSourceIdRef.current;
    beginAttempt(videoIdOf(id, sourceListRef.current) ?? id);
  }, [stream, beginAttempt]);

  // Remember the last position that played (retryResumeAt). A new title starts at 0.
  useEffect(() => { lastPlayedAtRef.current = 0; }, [titleKey]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const note = () => { if (v.currentTime > 0) lastPlayedAtRef.current = v.currentTime; };
    v.addEventListener('timeupdate', note);
    return () => v.removeEventListener('timeupdate', note);
  }, [stream]);

  // Seek to the resume point once the media is ready. A pending source switch
  // wins over the initial position.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const seekTo = resumeAt.current || startAt;
    resumeAt.current = 0;
    if (seekTo > 0) { try { v.currentTime = seekTo; } catch {} }

    /**
     * Start playing, and if the browser refuses, say why and try once more.
     *
     * Pressing Play on the detail page IS a gesture, but a browser spends it
     * on the task that handled it - and resolving a stream takes 10-13s cold,
     * so this call lands in an unrelated task with no gesture left. Chrome
     * then rejects with NotAllowedError and the viewer has to press play a
     * second time for a film they already asked for.
     *
     * `canplay` is the retry point: permission is sometimes granted only once
     * the element genuinely has media, and a second attempt there costs
     * nothing. The reason is surfaced rather than swallowed - the silent catch
     * here is why this went undiagnosed.
     */
    let done = false;
    const attempt = () => v.play().then(() => { done = true; }, (err) => {
      if (err?.name === 'AbortError') return;   // superseded by a newer load
      if (!done && err?.name === 'NotAllowedError') {
        setNotice('Tap play to start — your browser blocked autoplay.');
      }
    });
    attempt();
    v.addEventListener('canplay', attempt, { once: true });
    return () => v.removeEventListener('canplay', attempt);
  }, [stream, startAt, setNotice]);

  // Mirror the element's own play state rather than tracking it separately.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => setPlaying(!v.paused);
    // `playing` fires when frames are actually being presented - `play` only
    // says the request was made, which is true long before anything is on
    // screen. The loader must stay up until there is a picture.
    const onPlaying = () => {
      // First frame. Reported once per stream: reportedRef is cleared when the
      // stream changes, so a source switch reports again but a pause/resume
      // does not. Read through a ref because this listener is attached once
      // per stream - closing over `started` would capture the value from that
      // render and never see it change.
      if (!reportedRef.current) {
        if (rejectRuntimeMismatch()) return;
        if (!firstFrameMetricsRef.current) firstFrameMetricsRef.current = reportMetrics();
      }
      setStarted(true);
      startedRef.current = true;
      closeAttempt(null, RowState.PLAYING);
      if (!framedOnceRef.current) { framedOnceRef.current = true; setFramedOnce(true); }
      playedStreamRef.current = stream;
      setPlaying(true);
      confirmPlayback();
    };
    ['play', 'pause'].forEach(e => v.addEventListener(e, sync));
    v.addEventListener('playing', onPlaying);
    sync();
    return () => {
      ['play', 'pause'].forEach(e => v.removeEventListener(e, sync));
      v.removeEventListener('playing', onPlaying);
    };
  }, [stream, reportMetrics, rejectRuntimeMismatch, confirmPlayback, closeAttempt]);

  // A new stream means a new wait: clear the flag so the loader shows again
  // for a source switch, which is a fresh load however long the last one ran.
  useEffect(() => {
    setStarted(false);
    startedRef.current = false;
    // Also arm the report again. Without this a source switch would play but
    // never report success, so the new source would look untried forever while
    // the one we abandoned kept its failure.
    reportedRef.current = false;
    runtimeMismatchRef.current = false;
    firstFrameMetricsRef.current = null;
    streamStartedAt.current = stream ? Date.now() : null;
    playbackStats.current = { count: 0, totalMs: 0, activeSince: null, recoveries: 0 };
  }, [stream]);

  // `durationchange` is normally emitted before the first frame, but some HLS
  // implementations only publish the final duration after playback starts.
  // Re-check there as well; the guard is idempotent per stream.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    // Also sends the deferred success report once the check can pass
    // (runtimeMin loaded later re-runs this effect).
    const check = () => { if (!rejectRuntimeMismatch()) confirmPlayback(); };
    check();
    v.addEventListener('loadedmetadata', check);
    v.addEventListener('durationchange', check);
    // Some hls.js/CDN combinations expose duration only after the first
    // fragment, after both events above have already fired. Poll briefly
    // during startup so a wrong but playable title cannot slip through.
    const poll = setInterval(check, 1000);
    const stop = setTimeout(() => clearInterval(poll), 30000);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
      v.removeEventListener('loadedmetadata', check);
      v.removeEventListener('durationchange', check);
    };
  }, [stream, rejectRuntimeMismatch, confirmPlayback]);

  // A new title/episode is a new startup session. Source replacements within
  // the same title deliberately keep the one-fallback guard armed.
  useEffect(() => {
    startupFallbackUsedRef.current = false;
    // Row ids repeat across titles ("OneTouchTV-11"), so a new title starts clean.
    staleRefresh.reset();
  }, [title.mediaType, title.tmdbId, season, episode, staleRefresh]);

  // A server-side validation only proves that bytes exist from the VM. On a
  // user's device the first frame can still take 14-19s, especially when a
  // provider's CDN route is slow. Once another validated source is already in
  // hand, switch at startup instead of waiting for the mid-playback recovery
  // ladder (which intentionally waits much longer for ordinary stalls).
  //
  // This is scoped to one stream and fires once. It never interrupts a source
  // that has reached a playable readyState, and it does not start a new
  // resolve; the alternate URL is already validated and in memory.
  // Give the selected source enough time to receive its first media
  // fragment on high-latency mobile/TV networks. Switching at 8s looked
  // like provider flapping even when playback was about to start.
  const STARTUP_SWITCH_MS = 15000;
  useEffect(() => {
    if (!stream) return;
    const timer = setTimeout(() => {
      const v = videoRef.current;
      if (startupFallbackUsedRef.current || startedRef.current || !v
          || v.readyState >= 3 || !sourceListRef.current.length) return;
      const alternate = sourceListRef.current.find(
        s => s.masterUrl && s.provider !== currentSourceRef.current,
      );
      if (!alternate || !canFailOver(globalThis.navigator?.onLine)) return;
      startupFallbackUsedRef.current = true;
      recoverBySwitchingRef.current?.('startup timeout');
    }, STARTUP_SWITCH_MS);
    return () => clearTimeout(timer);
  }, [stream]);

  // Measure viewer-visible stalls, not hls.js retries. A repeated `waiting`
  // event belongs to one stall episode and must not inflate the metric.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const onWaiting = () => {
      const s = playbackStats.current;
      if (s.activeSince == null) { s.activeSince = Date.now(); s.count += 1; }
    };
    const onPlaying = () => {
      const s = playbackStats.current;
      if (s.activeSince != null) { s.totalMs += Date.now() - s.activeSince; s.activeSince = null; }
    };
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onWaiting);
    v.addEventListener('playing', onPlaying);
    return () => {
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onWaiting);
      v.removeEventListener('playing', onPlaying);
    };
  }, [stream]);

  /**
   * Show the loader for a deliberate switch, not only for a stall.
   *
   * `recovery.stallStage` fires when playback is in trouble. Choosing another
   * quality or source is not trouble - but it does take a few seconds, because
   * hls.js applies a level from the NEXT fragment rather than discarding what
   * is buffered, and segments here run 6-10s. With no loader the press looked
   * like it had done nothing until the picture changed several seconds later.
   *
   * Cleared by the video itself: `playing` after a `waiting`, or a `seeked`,
   * means frames are flowing again. A timeout is the backstop so a switch that
   * silently no-ops cannot leave the spinner up for the rest of the film.
   */
  const [switching, setSwitching] = useState(null);   // label | null
  // True while the switch in flight is one the VIEWER asked for (a menu or
  // loading-screen pick). The loading card then reads "Switching server…"
  // rather than a slow or failed-server line. An automatic advance is false.
  const [switchAsked, setSwitchAsked] = useState(false);
  const switchTimer = useRef(null);
  // The video+audio pair currently fused, so an offset change can rebuild it.
  const lastPair = useRef(null);
  const audioSyncState = useAudioSync(videoRef);
  // Set when /hybrid/pair accepted a pairing only because TMDB's runtime
  // vouched for both halves - the two are the same film cut with different
  // padding, which the automatic PTS rebase cannot correct. Surfaced in the
  // Audio menu so the viewer knows to use the timing bar.
  const [pairPadding, setPairPadding] = useState(null);

  // `onTimeout` reports a switch that never landed.
  //
  // The backstop used to hide the spinner and say nothing, which is how a dead
  // provider looked identical to a slow one: picking VaPlayer on 1408162 left
  // the last frame frozen, paused, with no message and zero further network
  // activity, because their origin answers Cloudflare 522 and hls.js had
  // already exhausted its manifest retries. Silence there reads as "the click
  // did nothing".
  //
  // Returns the timer handle so a caller that later decides to abandon its own
  // switch can cancel ONLY the timer it started. A bare
  // `clearTimeout(switchTimer.current)` after an `await` kills whatever switch
  // began in the meantime: measured on 1408162, pickPair's 409 path ran its
  // clear AFTER switchSource had already fallen through and armed the VaPlayer
  // backstop, so the "not responding" callback was silently cancelled and no
  // message could ever appear.
  // A SERVER switch in flight (lib/player/switchFlow.js): it owns the overlay,
  // the source lock and its own bounded timeout, so beginSwitch stands aside
  // while one runs. `streamRef` is the stream on screen, read by the checker.
  const srcSwitch = useRef(null);
  const srcTick = useRef(null);
  const [sourceLocked, setSourceLocked] = useState(false);
  const streamRef = useRef(stream);
  streamRef.current = stream;
  // A switch that replaces the stream (a pairing, an audio re-timing) is not
  // landed by the OLD picture moving on while the backend works.
  const switchFromStream = useRef(null);

  const beginSwitch = useCallback((label, onTimeout = null, { replacesStream = false } = {}) => {
    if (srcSwitch.current) return null;
    setSwitching(label);
    clearTimeout(switchTimer.current);
    switchFromStream.current = replacesStream ? streamRef.current : null;
    const id = setTimeout(() => {
      setSwitching(null);
      onTimeout?.();
    }, 12000);
    switchTimer.current = id;
    return id;
  }, []);

  // Cancel a switch this caller started, and only if it is still the live one.
  const endSwitch = useCallback((id) => {
    if (id == null || switchTimer.current !== id) return;
    clearTimeout(id);
    switchTimer.current = null;
    setSwitching(null);
  }, []);
  stopSwitchRef.current = () => {
    clearTimeout(switchTimer.current);
    switchTimer.current = null;
    setSwitching(null);
  };

  useEffect(() => {
    const v = videoRef.current;
    // A server switch is judged by its own checker (startSourceSwitch).
    if (!v || !switching || srcSwitch.current) return;
    const done = () => {
      // Still the old picture: the new stream has not been attached yet.
      if (switchFromStream.current && streamRef.current === switchFromStream.current) return;
      clearTimeout(switchTimer.current);
      setSwitching(null);
    };

    /**
     * Clear when the NEW rendition is actually on screen.
     *
     * `playing` and `seeked` were the wrong signals for a quality change: the
     * video never pauses and never seeks, it just starts decoding a different
     * rendition, so neither event fired and the loader stayed up for the rest
     * of the film. `resize` DOES fire, because videoWidth/Height change with
     * the rendition - that is the moment the switch became visible.
     *
     * `seeked` is kept for a source switch, which does restore position.
     */
    // A resize to 0x0 is a TEARDOWN, not a landed switch. Detaching the old
    // source clears the element's dimensions, which fires `resize` just like a
    // new rendition does - so treating every resize as success cancelled the
    // 12s backstop for a provider that never came up, and the "not responding"
    // message could never appear. Measured on 1408162 with VaPlayer down:
    // videoWidth went 1722 -> 0 and no message rendered.
    const onResize = () => { if (v.videoWidth > 0) done(); };
    v.addEventListener('resize', onResize);
    v.addEventListener('seeked', done);
    // A rendition of the SAME dimensions fires no resize, so poll as a
    // fallback: once frames are flowing and the buffer has moved past where we
    // started, the switch has landed.
    const startTime = v.currentTime;
    const id = setInterval(() => {
      if (!v.paused && v.readyState >= 3 && v.currentTime > startTime + 0.6) done();
    }, 300);

    return () => {
      clearInterval(id);
      v.removeEventListener('resize', onResize);
      v.removeEventListener('seeked', done);
    };
  }, [switching, videoRef]);

  // Background warming of the next 2-3 servers (lib/player/warmSources.js).
  // Reads the player through refs when its timer fires, never a stale render.
  const stallStageRef = useRef(null);
  stallStageRef.current = recovery.stallStage;
  const warmStateRef = useRef(null);
  warmStateRef.current = () => {
    const v = videoRef.current;
    const list = sourceListRef.current;
    return {
      sources: list,
      // During a pairing the id is `pair-<video>-<audio>`; the video row is
      // the one playing and must not be warmed.
      currentId: videoIdOf(currentSourceIdRef.current, list),
      dead: deadSources.current,
      lang: failoverCtxRef.current.lang,
      height: failoverCtxRef.current.height,
      at: v?.currentTime || 0,
      stable: Boolean(v && !v.paused && !v.ended && v.readyState >= 3
        && !srcSwitch.current && !stallStageRef.current && !embedOnRef.current),
    };
  };
  const warm = useMemo(() => createWarmScheduler({ getState: () => warmStateRef.current() }), []);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream || !started || embedOn) { warm.stop(); return undefined; }
    // Every `playing` re-arms the full 10s delay, so a stall or a seek
    // restarts the clock; any stop of playback cancels the round in flight.
    const on = () => warm.start();
    const off = () => warm.stop();
    const stops = ['pause', 'ended', 'waiting', 'emptied'];
    warm.start();
    v.addEventListener('playing', on);
    stops.forEach((e) => v.addEventListener(e, off));
    return () => {
      warm.stop();
      v.removeEventListener('playing', on);
      stops.forEach((e) => v.removeEventListener(e, off));
    };
  }, [stream, started, embedOn, warm, videoRef]);

  const endSourceSwitch = useCallback(() => {
    clearInterval(srcTick.current);
    srcTick.current = null;
    srcSwitch.current = null;
    setSourceLocked(false);
    setSwitching(null);
    setSwitchAsked(false);
  }, []);
  // A new title or episode ends any switch still being judged, so its
  // "Switching server…" and its verdict cannot carry over.
  useEffect(() => { endSourceSwitch(); }, [titleKey, endSourceSwitch]);

  /**
   * Show "Switching to X…" at once, lock the server list, and judge the new
   * stream on its own frames: landed, or dead after SWITCH_NO_LIFE_MS (nothing
   * at all) / SWITCH_HARD_MS (something, but no frame). Dead advances.
   */
  const startSourceSwitch = useCallback((src, label, at, ctx, asked = false) => {
    clearTimeout(switchTimer.current);
    switchTimer.current = null;
    clearInterval(srcTick.current);
    warm.stop();
    srcSwitch.current = beginSourceSwitch({ target: src, label, at, ctx, streamKey: streamRef.current });
    beginAttempt(src?.id, asked);
    setSourceLocked(true);
    setSwitching(`Switching to ${label}…`);
    setSwitchAsked(Boolean(asked));
    srcTick.current = setInterval(() => {
      const pending = srcSwitch.current;
      if (pending?.ctx.strictLanguage && streamRef.current !== pending.streamKey && playedStreamRef.current === streamRef.current) {
        const known = (discoveredTracksRef.current?.tracks || []).map(trackAudioLanguage).filter(isKnownAudioLanguage);
        if (known.length && !known.some(name => audioLanguageKey(name) === audioLanguageKey(pending.ctx.lang))) {
          failSwitchRef.current?.(`${pending.ctx.lang} audio missing`, null, pending.ctx.lang);
          return;
        }
      }
      const r = tickSourceSwitch(srcSwitch.current, {
        streamKey: streamRef.current,
        frames: playedStreamRef.current != null && playedStreamRef.current === streamRef.current,
        alive: hasLife(videoRef.current),
      });
      if (r.verdict === 'wait') { srcSwitch.current = r.state; return; }
      if (r.verdict === 'landed') { endSourceSwitch(); switchGuard.landed(); return; }
      // What the viewer reads: nothing at all in 8s, or something but no
      // frame by the 20s cap (the verdicts themselves are switchFlow's).
      const took = Date.now() - (srcSwitch.current?.startedAt ?? Date.now());
      failSwitchRef.current?.('switch timeout', took >= SWITCH_HARD_MS ? Reason.NO_PICTURE : Reason.NO_ANSWER);
    }, SWITCH_TICK_MS);
  }, [warm, endSourceSwitch, switchGuard, videoRef, beginAttempt]);
  useEffect(() => () => clearInterval(srcTick.current), []);

  // The server being switched to failed (timeout or a fatal error). Mark it
  // dead, take it out of the menus, and play the next alive row in the
  // language that was playing at the click. Returns true when it handled it.
  failSwitchRef.current = (reason, uiReason = null, missingLang = null) => {
    const m = srcSwitch.current;
    if (!m) return false;
    // Offline: the target is not dead, the network is. Stop judging the switch
    // without marking it; the stall ladder holds and resumes on 'online'.
    if (!canFailOver(globalThis.navigator?.onLine)) { endSourceSwitch(); return true; }
    closeAttempt(uiReason || pendingReasonRef.current || reasonFromText(reason));
    endSourceSwitch();
    // Advancing replaces the old "go back" revert for a server pick.
    switchGuard.landed();
    const failed = m.target;
    forgetProvider(title.mediaType, title.tmdbId, failed.provider, season, episode);
    reportPlayback({ ...reportCtx.current, ...reportMetrics(), provider: failed.provider,
      ok: false, reason: `switch: ${reason}` });
    if (failed.masterUrl) setFailedUrls((prev) => new Set(prev).add(failed.masterUrl));
    const alt = advanceTarget(sourceListRef.current, deadSources.current, failed, m.ctx);
    if (!alt && m.ctx.strictLanguage && m.ctx.fallback?.source?.masterUrl) {
      const previous = m.ctx.fallback;
      resumeAt.current = previous.at;
      setWantLang(previous.lang);
      resolve.setError(null);
      resolve.switchSource(previous.source);
      setNotice(`No playable ${m.ctx.lang} stream responded. Restored previous stream.`);
      return true;
    }
    if (!alt) {
      resolve.setError({ message: `${m.label} didn't respond, and no other server is left. Try again in a moment.` });
      return true;
    }
    // Before the first frame the loading card already names both servers.
    // `missingLang`: the target played, but without the picked language (I2).
    if (framedOnceRef.current || missingLang) {
      setNotice(advanceNotice(m.label, rowLabel(alt.id, alt.provider),
        attemptsRef.current[attemptsRef.current.length - 1]?.reason === Reason.UNSUPPORTED, false, missingLang));
    }
    switchSourceRef.current?.(alt, m.ctx.strictLanguage ? m.ctx.lang : null, { at: m.at, ctx: m.ctx });
    return true;
  };

  // `lang` is supplied only when the switch EXISTS to change the language (a
  // per-language sibling source). The Servers menu passes nothing, so picking a
  // different server keeps whatever language is already standing.
  // `opts.at` / `opts.ctx` carry the click-time position and language through
  // an auto-advance: by then the failed attach has reset both.
  const switchSource = useCallback(async (src, lang = null, opts = {}) => {
    // Leaving a pairing behind clears its padding hint; a single-source
    // reel is aligned with its own audio by construction.
    setPairPadding(null);
    if (lang) setWantLang(lang);
    // Comparing the provider NAME blocked a switch between two streams from
    // the SAME provider - and that is a real case here: NetMirror returns
    // three variants on movie/1440735, only one of which carries the Kannada
    // and Telugu audio renditions. Compare identity when we have it.
    if (!src?.masterUrl) { setNotice(`${rowLabel(src?.id, src?.provider) || 'This server'} has no playable stream.`); return; }
    const sameRow = src.id != null && currentSourceId != null
      ? src.id === currentSourceId
      : src.provider === currentSource;
    if (sameRow) return;
    // Feedback first, before any network: the click must change the screen
    // NOW, before the new stream attaches.
    const at = opts.at ?? (videoRef.current?.currentTime || 0);
    startSourceSwitch(src, rowLabel(src.id, src.provider), at,
      opts.ctx || { ...failoverCtxRef.current, ...(lang ? { lang, strictLanguage: true } : {}) },
      Boolean(opts.asked));
    // A server switch never starts audio pairing (owner rule 2026-11-21).
    // Pairing is only the viewer's explicit pick in the Audio menu. A standing
    // language that the new source carries in-file is picked on attach by
    // useHls (preferredLanguage = wantLang -> initialAudioTrack).
    // Manual and recovery switches also count as the startup escape. Do not
    // immediately replace the chosen source again after another 8 seconds.
    startupFallbackUsedRef.current = true;
    // A source switch tears down hls.js and re-attaches, then restores
    // position. The overlay and the bounded verdict (landed / dead and
    // advance) are startSourceSwitch's, armed above. The old 12s + 6s
    // backstop only ever ended in an error; a slow-but-alive server that
    // answered a manifest was never judged again.
    resumeAt.current = at;
    recovery.clearStall();
    resolve.switchSource(src);
  }, [currentSource, currentSourceId, recovery, resolve,
      startSourceSwitch, rowLabel, videoRef, setNotice]);

  // Let the recovery path above reach switchSource without reordering hooks.
  switchSourceRef.current = switchSource;

  // Actual tracks discovered during playback remain available after changing server.
  useEffect(() => {
    if (playedStreamRef.current !== stream || !hls.audioTracks?.length) return;
    const source = sources.find(s => s.id === currentSourceId);
    if (!source || String(currentSourceId).startsWith('pair-')) return;
    const names = [...new Set(hls.audioTracks.map(trackAudioLanguage).filter(isKnownAudioLanguage))];
    if (!names.length || names.map(audioLanguageKey).join('|') === sourceAudioLanguages(source).map(audioLanguageKey).join('|')) return;
    resolve.replaceSource(source.id, { ...source, languages: names, audio: names.map(language => ({ language })), selectableAudio: names.length > 1 });
  }, [started, stream, hls.audioTracks, sources, currentSourceId, resolve.replaceSource]);



  /**
   * Play the viewer's chosen picture with their chosen language.
   *
   * Three outcomes, decided by trackChoices.pairingFor:
   *   'in-file'    nothing to do here - the rendition switch already happened.
   *   'substitute' the language only exists welded into its own file, so that
   *                file becomes the picture too. An ordinary source switch.
   *   'pair'       the two halves live in different providers; the backend
   *                muxes them and hands back one master.
   *
   * A refused pair is not an error to shout about: the backend's duration gate
   * declines combinations whose halves disagree on runtime, which usually
   * means they are two different films. Leaving playback untouched is the
   * correct response.
   */
  // Put a server pair answer on screen: `video` picture, `audio` donor sound.
  // The wanted language changes HERE, only once a pair is accepted, so a
  // refused pair leaves it as it was (Step 2: the old code set it before the
  // pair call and kept it on failure).
  // `at`: the add-audio run's position, used when the element has no live
  // position yet (a restored stream still loading reads 0, RI1).
  const applyPair = useCallback((video, audio, language, paired, at) => {
    resumeAt.current = resumePoint(videoRef.current, at);
    recovery.clearStall();
    // Kept so the Audio timing bar can rebuild this exact pairing with a
    // different offset without the viewer re-picking the language.
    // `language` too, so a timing re-pair keeps the asked language as the
    // master's DEFAULT=YES track (M1), not the server's Telugu default.
    lastPair.current = { video, audio, language };
    setPairPadding(paired.padded ? { deltaSeconds: paired.delta } : null);
    // The fused master carries this language; remember it so a later server
    // change keeps it rather than reverting to that provider's default.
    if (language) setWantLang(language);
    resolve.switchSource(pairedStream(video, audio, paired));
  }, [recovery, resolve, videoRef]);

  // Returns TRUE only when it actually put something new on screen, so a
  // caller that was merely TRYING to keep the language can fall back.
  const pickPair = useCallback(async (plan) => {
    if (!plan) return false;
    if (plan.mode === 'in-file') return false;
    if (plan.mode === 'substitute') {
      // Record it before switching: the substituted file becomes the picture
      // too, and its own DEFAULT track may not be the language just asked for.
      if (plan.audio?.language) setWantLang(plan.audio.language);
      // The viewer asked for this in the Audio menu: "Switching server…".
      switchSource(plan.audio?.source, null, { asked: true });
      return true;
    }
    const video = plan.video?.source;
    const audio = plan.audio?.source;
    if (!video || !audio) return false;
    const pairTimer = beginSwitch(`Pairing ${audio.provider} audio…`, null, { replacesStream: true });
    const paired = await pairSources(video, audio,
      { tmdbId: title.tmdbId, mediaType: title.mediaType });
    // The server switch that asked for this pairing already gave up on it.
    if (plan.stale?.()) return false;
    if (!paired?.url) {
      // Nothing changed, so clear the overlay rather than leaving it hanging
      // for its full 12s timeout on a combination we already know is refused.
      endSwitch(pairTimer);
      return false;
    }
    // The pair is real but this browser cannot decode what it declares (an
    // HEVC picture or AC-3 donor on Chrome Android): switching would play a
    // black or silent stream, so take the refused path instead (H8).
    if (pairDecodable(paired.codecs) === false) {
      console.warn(`[pair] undecodable here, not switching: video=${(paired.codecs?.video || []).join('|')} audio=${paired.codecs?.audio}`);
      endSwitch(pairTimer);
      return false;
    }
    applyPair(video, audio, plan.audio?.language, paired);
    return true;
  }, [switchSource, beginSwitch, endSwitch, applyPair, title.tmdbId, title.mediaType]);

  // What the menus call. Same switch, but remembered first so a failure can
  // go back: `stream` is the playable shape of what is on screen now.
  // Before the first frame there is nothing to go back to: null, so every
  // pre-frame failure moves on through failSwitch and no revert can put the
  // viewer back on a source that never gave a picture.
  // M5: while an add-audio pair is on screen but has not landed, "what is on
  // screen" for a revert is the stream from before that run, not the pair.
  const snapshot = useCallback(() => addAudioJourney.unsettled()?.stream || (stream && framedOnceRef.current ? {
    ...stream, id: currentSourceId, provider: currentSource,
    label: rowLabel(currentSourceId, currentSource),
    at: videoRef.current?.currentTime || 0,
  } : null), [stream, currentSourceId, currentSource, rowLabel, addAudioJourney]);
  // Also the server branch of pickLanguage, so a failed language switch goes
  // back the same way a failed server pick does. `opts` reaches switchSource.
  const pickSource = useCallback((src, lang = null, opts = undefined) => {
    // The list is locked while a server switch runs: it ends in a frame, or
    // in a bounded timeout that moves on by itself.
    if (srcSwitch.current) {
      setNotice(`Still switching to ${srcSwitch.current.label}…`);
      return undefined;
    }
    if (src?.id == null || src.id !== currentSourceId) {
      switchGuard.begin(snapshot(), rowLabel(src?.id, src?.provider));
    }
    // A plain pick ends any add-audio run; it never starts one. After the
    // guard, so the guard's snapshot can still see the run (M5).
    addAudioJourney.cancel();
    // `asked`: the viewer picked this, so the loading card says "Switching
    // server…" and not that the old server was slow.
    opts = { ...opts, asked: true };
    return switchSource(src, lang, opts);
  }, [switchSource, switchGuard, snapshot, rowLabel, currentSourceId, setNotice, addAudioJourney]);
  const pickLanguage = useCallback((language) => {
    if (srcSwitch.current) { setNotice(`Still switching to ${srcSwitch.current.label}…`); return; }
    const track = hls.audioTracks?.find(t => audioLanguageKey(trackAudioLanguage(t)) === audioLanguageKey(language));
    setWantLang(language);
    if (track && hls.pickAudio(track.id) !== false) { addAudioJourney.cancel(); return; }
    // W2: the playing source is never a candidate; its tracks were tried above.
    const candidates = languageSwitchCandidates(sourceListRef.current, language, currentSourceIdRef.current);
    let next = nextAlive(candidates, deadSources.current, { lang: language });
    // An explicit language click retries its failed sources without reviving unrelated rows.
    if (!next && candidates.length) {
      for (const source of candidates) deadSources.current.delete(source.id ?? source.provider);
      setFailedUrls(prev => new Set([...prev].filter(url => !candidates.some(s => s.masterUrl === url))));
      next = nextAlive(candidates, deadSources.current, { lang: language });
    }
    // Guarded like a manual server pick (pickSource): a failed switch returns
    // to the previous server and position.
    if (next) pickSource(next, language, { ctx: {
      ...failoverCtxRef.current, lang: language, strictLanguage: true,
      fallback: { source: sourceListRef.current.find(s => s.id === currentSourceIdRef.current),
        lang: hls.audioTracks?.find(t => t.id === hls.currentAudio)?.name || wantLang,
        at: videoRef.current?.currentTime || 0 },
    } });  // pickSource ends any add-audio run.
    else { addAudioJourney.cancel(); setNotice(`No other ${language} stream found`); }
  }, [hls.audioTracks, hls.currentAudio, hls.pickAudio, pickSource, wantLang, videoRef, addAudioJourney]);
  const pickPairGuarded = useCallback((plan) => {
    if (srcSwitch.current) {
      setNotice(`Still switching to ${srcSwitch.current.label}…`);
      return false;
    }
    switchGuard.begin(snapshot(), plan?.audio?.language || 'That language');
    addAudioJourney.cancel();
    return pickPair(plan);
  }, [pickPair, switchGuard, snapshot, setNotice, addAudioJourney]);

  // "Add <L> audio from another server": the explicit journey (Step 2). Only
  // the menu entry calls this; nothing starts it automatically. During a
  // pair the playing id is `pair-<video>-<audio>`, so the picture is the
  // video half (videoIdOf), which is also what the donor audio joins.
  addAudioDeps.current = {
    checkPair: makeCheckPair({ pairSources, pairDecodable, tmdbId: title.tmdbId, mediaType: title.mediaType }),
    applyPair,
    // Taken once, at the run's first switch: stream, position, wanted
    // language, and the pair the timing bar would rebuild.
    snapshot: () => {
      const prev = snapshot();
      return prev ? { key: streamKey(prev), at: prev.at, stream: prev, wantLang, lastPair: lastPair.current, padding: pairPadding } : null;
    },
    restore: (snap) => {
      switchGuard.begin(snap.stream, snap.wantLang || 'That language');
      switchGuard.fail();
      setWantLang(snap.wantLang);
      lastPair.current = snap.lastPair;
      setPairPadding(snap.padding);
    },
    notice: setNotice,
    clearNotice,
    position: () => resumePoint(videoRef.current),
    label: (donor) => rowLabel(donor.id, donor.provider),
  };
  const addAudio = useCallback((language) => {
    if (srcSwitch.current) { setNotice(`Still switching to ${srcSwitch.current.label}…`); return; }
    const list = sourceListRef.current;
    const videoId = videoIdOf(currentSourceIdRef.current, list);
    const video = list.find(s => s.id === videoId);
    const donors = video ? pairDonors(list, language, video) : [];
    if (!donors.length) { setNotice(Copy.noWorkingAudio(language)); return; }
    addAudioJourney.start({ language, video, donors });
  }, [addAudioJourney, setNotice]);
  // I1: every stream change reaches the journey. A change the run did not
  // make (failover, stall recovery, a pick, a stale-url refresh) ends it.
  useEffect(() => {
    addAudioJourney.streamChanged(streamKey({ id: currentSourceId, masterUrl: stream?.masterUrl }));
  }, [addAudioJourney, stream, currentSourceId]);
  // A new title or episode: the run belongs to the old one.
  useEffect(() => {
    addAudioJourney.cancel();
  }, [addAudioJourney, title.tmdbId, title.mediaType, season, episode]);
  // Languages a pair carries, for the menus' "missing" test on the native path
  // where audioTracks is empty and the pair id is no row.
  const pairLanguages = String(currentSourceId ?? '').startsWith('pair-')
    ? (lastPair.current?.audio?.languages || null) : null;

  // VaPlayer's own page in an iframe, the last Servers row. See
  // lib/player/vaEmbed.js. `embedOn` is the one switch: while it is set the
  // stage shows the frame and our video is paused underneath, so picking our
  // current source again resumes where it was.
  const vaEmbed = useMemo(() => vaEmbedChoice({
    imdbId: title.imdbId, mediaType: title.mediaType, season, episode,
  }), [title.imdbId, title.mediaType, season, episode]);
  const autoEmbedUsed = useRef(false);
  useEffect(() => {
    setEmbedOn(false);
    autoEmbedUsed.current = false;
  }, [title.tmdbId, title.mediaType, season, episode]);
  const pickEmbed = useCallback(() => {
    if (!vaEmbed) return;
    try { videoRef.current?.pause(); } catch { /* element gone */ }
    setMenuOpen(false);
    setEmbedOn(true);
  }, [vaEmbed]);
  // A Servers row picked from inside the embed: back to our player.
  const leaveEmbed = useCallback((choice) => {
    setEmbedOn(false);
    const src = choice?.source;
    if (!src) return;
    if (stream && src.id === currentSourceId) {
      videoRef.current?.play().catch(() => {});
      return;
    }
    pickSource(src);
  }, [stream, currentSourceId, pickSource]);
  // Automatic only when the resolve returned NO sources at all. Once per
  // title, so Close is not undone.
  useEffect(() => {
    if (embedOn || autoEmbedUsed.current) return;
    if (!shouldAutoEmbed({ embed: vaEmbed, error, sources })) return;
    autoEmbedUsed.current = true;
    try { videoRef.current?.pause(); } catch { /* element gone */ }
    setEmbedOn(true);
  }, [embedOn, vaEmbed, error, sources]);
  // The TV bar lists sources itself; the embed rides along as one more entry.
  const tvSources = useMemo(
    () => (vaEmbed ? [...menuSources, { ...vaEmbed, provider: vaEmbed.label }] : menuSources),
    [menuSources, vaEmbed]);
  const pickTvSource = useCallback((s) => {
    if (s?.id === VA_EMBED_ID) pickEmbed();
    else pickSource(s);
  }, [pickEmbed, pickSource]);

  // The new stream decoded a frame: the pick landed, nothing to go back to.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    // The key of THIS stream: the journey counts only its own pair's frame.
    const key = streamKey({ id: currentSourceId, masterUrl: stream.masterUrl });
    const landed = () => { switchGuard.landed(); staleRefresh.reset(); addAudioJourney.landed(key); };
    v.addEventListener('loadeddata', landed);
    return () => v.removeEventListener('loadeddata', landed);
  }, [stream, currentSourceId, switchGuard, staleRefresh, addAudioJourney]);

  // Commit an audio offset. The browser absorbs small POSITIVE shifts with a
  // DelayNode and nothing else has to happen; anything it cannot do (audio
  // EARLIER, or more than ~2s later) needs the segments restamped, which means
  // re-pairing on the server and reloading the master.
  const commitAudioSync = useCallback(async (seconds) => {
    const want = Number(seconds) || 0;
    if (audioSyncState.applyClient(want)) return;
    const pair = lastPair.current;
    // Nothing fused means there is nothing to restamp: a single provider's own
    // muxed audio is already aligned with its own video by construction.
    if (!pair?.video || !pair?.audio) return;
    const syncTimer = beginSwitch('Adjusting audio timing…', null, { replacesStream: true });
    const paired = await pairSources(pair.video, pair.audio,
      { nudge: want, language: pair.language || undefined, tmdbId: title.tmdbId, mediaType: title.mediaType });
    if (!paired?.url || pairDecodable(paired.codecs) === false) {
      if (paired?.url) console.warn(`[pair] undecodable here, keeping current timing: video=${(paired.codecs?.video || []).join('|')} audio=${paired.codecs?.audio}`);
      endSwitch(syncTimer);
      return;
    }
    resumeAt.current = videoRef.current?.currentTime || 0;
    recovery.clearStall();
    resolve.switchSource({
      ...pair.video,
      id: `pair-${pair.video.id}-${pair.audio.id}-n${want}`,
      provider: `${pair.video.provider}+${pair.audio.provider}`,
      masterUrl: paired.url,
      hybrid: true,
      languages: pair.audio.languages || [],
      selectableAudio: true,
    });
  }, [audioSyncState, beginSwitch, endSwitch, recovery, resolve, title.tmdbId, title.mediaType]);


  // Cast to a TV through Web Video Caster (lib/cast.js). Phone only: hidden
  // on desktop and on a TV, which is the receiver, not the sender.
  const castable = useMemo(() => typeof navigator !== 'undefined'
    && canCast({ ua: navigator.userAgent, tv: tvRemote || onTvDevice }), [tvRemote, onTvDevice]);
  const castPrepare = useCallback(() => {
    const name = epTag ? `${title.title} ${epTag}` : title.title;
    return prepareCast({
      body: castBody({
        stream, pair: lastPair.current, tmdbId: title.tmdbId, mediaType: title.mediaType,
        title: name, nudge: audioSyncState.offset,
      }),
      meta: { title: name, poster: poster(title.poster, 'w500') || undefined },
      ua: navigator.userAgent,
    });
  }, [stream, title.title, title.tmdbId, title.mediaType, title.poster, epTag, audioSyncState.offset]);
  const cast = useMemo(() => (castable ? { prepare: castPrepare } : null), [castable, castPrepare]);

  // Embeddable providers for this title, fetched only once our own playback
  // has failed - there is no reason to ask otherwise, and it keeps the happy
  // path free of an extra request.
  // Always empty: `/api/embed/...` was a resolver endpoint and 404s on the
  // local backend (measured 2026-09-22), so this fetch only ever produced a
  // failed request in the network panel - one per playback failure, exactly
  // when the panel is being read. The embed-fallback UI below is left intact
  // and simply renders nothing while the list is empty.
  const [embeds] = useState([]);

  // True from the moment we have a url until the first frame is painted.
  //
  // `Resolving` hides as soon as `stream` is set, and `busy` used to cover only
  // a STALL or a source switch - so the window in between rendered nothing at
  // all while hls.js fetched the manifest, the variant and the first segment.
  // On a 4K source that is several seconds of a black screen with no spinner
  // and no play icon, which reads as stuck rather than loading.
  //
  // `started` flips on the first `playing` event and stays set, so this does
  // not re-arm on an ordinary pause.
  const busy = Boolean(recovery.stallStage) || Boolean(switching) || (Boolean(stream) && !started);
  const statusMessage = useMemo(() => {
    // A deliberate switch says what it is doing. It takes precedence: the
    // viewer just pressed something and wants that acknowledged, not a
    // generic buffering message.
    if (switching) return switching;
    switch (recovery.stallStage) {
      case 'switching':  return 'Trying another source…';
      case 'recovering': return 'Reconnecting…';
      case 'stuck':      return 'This source is struggling';
      default:           return null;   // plain buffering: a spinner says it better
    }
  }, [recovery.stallStage, switching]);

  // The loading screen's view (lib/player/loadingModel.js). The list counts
  // as ready once the first answer is in; rows that arrive later are
  // "more found", not a bigger n.
  const listReady = sources.length > 0;
  if (listReady && !firstListSizeRef.current) firstListSizeRef.current = sources.length;
  const loadView = useMemo(() => loadingView({
    now: loadNow, playAt: playAtRef.current, title: title.title,
    sources: listReady ? sources : null, labels: rowLabels,
    firstListSize: firstListSizeRef.current, attempts,
    // One request answers the whole search, so one honest row.
    checks: [{ id: CHECK_SERVER, label: 'Chitram server', startedAt: searchAtRef.current, endedAt: null }],
    framed: framedOnce, failed: Boolean(error), switching: switchAsked,
  }), [loadNow, title.title, listReady, sources, rowLabels, attempts, framedOnce, error, switchAsked]);
  // Search-phase Try again (only offered at 30s with no list): ask again
  // WITHOUT the refresh path. A non-refresh ask joins the /api/streams
  // request still running (lib/backend.js fetchStreamsShared) rather than
  // aborting it for a slower refresh resolve.
  const retrySearch = useCallback(() => {
    searchAtRef.current = Date.now();
    resolve.load(false);
  }, [resolve]);
  // The end card's Retry is a fresh start: new clock, new attempts.
  const retryAll = useCallback(() => {
    playAtRef.current = Date.now();
    searchAtRef.current = playAtRef.current;
    firstListSizeRef.current = 0;
    pendingReasonRef.current = null;
    putAttempts([]);
    // Resume where the viewer was, not at the original start point.
    resumeAt.current = retryResumeAt(videoRef.current?.currentTime, lastPlayedAtRef.current);
    resolve.load(true);
  }, [resolve, putAttempts]);
  retryAllRef.current = retryAll;
  // A row picked in Details plays at once, like the Servers menu. It ends a
  // switch still being judged (the viewer's pick wins over an automatic
  // advance), then goes through pickSource like every other manual pick, so
  // a failed pick goes back through switchGuard.
  const pickFromLoading = useCallback((id) => {
    const src = sources.find((s) => s.id === id);
    if (!src) return;
    if (srcSwitch.current) endSourceSwitch();
    pickSource(src);
  }, [sources, endSourceSwitch, pickSource]);

  return (
    <div className="player" ref={playerRef} role="dialog" aria-modal="true"
         aria-label={`Playing ${title.title}`}
         data-switching={sourceLocked ? 'true' : undefined}>
      {!framedOnce && !error && title.backdrop && (
        <div className="player-art"
             style={{ backgroundImage: `url(${poster(title.backdrop, 'w1280')})` }}
             aria-hidden="true" />
      )}
      <video ref={videoRef} className="video" playsInline referrerPolicy="no-referrer"
             controls={useNative || undefined}
             data-fit={fit}
             style={{ objectFit: fit === 'width' ? undefined : fit }}>
        {/* Keyed on the url so React replaces the element on a language
            change - reusing it leaves the previous cues showing. */}
        {subtitles.subUrl && (
          <track key={subtitles.subUrl} kind="subtitles" src={subtitles.subUrl} default
                 srcLang={subtitles.subs.find(t => t.id === subtitles.currentSub)?.lang || 'en'}
                 label={subtitles.subs.find(t => t.id === subtitles.currentSub)?.name || 'Subtitles'} />
        )}
      </video>

      {/* Sized to the PICTURE, not the element, so a letterboxed film keeps its
          captions over the image. */}
      {cues.text && (
        <div className="cue-layer" aria-hidden="true"
             style={cues.box ? {
               left: cues.box.left, top: cues.box.top,
               width: cues.box.width, height: cues.box.height,
             } : undefined}>
          <div className="cue-text">
            {cues.lines.map((segs, i) => (
              <span key={i}>
                {segs.map((sg, j) => {
                  if (sg.i) return <i key={j}>{sg.text}</i>;
                  if (sg.b) return <b key={j}>{sg.text}</b>;
                  return <span key={j}>{sg.text}</span>;
                })}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* On a TV the native bar handles playback and this carries only what it
          cannot: which provider, and which rung. Gated on framedOnce: before the
          first frame the loading overlay owns the screen, and TvBar mounts open
          (z-index 5) and showed through the semi-transparent overlay on Fire TV
          (Chrome 70 ignores the :has() guard, so gate it here). */}
      {stream && useNative && !embedOn && framedOnce && (
        <TvBar
          sources={tvSources}
          currentSource={currentSource}
          currentSourceId={currentSourceId}
          onPickSource={pickTvSource}
          sourcesPending={sourcesPending}
          onCheckSources={netmirrorSources.check}
          checkingSources={netmirrorSources.loading}
          audioTracks={hls.audioTracks}
          currentAudio={hls.currentAudio}
          onPickAudio={hls.pickAudio}
          onPickLanguage={pickLanguage} audioSources={sources}
          onAddAudio={addAudio} playingLanguages={pairLanguages}
          levels={hls.levels}
          currentLevel={hls.currentLevel}
          autoLevel={hls.autoLevel}
          onPickLevel={(i) => {
            const l = hls.levels.find(x => x.index === i);
            beginSwitch(i === -1 ? 'Switching to Auto…'
                                 : `Switching to ${l?.label ?? 'another quality'}…`);
            hls.pickLevel(i);
          }}
          fit={fit}
          onSetFit={applyFit}
          subs={subtitles.subs}
          currentSub={subtitles.currentSub}
          onPickSub={subtitles.setCurrentSub}
          subLoading={subtitles.subLoading}
          onClose={onClose}
        />
      )}

      {stream && !useNative && !embedOn && (
        <PlayerControls
          cast={cast}
          embed={vaEmbed}
          onPickEmbed={pickEmbed}
          videoRef={videoRef}
          title={title.title}
          subtitle={epTag}
          onClose={onClose}
          busy={busy}
          visible={controls.visible}
          onReveal={controls.reveal}
          onHide={controls.hide}
          onMenuChange={setMenuOpen}
          menuOpen={menuOpen}
          tv={tvRemote}
          sources={menuSources}
          labels={rowLabels}
          covered={!framedOnce}
          currentSource={currentSource}
          currentSourceId={currentSourceId}
          sourcesPending={sourcesPending}
          onCheckSources={netmirrorSources.check}
          checkingSources={netmirrorSources.loading}
          onPickSource={pickSource}
          levels={hls.levels}
          currentLevel={hls.currentLevel}
          autoLevel={hls.autoLevel}
          onPickLevel={(i) => {
            const l = hls.levels.find(x => x.index === i);
            beginSwitch(i === -1 ? 'Switching to Auto…'
                                 : `Switching to ${l?.label ?? 'another quality'}…`);
            hls.pickLevel(i);
          }}
          audioTracks={hls.audioTracks}
          currentAudio={hls.currentAudio}
          onPickAudio={hls.pickAudio}
          onPickLanguage={pickLanguage} audioSources={sources}
          onPickPair={pickPairGuarded}
          onAddAudio={addAudio} playingLanguages={pairLanguages}
          audioSync={{
            value: audioSyncState.offset,
            onPreview: audioSyncState.preview,
            onCommit: commitAudioSync,
            padded: Boolean(pairPadding),
            deltaSeconds: pairPadding?.deltaSeconds || 0,
          }}
          subs={subtitles.subs}
          currentSub={subtitles.currentSub}
          subLoading={subtitles.subLoading}
          fit={fit} onCycleFit={cycleFit} onSetFit={applyFit}
          onPickSub={subtitles.setCurrentSub}
          subPrefs={subtitles.prefs}
          onSubPrefs={subtitles.updatePrefs}
        />
      )}

      {busy && stream && !error && framedOnce && (
        <div className={`pbuffering${statusMessage ? ' has-msg' : ''}`} role="status" aria-live="polite">
          <div className="pspinner" />
          {statusMessage && <span className="pbuffer-text">{statusMessage}</span>}
          {/* Attempts, not the list index: it only goes up, and rows that
              arrive later do not grow n (loading-ux finding 5). */}
          {statusMessage && sources.length > 1 && attempts.length > 0 && (
            <span className="pbuffer-count">
              {attempts.length} of {firstListSizeRef.current || sources.length} tried
            </span>
          )}
          {/* Screen readers get the state even when it is visually SILENT.
              When there IS a visible message the aria-live region already
              announces it, so a second copy read the label twice - and made
              the overlay's own text content duplicate. */}
          {!statusMessage && <span className="sr-only">Buffering</span>}

          {/* The manual controls appear only after the automatic attempts have
              run. Offering them sooner implies we gave up without trying. */}
          {recovery.stallStage === 'stuck' && (
            <div className="pbuffer-actions">
              <button className="pbuffer-btn focusable" data-focus=""
                      onClick={() => {
                        recovery.clearStall();
                        // Prefer a source already validated during the original
                        // resolve; only re-resolve when the ladder is exhausted.
                        if (!recoverBySwitching('manual recovery')) resolve.load(true);
                      }}>
                Try another source
              </button>
              {hls.levels.length > 1 && (
                <button className="pbuffer-btn focusable" data-focus=""
                        onClick={() => {
                          // Dropping quality is often the real fix on a slow link.
                          const lowest = hls.levels[hls.levels.length - 1];
                          beginSwitch(`Switching to ${lowest.label}…`);
                          hls.pickLevel(lowest.index);
                          recovery.clearStall();
                        }}>
                  Lower quality
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!online && !error && (
        <div className="pnetwork" role="alert" aria-live="assertive">
          <Icon name="offline" size={18} />
          <span>{OFFLINE_MESSAGE}</span>
          <button type="button" className="pnetwork-retry" onClick={retryNetwork}>Retry</button>
        </div>
      )}

      {/* From Play to the first frame: the search AND an attached stream
          with no picture yet. Mid-film switches keep .pbuffering above. */}
      {!framedOnce && !error && !embedOn && (
        <Loading view={loadView} title={title.title}
          meta={isTv ? `S${season} E${episode}${epTitle ? ` · ${epTitle}` : ''}` : null}
          onArt={Boolean(title.backdrop)}
          onClose={onClose} onRetry={retrySearch} onPick={pickFromLoading} onChooseServer={() => setSourceChooserOpen(true)} />
      )}
      {sourceChooserOpen && (
        <div className="player-loading-menu" onClick={closeSourceChooser}>
          <VideoMenu choices={videoChoices(sources)} currentId={currentSourceId} currentSource={currentSource}
            open onToggle={closeSourceChooser} onCheckSources={netmirrorSources.check} checkingSources={netmirrorSources.loading}
            onPick={choice => { closeSourceChooser(); if (choice.source) pickFromLoading(choice.source.id); }} />
        </div>
      )}
      {notice && !error && (
        <div className="toast" role="status" key={notice.id}>{notice.text}</div>
      )}
      {embedOn && vaEmbed && (
        <EmbedStage url={vaEmbed.url} tv={useNative}
                    choices={[...videoChoices(sources), vaEmbed]}
                    onPick={leaveEmbed} onClose={onClose} />
      )}
      {error && !embedOn && (
        <PlayerError error={error} embeds={embeds}
          headline={loadView.headline} detail={attempts.length ? loadView.detail : null}
          onRetry={retryAll} onClose={onClose} />
      )}
      {ep.ended && ep.nextEp && !error && (
        <NextUp ep={ep.nextEp}
                onPlay={() => { ep.setEnded(false); onNext?.(ep.nextEp); }}
                onDismiss={() => ep.setEnded(false)} />
      )}
    </div>
  );
}
