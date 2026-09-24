'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The stall ladder. Owns `stallStage`; nothing else writes it.
 *
 *   0-2.5s   silent      — invisible; most stalls end here
 *   2.5s     buffering   — acknowledge it, nothing more
 *   20s      recovering  — nudge hls.js to reload the level in place
 *   38s      switching   — re-resolve to another source (up to twice)
 *   55s      stuck       — offer the manual escape hatch
 *
 * Two rules came from real defects and must not be relaxed:
 *
 * 1. Every stage gates on fragment PROGRESS, not elapsed time. An 8s timer
 *    aborted healthy 6-10s segment fetches, and each abort discarded a partial
 *    transfer - playback could never start. If bytes arrived recently the
 *    stream is slow, not stuck.
 * 2. A stall fires `waiting` repeatedly. Restarting the ladder on each one
 *    meant the later stages never came due and the manual escape hatch never
 *    appeared, stranding the viewer mid-stall.
 */
const STAGES = { buffering: 2500, recovering: 20000, switching: 38000, stuck: 55000 };
const PROGRESS_WINDOW_MS = 6000;

export function useRecovery({ videoRef, hlsRef, stream, onReResolve }) {
  const [stallStage, setStallStage] = useState(null);
  // A boolean, not a timestamp: `stallSince` was tested for truthiness, so
  // a Date.now() of 0 read as 'not stalling' and every repeated `waiting`
  // wiped the timers - the ladder restart this guard exists to prevent.
  const stalling = useRef(false);
  // null = no fragment has ever loaded. Distinguishing that from a recent
  // load matters: 0 would read as 'downloading' at startup and pin the
  // ladder on 'buffering' forever.
  const fragProgress = useRef(null);
  const reResolves = useRef(0);
  const cb = useRef(onReResolve);
  cb.current = onReResolve;

  /** Call from hls.js FRAG_LOAD_PROGRESS so the ladder can see real bytes. */
  const noteProgress = useCallback(() => { fragProgress.current = Date.now(); }, []);

  useEffect(() => { reResolves.current = 0; }, [stream]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const timers = [];
    const clearAll = () => { timers.forEach(clearTimeout); timers.length = 0; };
    const downloading = () => fragProgress.current !== null
      && Date.now() - fragProgress.current < PROGRESS_WINDOW_MS;

    const on = () => {
      if (stalling.current) return;            // already climbing
      stalling.current = true;
      clearAll();

      // A slow link buffers longer as a matter of course, so wait longer
      // before calling it a failure.
      const kbps = hlsRef.current?.bandwidthEstimate
        ? hlsRef.current.bandwidthEstimate / 1000 : null;
      const patience = kbps && kbps < 2000 ? 1.6 : 1;

      timers.push(setTimeout(() => setStallStage('buffering'), STAGES.buffering * patience));

      timers.push(setTimeout(() => {
        if (downloading()) { setStallStage('buffering'); return; }
        setStallStage('recovering');
        try { hlsRef.current?.startLoad(); } catch { /* torn down */ }
      }, STAGES.recovering * patience));

      timers.push(setTimeout(() => {
        if (downloading()) { setStallStage('buffering'); return; }
        const started = v.currentTime > 0.5;
        if (started && reResolves.current < 2) {
          reResolves.current += 1;
          setStallStage('switching');
          cb.current?.();
        } else {
          setStallStage('stuck');
        }
      }, STAGES.switching * patience));

      timers.push(setTimeout(() => {
        if (!downloading()) setStallStage('stuck');
      }, STAGES.stuck * patience));
    };

    const off = () => { clearAll(); stalling.current = false; setStallStage(null); };

    v.addEventListener('waiting', on);
    v.addEventListener('stalled', on);
    v.addEventListener('playing', off);
    v.addEventListener('canplay', off);
    return () => {
      clearAll();
      v.removeEventListener('waiting', on); v.removeEventListener('stalled', on);
      v.removeEventListener('playing', off); v.removeEventListener('canplay', off);
    };
  }, [stream, videoRef, hlsRef]);

  const clearStall = useCallback(() => {
    stalling.current = false;
    setStallStage(null);
  }, []);

  return { stallStage, noteProgress, clearStall, STAGES };
}
