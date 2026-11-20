'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PlayerControls from './PlayerControls';
import { Resolving, NextUp, PlayerError } from './player/overlays';
import TvBar from './player/TvBar';
import Icon from './Icon';
import { listSources, poster, reportPlayback } from '../lib/api';
import { isTv as isTvMode, readOverride } from '../lib/dpad';
import { isVidaa, mediaKeyAction, MEDIA_SEEK_SECS, tvPlayerKey } from '../lib/tvKeys';
import { forgetProvider, rememberProvider } from '../lib/lastProvider';
import { abortReason } from '../lib/abortReason';
import useAudioSync from '../lib/player/useAudioSync';
import useSwitchGuard from '../lib/player/useSwitchGuard';
import useStaleRefresh from '../lib/player/staleRefresh';
import { videoChoices, videoIdOf, videoLabels } from '../lib/player/trackChoices';
import EmbedStage from './player/EmbedStage';
import { VA_EMBED_ID, vaEmbedChoice, shouldAutoEmbed } from '../lib/player/vaEmbed';
import { markDead, nextAlive } from '../lib/player/deadSources';
import { fatalAction } from '../lib/player/fatalPolicy';
import useNoPictureGuard from '../lib/player/useNoPictureGuard';
import { pairSources, listSources as listBackendSources } from '../lib/backend';
import {
  useResolve, useHls, useRecovery, useControlVisibility,
  useSubtitles, useEpisodeProgress, useDeviceCapability, useCueOverlay,
  useRotateFullscreen,
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
/** Long enough to read a short sentence, short enough not to sit on the film. */
const NOTICE_MS = 4000;

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

export default function Player({ title, startAt = 0, season = 0, episode = 0,
                                 epTitle = null, onClose, onNext }) {
  const videoRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
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
  const setNotice = useCallback((text) => {
    setNoticeState(text ? { text, id: ++noticeSeq.current } : null);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNoticeState(null), NOTICE_MS);
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

  const resolve = useResolve({
    mediaType: title.mediaType, tmdbId: title.tmdbId, season, episode,
  });
  const { stream, sources, currentSource, currentSourceId, sourcesPending, log, stage, error,
          providers, mergeSources } = resolve;
  const online = useNetworkStatus();

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
  const switchGuard = useSwitchGuard({
    revert: (prev) => {
      stopSwitchRef.current?.();
      resumeAt.current = prev.at || 0;
      resolve.setError(null);
      resolve.switchSource(prev);
    },
    onRevert: setNotice,
  });
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
    giveUp: () => { switchGuard.fail(); },
    currentId: () => currentSourceIdRef.current,
  });
  // The label a viewer sees for a row: the same "CastleTV 2" the Servers menu
  // shows, so the notice names the row they picked.
  const rowLabel = useCallback((id, fallback) => {
    const list = videoChoices(sources);
    const at = list.findIndex((c) => c.id === videoIdOf(id, sources));
    return at >= 0 ? videoLabels(list)[at] : (fallback || 'That server');
  }, [sources]);

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
  // What a playback report needs, refreshed every render. Handlers below are
  // attached once per stream, so they must read this rather than close over
  // props that will be stale by the time an event fires.
  const reportCtx = useRef({});
  reportCtx.current = {
    mediaType: title.mediaType, tmdbId: title.tmdbId, season, episode,
    provider: resolve.currentSource,
  };
  // One success report per stream.
  const reportedRef = useRef(false);
  const streamStartedAt = useRef(null);
  const playbackStats = useRef({ count: 0, totalMs: 0, activeSince: null, recoveries: 0 });
  // A manifest can be perfectly valid while belonging to the wrong title.
  // Keep this per stream so a bad provider is rejected before `playing` can
  // record it as a successful playback.
  const runtimeMismatchRef = useRef(false);
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
    };
  }, []);

  const recoverBySwitching = useCallback((reason = 'switch') => {
    if (resolve.currentSource) {
      markDead(deadSources.current,
        { id: resolve.currentSourceId, provider: resolve.currentSource });
      forgetProvider(title.mediaType, title.tmdbId, resolve.currentSource, season, episode);
      // We are abandoning this source, so say why. Without this the knowledge
      // dies with the tab and the same bad source is chosen again next time.
      reportPlayback({ ...reportCtx.current, ...reportMetrics(), ok: false, reason });
    }
    const alt = nextAlive(resolve.sources, deadSources.current);
    if (!alt) return false;
    switchSourceRef.current?.(alt);
    return true;
  }, [resolve, reportMetrics, title.mediaType, title.tmdbId, season, episode]);
  recoverBySwitchingRef.current = recoverBySwitching;

  const rejectRuntimeMismatch = useCallback(() => {
    const expected = Number(title.runtimeMin);
    const actual = Number(videoRef.current?.duration) / 60;
    if (!expected || !Number.isFinite(actual) || actual <= 0
        || actual >= expected * 0.82 || runtimeMismatchRef.current) return false;
    runtimeMismatchRef.current = true;
    const reason = `runtime mismatch (${Math.round(actual)}m vs ${Math.round(expected)}m)`;
    reportPlayback({ ...reportCtx.current, ...reportMetrics(), ok: false, reason });
    // The stream is technically valid, so HLS will not raise a fatal error.
    // Treat the identity mismatch like any other dead source and use an
    // already validated alternative before asking the resolver again.
    if (!recoverBySwitching(reason)) resolve.load(true);
    return true;
  }, [title.runtimeMin, recoverBySwitching, reportMetrics, resolve]);

  const onFatal = useCallback((data, hls) => {
    // A viewer's own pick failed: put back what they were watching instead of
    // jumping to the first source in the list or covering the picture.
    // An expired signed url on the viewer's own pick: renew it once before
    // going back to the previous server.
    if (switchGuard.isPending() && fatalAction(data).kind === 'stale'
        && staleRefresh.tryRefresh(
          sourceListRef.current.find((s) => s.id === currentSourceIdRef.current))) return;
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
    if (recoverBySwitching(action.reason)) {
      setNotice(action.kind === 'novideo'
        ? `${who} shows no picture on this device. Switched to the next server.`
        : `${who} failed. Switched to the next server.`);
      return;
    }
    // (recoverBySwitching already reported this source's failure.)
    // hls.js's own text ("manifestLoadError") names no provider and tells a
    // viewer nothing, so an unreachable origin gets plain words.
    resolve.setError({ message: action.kind === 'unreachable'
      ? `${who} is not responding, and no other server is left. Try again in a moment.`
      : action.message });
  }, [resolve, recoverBySwitching, switchGuard, staleRefresh, setNotice]);

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
  useEffect(() => {
    if (!online || !stream) return;
    try { hls.hlsRef.current?.startLoad?.(); } catch { /* hls may be tearing down */ }
    const v = videoRef.current;
    if (v?.paused && !error) v.play().catch(() => {});
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
    videoRef, hlsRef: hls.hlsRef, stream,
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
  const [fit, setFit] = useState('contain');
  // 'Fit whole' (contain) is the default on EVERY device and every film starts
  // there. A crop is a per-film judgement - choosing Fill for one wide film
  // should not silently crop the next - so the previous choice is deliberately
  // not restored. The picker is one press away when a particular film wants it.
  //
  // The value is still WRITTEN on change, so nothing else that reads
  // chitram.fit breaks; it is simply not read back at startup.
  const cycleFit = useCallback(() => {
    setFit(f => {
      const next = f === 'contain' ? 'cover' : f === 'cover' ? 'fill' : 'contain';
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
    if (!['contain', 'cover', 'fill'].includes(next)) return;
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
  const hasStream = Boolean(stream);
  useEffect(() => {
    if (!hasStream) return;
    const ac = new AbortController();
    listBackendSources(title.mediaType, title.tmdbId,
      { season, episode, provider: 'netmirror', signal: ac.signal })
      .then((found) => { if (found?.length) mergeSources(found); })
      .catch(() => { /* NetMirror is extra; the list we have stands */ });
    return () => ac.abort(abortReason('netmirror lookup superseded or unmounted'));
  }, [hasStream, title.mediaType, title.tmdbId, season, episode, mergeSources]);
  const controls = useControlVisibility({
    holdOpen: menuOpen || !playing,
    surface: videoRef.current?.parentElement ?? null,
  });

  /** The player root — the element that goes fullscreen, and the cue-lift base. */
  const playerRef = useRef(null);
  const revealControls = controls.reveal;

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
        const inBar = Boolean((onControl || onSlider)
          && playerRef.current?.querySelector('.pctl')?.contains(el));
        const act = tvPlayerKey({ key: e.key, controlsVisible: controls.visible, focusInBar: inBar });
        if (act) {
          if (act === 'rewind') seekBy(v, -MEDIA_SEEK_SECS);
          else if (act === 'forward') seekBy(v, MEDIA_SEEK_SECS);
          else if (act === 'toggle') { v.paused ? v.play().catch(() => {}) : v.pause(); }
          else if (act === 'enter-bar') {
            playerRef.current?.querySelector('.pctl [data-primary]')?.focus({ preventScroll: true });
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
        case 'f': {
          const box = v.parentElement;
          if (document.fullscreenElement) document.exitFullscreen?.();
          else box?.requestFullscreen?.().catch(() => {});
          break;
        }
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

  // Elapsed counter drives the resolving narration. A number that MOVES is
  // the difference between "working" and "frozen".
  useEffect(() => {
    if (stream || error) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 250);
    return () => clearInterval(id);
  }, [stream, error]);

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
        reportedRef.current = true;
        const c = reportCtx.current;
        rememberProvider(c.mediaType, c.tmdbId, c.provider, c.season, c.episode);
        reportPlayback({ ...c, ...reportMetrics(), provider: c.provider, ok: true });
      }
      setStarted(true);
      startedRef.current = true;
      setPlaying(true);
    };
    ['play', 'pause'].forEach(e => v.addEventListener(e, sync));
    v.addEventListener('playing', onPlaying);
    sync();
    return () => {
      ['play', 'pause'].forEach(e => v.removeEventListener(e, sync));
      v.removeEventListener('playing', onPlaying);
    };
  }, [stream, reportMetrics, rejectRuntimeMismatch]);

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
    streamStartedAt.current = stream ? Date.now() : null;
    playbackStats.current = { count: 0, totalMs: 0, activeSince: null, recoveries: 0 };
  }, [stream]);

  // `durationchange` is normally emitted before the first frame, but some HLS
  // implementations only publish the final duration after playback starts.
  // Re-check there as well; the guard is idempotent per stream.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const check = () => { rejectRuntimeMismatch(); };
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
  }, [stream, rejectRuntimeMismatch]);

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
      if (!alternate) return;
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
  const switchTimer = useRef(null);
  // The video+audio pair currently fused, so an offset change can rebuild it.
  const lastPair = useRef(null);
  // pickPair is declared after switchSource but a server switch may need it.
  const pickPairRef = useRef(null);
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
  const beginSwitch = useCallback((label, onTimeout = null) => {
    setSwitching(label);
    clearTimeout(switchTimer.current);
    const id = setTimeout(() => {
      setSwitching(null);
      onTimeout?.();
    }, 12000);
    switchTimer.current = id;
    return id;
  }, []);

  // Cancel a switch this caller started, and only if it is still the live one.
  const endSwitch = useCallback((id) => {
    if (switchTimer.current !== id) return;
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
    if (!v || !switching) return;
    const done = () => {
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

  // `lang` is supplied only when the switch EXISTS to change the language (a
  // per-language sibling source). The Servers menu passes nothing, so picking a
  // different server keeps whatever language is already standing.
  const switchSource = useCallback(async (src, lang = null) => {
    // Leaving a pairing behind clears its padding hint; a single-source
    // reel is aligned with its own audio by construction.
    setPairPadding(null);
    if (lang) setWantLang(lang);
    // Keeping the language across a SERVER change.
    //
    // A server row carries only the picture. When the viewer has a standing
    // language and the new source cannot supply it from inside its own file,
    // playing it plainly drops them onto that provider's default audio -
    // reported as "moving to default audio" and measured on 1408162, where
    // showsst and VaPlayer ship languages:[] and no audio renditions at all.
    //
    // So: keep the picture they just asked for, and re-attach the language by
    // pairing it with whichever source does carry it. Only when the new source
    // genuinely lacks the language - a source that has it in-file needs no
    // help, initialAudioTrack picks it up on attach.
    // Fall back to the language that is PLAYING, not only one the viewer
    // explicitly picked. initialAudioTrack auto-selects Telugu on attach and
    // never goes through pickAudio, so wantLang stays null on a title the
    // viewer never touched the Audio menu on - and the language was dropped
    // anyway. Measured 2026-09-22 on 1408162: want=null at the switch.
    const playing = hls.audioTracks?.find((t) => t.id === hls.currentAudio)?.name || null;
    const want = lang || wantLang || playing;
    if (want && src?.id !== currentSourceId) {
      const owns = (Array.isArray(src?.languages) ? src.languages : [])
        .some((l) => String(l).toLowerCase() === String(want).toLowerCase());
      if (!owns) {
        // Prefer a donor that can hand over ONE language on its own.
        //
        // Several rows may list the language while only some can actually
        // supply it separately: on 1408162 three CastleTV rows all list
        // Telugu, but only the castle-demux row has selectableAudio, and the
        // backend refuses the rest with 409 "not pairable" because they carry
        // no switchable renditions. Taking the first match sent the unpairable
        // row and the switch silently did nothing.
        const carries = (s) => (Array.isArray(s.languages) ? s.languages : [])
          .some((l) => String(l).toLowerCase() === String(want).toLowerCase());
        const donor = sources.find((s) => s.id !== src.id && s.selectableAudio && carries(s))
          || sources.find((s) => s.id !== src.id && carries(s));
        if (donor) {
          // Keeping the language is a BEST EFFORT, never a veto on the server
          // the viewer picked. The pairing can legitimately fail - the backend
          // refuses combinations whose runtimes disagree, and it cannot even
          // measure a provider that is down (VaPlayer's origin returns
          // Cloudflare 522, so describeStream yields null and /hybrid/pair
          // answers 409). Returning here left the click doing nothing at all,
          // with no message and the old server still selected. So fall through
          // to the plain switch when pairing does not work out.
          const ok = await pickPairRef.current?.({
            mode: 'pair',
            video: { id: src.id, source: src },
            audio: { id: `src:${donor.id}:${want}`, language: want, source: donor,
                     kind: donor.selectableAudio ? 'pairable' : 'whole-source' },
          });
          if (ok) return;
        }
      }
    }
    // Comparing the provider NAME blocked a switch between two streams from
    // the SAME provider - and that is a real case here: NetMirror returns
    // three variants on movie/1440735, only one of which carries the Kannada
    // and Telugu audio renditions. Compare identity when we have it.
    if (!src?.masterUrl) return;
    const sameRow = src.id != null && currentSourceId != null
      ? src.id === currentSourceId
      : src.provider === currentSource;
    if (sameRow) return;
    // Manual and recovery switches also count as the startup escape. Do not
    // immediately replace the chosen source again after another 8 seconds.
    startupFallbackUsedRef.current = true;
    // A source switch tears down hls.js and re-attaches, then restores
    // position - several seconds with nothing on screen otherwise.
    // If 12s after the switch the clock is still frozen, the new provider never
    // produced a frame.
    //
    // NOT `!videoWidth`: the element can keep the PREVIOUS source's dimensions
    // after a failed attach, so that test never fires. Measured on 1408162 with
    // VaPlayer down - t stayed put while videoWidth read 1722.
    //
    // NOT a position snapshot taken HERE either: the old source keeps playing
    // while the new master is fetched. Measured the same run - t moved 2879.2
    // -> 2891.8, a 12.6s advance on the OLD stream, so comparing against the
    // click-time position said "it is fine" about a dead provider. Sample at
    // the moment the backstop fires and again a beat later: only a stream that
    // is actually decoding moves in that window.
    beginSwitch(`Switching to ${src.provider}…`, () => {
      const v = videoRef.current;
      if (!v) return;
      // `paused` is NOT evidence of a dead provider. A source switch detaches
      // hls.js and re-attaches, so the element is legitimately paused for as
      // long as the new manifest and first segments take to arrive - and a
      // slow-but-alive server was being condemned for it. Measured 2026-09-22
      // on showsst: the error rendered with the transport bar reading
      // "1:06:55 / 0:00", i.e. duration was still 0 because the manifest had
      // not finished loading. That is a switch in flight, not a failure.
      //
      // Ask instead whether ANY sign of life exists. A provider that is
      // genuinely down produces none of these: no manifest, no buffer, no
      // decoded frame, no clock movement.
      const alive = (w) => Boolean(
        w && (
          w.videoWidth > 0                              // a frame was decoded
          || w.buffered?.length > 0                     // segments landed
          || (Number.isFinite(w.duration) && w.duration > 0) // manifest parsed
          || w.readyState >= 2                          // metadata present
        ),
      );
      if (alive(v)) return;
      const at = v.currentTime;
      // Sample over a window long enough for a first segment on a slow link.
      // 1200ms was inside the normal attach time for a healthy provider, which
      // is what made the message fire on servers that then played fine.
      setTimeout(() => {
        const w = videoRef.current;
        if (!w) return;
        if (alive(w)) return;
        if (Math.abs(w.currentTime - at) >= 0.25) return; // clock is moving
        if (switchGuard.fail()) return;
        resolve.setError({ message: `${src.provider} is not responding. Try another server.` });
      }, 6000);
    });
    resumeAt.current = videoRef.current?.currentTime || 0;
    recovery.clearStall();
    resolve.switchSource(src);
    // beginSwitch is a useCallback with no deps, so naming it adds no re-runs.
  }, [currentSource, currentSourceId, recovery, resolve, beginSwitch, wantLang, sources,
      hls.audioTracks, hls.currentAudio, switchGuard]);

  // Let the recovery path above reach switchSource without reordering hooks.
  switchSourceRef.current = switchSource;

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
  // Returns TRUE only when it actually put something new on screen, so a
  // caller that was merely TRYING to keep the language can fall back.
  const pickPair = useCallback(async (plan) => {
    if (!plan) return false;
    if (plan.mode === 'in-file') return false;
    if (plan.mode === 'substitute') {
      // Record it before switching: the substituted file becomes the picture
      // too, and its own DEFAULT track may not be the language just asked for.
      if (plan.audio?.language) setWantLang(plan.audio.language);
      switchSource(plan.audio?.source);
      return true;
    }
    const video = plan.video?.source;
    const audio = plan.audio?.source;
    if (!video || !audio) return false;
    // The fused master carries this language; remember it so a later server
    // change keeps it rather than reverting to that provider's default.
    if (plan.audio?.language) setWantLang(plan.audio.language);
    const pairTimer = beginSwitch(`Pairing ${audio.provider} audio…`);
    const paired = await pairSources(video, audio,
      { tmdbId: title.tmdbId, mediaType: title.mediaType });
    if (!paired?.url) {
      // Nothing changed, so clear the overlay rather than leaving it hanging
      // for its full 12s timeout on a combination we already know is refused.
      endSwitch(pairTimer);
      return false;
    }
    resumeAt.current = videoRef.current?.currentTime || 0;
    recovery.clearStall();
    // Kept so the Audio timing bar can rebuild this exact pairing with a
    // different offset without the viewer re-picking the language.
    lastPair.current = { video, audio };
    setPairPadding(paired.padded ? { deltaSeconds: paired.delta } : null);
    resolve.switchSource({
      ...video,
      id: `pair-${video.id}-${audio.id}`,
      provider: `${video.provider}+${audio.provider}`,
      masterUrl: paired.url,
      hybrid: true,
      languages: audio.languages || [],
      selectableAudio: true,
    });
    return true;
  }, [switchSource, beginSwitch, endSwitch, recovery, resolve, title.tmdbId, title.mediaType]);
  pickPairRef.current = pickPair;

  // What the menus call. Same switch, but remembered first so a failure can
  // go back: `stream` is the playable shape of what is on screen now.
  const snapshot = useCallback(() => (stream ? {
    ...stream, id: currentSourceId, provider: currentSource,
    label: rowLabel(currentSourceId, currentSource),
    at: videoRef.current?.currentTime || 0,
  } : null), [stream, currentSourceId, currentSource, rowLabel]);
  const pickSource = useCallback((src, lang = null) => {
    if (src?.id == null || src.id !== currentSourceId) {
      switchGuard.begin(snapshot(), rowLabel(src?.id, src?.provider));
    }
    return switchSource(src, lang);
  }, [switchSource, switchGuard, snapshot, rowLabel, currentSourceId]);
  const pickPairGuarded = useCallback((plan) => {
    switchGuard.begin(snapshot(), plan?.audio?.language || 'That language');
    return pickPair(plan);
  }, [pickPair, switchGuard, snapshot]);

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
    () => (vaEmbed ? [...sources, { ...vaEmbed, provider: vaEmbed.label }] : sources),
    [sources, vaEmbed]);
  const pickTvSource = useCallback((s) => {
    if (s?.id === VA_EMBED_ID) pickEmbed();
    else pickSource(s);
  }, [pickEmbed, pickSource]);

  // The new stream decoded a frame: the pick landed, nothing to go back to.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const landed = () => { switchGuard.landed(); staleRefresh.reset(); };
    v.addEventListener('loadeddata', landed);
    return () => v.removeEventListener('loadeddata', landed);
  }, [stream, switchGuard, staleRefresh]);

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
    const syncTimer = beginSwitch('Adjusting audio timing…');
    const paired = await pairSources(pair.video, pair.audio,
      { nudge: want, tmdbId: title.tmdbId, mediaType: title.mediaType });
    if (!paired?.url) {
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

  return (
    <div className="player" ref={playerRef} role="dialog" aria-modal="true"
         aria-label={`Playing ${title.title}`}>
      {!stream && !error && title.backdrop && (
        <div className="player-art"
             style={{ backgroundImage: `url(${poster(title.backdrop, 'w1280')})` }}
             aria-hidden="true" />
      )}
      <video ref={videoRef} className="video" playsInline referrerPolicy="no-referrer"
             controls={useNative || undefined}
             style={{ objectFit: fit }}>
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
          cannot: which provider, and which rung. */}
      {stream && useNative && !embedOn && (
        <TvBar
          sources={tvSources}
          currentSource={currentSource}
          currentSourceId={currentSourceId}
          onPickSource={pickTvSource}
          sourcesPending={sourcesPending}
          audioTracks={hls.audioTracks}
          currentAudio={hls.currentAudio}
          onPickAudio={hls.pickAudio}
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
          embed={vaEmbed}
          onPickEmbed={pickEmbed}
          videoRef={videoRef}
          title={title.title}
          subtitle={epTag}
          onClose={onClose}
          busy={busy}
          visible={controls.visible}
          onReveal={controls.reveal}
          onMenuChange={setMenuOpen}
          menuOpen={menuOpen}
          tv={tvRemote}
          sources={sources}
          currentSource={currentSource}
          currentSourceId={currentSourceId}
          sourcesPending={sourcesPending}
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
          onPickPair={pickPairGuarded}
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
          fit={fit} onCycleFit={cycleFit}
          onPickSub={subtitles.setCurrentSub}
          subPrefs={subtitles.prefs}
          onSubPrefs={subtitles.updatePrefs}
        />
      )}

      {busy && stream && !error && (
        <div className="pbuffering" role="status" aria-live="polite">
          <div className="pspinner" />
          {statusMessage && <span>{statusMessage}</span>}
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
          <span>You're offline. Playback will resume when the connection returns.</span>
          <button type="button" className="pnetwork-retry" onClick={retryNetwork}>Retry</button>
        </div>
      )}

      {!stream && !error && !embedOn && (
        <Resolving stage={stage} title={title.title} meta={epTag || title.year} elapsed={elapsed} log={log}
          providers={providers} onArt={Boolean(title.backdrop)}
          onClose={onClose} onRetry={() => resolve.load(true)} />
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
          onRetry={() => resolve.load(true)} onClose={onClose} />
      )}
      {ep.ended && ep.nextEp && !error && (
        <NextUp ep={ep.nextEp}
                onPlay={() => { ep.setEnded(false); onNext?.(ep.nextEp); }}
                onDismiss={() => ep.setEnded(false)} />
      )}
    </div>
  );
}
