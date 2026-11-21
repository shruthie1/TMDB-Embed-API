'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The stall ladder. Owns `stallStage`; nothing else writes it.
 *
 *   0-2.5s   silent      — invisible; most stalls end here
 *   2.5s     buffering   — acknowledge it, nothing more
 *   12s      recovering  — nudge hls.js to reload the level in place
 *   25s      switching   — fail over to another source (up to twice)
 *   40s      stuck       — offer the manual escape hatch
 *
 * Tuned down from 20/38/55s on 2026-11-16. Every stage gates on fragment
 * progress (rule 1 below), so a slow-but-moving stream is never cut; a stream
 * with no bytes for 25s is dead, and the alternate is already validated.
 * A source that never started fails over too, flagged `startup: true` so the
 * player switches but does not start a fresh resolve for it.
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
const STAGES = { buffering: 2500, recovering: 12000, switching: 25000, stuck: 40000 };
const PROGRESS_WINDOW_MS = 6000;

export function useRecovery({ videoRef, hlsRef, stream, onReResolve, online = true, titleKey }) {
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
  // While offline the ladder holds at 'switching': an outage is not a dead
  // source, and failing over then marked every source dead.
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // Set by the ladder effect: restarts a stall's ladder from zero.
  const restart = useRef(null);

  /** Call from hls.js FRAG_LOAD_PROGRESS so the ladder can see real bytes. */
  const noteProgress = useCallback(() => { fragProgress.current = Date.now(); }, []);

  // A new stream starts a fresh ladder. The stall latch used to survive a
  // stream swap that did not call clearStall (resolve.load(true), a revert),
  // so the next stream's `waiting` returned early, no timer was armed, and a
  // dead re-resolved stream showed the spinner forever.
  //
  // The re-resolve cap is NOT reset here: a re-resolve itself swaps the
  // stream, so a per-stream count never reached 2 and a dead upstream ran a
  // refresh=1 fan-out every 25s forever. It resets on a new title, or when a
  // stream really plays (`playing`).
  useEffect(() => {
    stalling.current = false;
    setStallStage(null);
  }, [stream]);
  useEffect(() => { reResolves.current = 0; }, [titleKey]);

  // Connection back during a held stall: run the ladder again from zero.
  useEffect(() => {
    if (online && stalling.current) restart.current?.();
  }, [online]);

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
        if (!onlineRef.current) { setStallStage('switching'); return; }  // hold
        const started = v.currentTime > 0.5;
        if (reResolves.current < 2) {
          reResolves.current += 1;
          setStallStage('switching');
          cb.current?.({ startup: !started });
        } else {
          setStallStage('stuck');
        }
      }, STAGES.switching * patience));

      timers.push(setTimeout(() => {
        if (!onlineRef.current) return;          // held at 'switching'
        if (!downloading()) setStallStage('stuck');
      }, STAGES.stuck * patience));
    };
    restart.current = () => { clearAll(); stalling.current = false; on(); };

    const off = () => { clearAll(); stalling.current = false; setStallStage(null); };
    const played = () => { reResolves.current = 0; off(); };

    v.addEventListener('waiting', on);
    v.addEventListener('stalled', on);
    v.addEventListener('playing', played);
    v.addEventListener('canplay', off);
    return () => {
      clearAll();
      restart.current = null;
      v.removeEventListener('waiting', on); v.removeEventListener('stalled', on);
      v.removeEventListener('playing', played); v.removeEventListener('canplay', off);
    };
  }, [stream, videoRef, hlsRef]);

  const clearStall = useCallback(() => {
    stalling.current = false;
    setStallStage(null);
  }, []);

  return { stallStage, noteProgress, clearStall, STAGES };
}
