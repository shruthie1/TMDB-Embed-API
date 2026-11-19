import { useEffect, useRef } from 'react';

/**
 * Sound but no picture: a dead source that raises no error.
 *
 * Prod 2026-11-19, The Paradise (movie/1376856) on Chrome Android: an HEVC row
 * played its audio, currentTime advanced, but videoWidth stayed 0 and
 * totalVideoFrames stayed 0. hls.js raised nothing, so no failover ran and the
 * viewer sat in front of a black screen. Any codec the browser cannot decode
 * behaves the same, so this checks the element, not the codec.
 *
 * Fires only when ALL hold, sampled once a second:
 *   - the clock has moved at least ADVANCE_S since this stream's first sample
 *     (so the element is genuinely playing, not loading or paused),
 *   - that has lasted GRACE_MS of wall time since the clock first moved
 *     (a slow first frame on a working stream lands well inside that),
 *   - videoWidth is 0, and no frame was decoded since the first sample
 *     (getVideoPlaybackQuality().totalVideoFrames, when the browser has it),
 *   - the page is visible (a hidden tab may skip video decode on purpose).
 * Once a frame is seen the stream is cleared for good.
 */
export const ADVANCE_S = 3;
export const GRACE_MS = 6000;
const TICK_MS = 1000;

function frames(v) {
  try {
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    return q && Number.isFinite(q.totalVideoFrames) ? q.totalVideoFrames : null;
  } catch {
    return null;
  }
}

/**
 * One sample. Pure apart from reading `v`, so it can be tested with a plain
 * object. `st` is the per-stream state; returns 'ok' (picture seen, stop),
 * 'fire' or 'wait'.
 */
export function sampleNoPicture(st, v, now, hidden = false) {
  if (!v || v.paused || v.seeking || v.ended) return 'wait';
  const f = frames(v);
  // A jump bigger than a tick can play is a seek (a source switch restores
  // the old position this way), not playback: measure from after it.
  const jumped = st.lastTime != null && Math.abs(v.currentTime - st.lastTime) > 2.5;
  st.lastTime = v.currentTime;
  if (st.baseTime == null || jumped) {
    st.baseTime = v.currentTime;
    if (st.baseFrames == null) st.baseFrames = f;
    st.movingSince = null;
    return 'wait';
  }
  const decoded = f != null && st.baseFrames != null ? f - st.baseFrames : null;
  if (v.videoWidth > 0 || (decoded != null && decoded > 0)) return 'ok';
  if (hidden) { st.movingSince = null; return 'wait'; }
  const advance = v.currentTime - st.baseTime;
  if (advance <= 0.5) { st.movingSince = null; return 'wait'; }
  if (st.movingSince == null) st.movingSince = now;
  if (advance >= ADVANCE_S && now - st.movingSince >= GRACE_MS) return 'fire';
  return 'wait';
}

/**
 * @param {object} p
 * @param {{current: HTMLVideoElement|null}} p.videoRef
 * @param {string|null} p.streamKey  identity of the attached stream; a new key re-arms
 * @param {boolean} p.enabled        false for audio-only sources and the embed
 * @param {() => void} p.onNoPicture called once per stream
 */
export default function useNoPictureGuard({ videoRef, streamKey, enabled = true, onNoPicture }) {
  const cb = useRef(onNoPicture);
  cb.current = onNoPicture;
  useEffect(() => {
    if (!enabled || !streamKey) return undefined;
    const st = { baseTime: null, baseFrames: null, movingSince: null, lastTime: null };
    const id = setInterval(() => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const r = sampleNoPicture(st, videoRef.current, Date.now(), hidden);
      if (r === 'wait') return;
      clearInterval(id);
      if (r === 'fire') cb.current?.();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [videoRef, streamKey, enabled]);
}
