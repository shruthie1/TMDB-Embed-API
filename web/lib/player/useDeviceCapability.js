'use client';
import { useEffect, useRef } from 'react';

/**
 * Learn what this device can actually decode, and cap the ladder to match.
 *
 * This exists because a decode-limited device is INDISTINGUISHABLE from a slow
 * network at the buffer level - both show as rebuffering - yet the remedies are
 * opposite. ABR responds to bandwidth, and a box whose decoder cannot keep up
 * with 4K has plenty of bandwidth; it will happily re-fetch the same rung it
 * cannot play. No bandwidth estimator, however fast, can detect this: the
 * bytes arrive on time and the frames are still dropped.
 *
 * `getVideoPlaybackQuality()` reports droppedVideoFrames, which is the signal
 * that separates the two. Sustained drops mean "this rung is too much for this
 * hardware", so we cap and remember.
 *
 * Why measurement rather than a user-agent list: the UA sniff is wrong often
 * enough to matter (Android TV and Chromecast report plain mobile strings), and
 * a device that reports nothing recognisable may still be a weak box. What a
 * device DOES is knowable; what it claims to be is not.
 */

const KEY = 'chitram.maxHeight';
// Below this, playback is visibly juddering rather than merely imperfect. Film
// is 24fps, so ~5% is roughly one dropped frame per second.
const DROP_RATIO = 0.05;
// Two consecutive bad windows before acting: a single one is often just the
// cost of a seek or a source switch.
const WINDOWS = 2;
const WINDOW_MS = 4000;

/** The height this device has previously proven it cannot exceed, if any. */
export function learnedMaxHeight() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

export function rememberMaxHeight(h) {
  try { localStorage.setItem(KEY, String(h)); } catch { /* private mode */ }
}

/** Forget it, so a device is re-assessed (a TV firmware update, say). */
export function forgetMaxHeight() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/**
 * Watch decode health and step the cap down when frames are being dropped.
 *
 * @param {object} opts
 * @param {object} opts.videoRef   the <video>
 * @param {object} opts.hlsRef     hls.js instance ref, for levels + capping
 * @param {any}    opts.stream     re-arm per source; the ladder belongs to it
 * @param {(h:number)=>void} [opts.onCap]  told when a cap is applied
 */
export function useDeviceCapability({ videoRef, hlsRef, stream, onCap }) {
  const bad = useRef(0);
  const last = useRef(null);
  const cb = useRef(onCap);
  cb.current = onCap;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    bad.current = 0;
    last.current = null;

    // Apply what this device already taught us, before any frames are dropped
    // again - the point of remembering is not to relearn it every film.
    const known = learnedMaxHeight();
    if (known) {
      const hls = hlsRef?.current;
      const levels = hls?.levels || [];
      const within = levels
        .map((l, i) => ({ i, h: l.height || 0 }))
        .filter(l => l.h > 0 && l.h <= known)
        .sort((a, b) => b.h - a.h)[0];
      if (within && hls) hls.autoLevelCapping = within.i;
    }

    const id = setInterval(() => {
      if (typeof video.getVideoPlaybackQuality !== 'function') return;
      if (video.paused || video.readyState < 3) return;
      const q = video.getVideoPlaybackQuality();
      const prev = last.current;
      last.current = { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
      if (!prev) return;

      const dropped = q.droppedVideoFrames - prev.dropped;
      const total = q.totalVideoFrames - prev.total;
      // No frames at all in the window means nothing was decoded - a stall,
      // which is the network's problem, not the decoder's.
      if (total <= 0) return;

      if (dropped / total < DROP_RATIO) { bad.current = 0; return; }

      if (++bad.current < WINDOWS) return;
      bad.current = 0;

      // Step down one rung from whatever is playing now, and remember it.
      const hls = hlsRef?.current;
      const levels = hls?.levels || [];
      const playing = video.videoHeight || 0;
      const lower = levels
        .map((l, i) => ({ i, h: l.height || 0 }))
        .filter(l => l.h > 0 && l.h < playing)
        .sort((a, b) => b.h - a.h)[0];
      if (!lower || !hls) return;

      hls.autoLevelCapping = lower.i;
      rememberMaxHeight(lower.h);
      cb.current?.(lower.h);
    }, WINDOW_MS);

    return () => clearInterval(id);
  }, [videoRef, hlsRef, stream]);
}
