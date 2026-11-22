'use client';

/**
 * Prewarm dwell (P13, 2026-11-22): start the details-page prewarm only after
 * the viewer has stayed ~1.5 s, or at once on hover/focus of Play. Leaving
 * sooner cancels it, so browsing past a title costs no stream request.
 *
 * `start` runs at most once per dwell. `openedAt` is when the page opened, so
 * time spent waiting for the title record counts toward the dwell.
 */
export const PREWARM_DWELL_MS = 1500;

export function createDwell({ start, delayMs = PREWARM_DWELL_MS, openedAt = Date.now(), now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) }) {
  let timer = null;
  let fired = false;
  let cancelled = false;
  const fire = (why) => {
    if (fired || cancelled) return;
    fired = true;
    if (timer != null) { clearTimer(timer); timer = null; }
    start(why);
  };
  return {
    /** Arm the timer for the rest of the dwell. */
    arm() {
      if (fired || cancelled || timer != null) return;
      const left = Math.max(0, delayMs - (now() - openedAt));
      timer = setTimer(() => { timer = null; fire('dwell'); }, left);
    },
    /** Hover or focus on Play: start now. */
    now() { fire('play-intent'); },
    /** The viewer left: nothing starts. */
    cancel() {
      cancelled = true;
      if (timer != null) { clearTimer(timer); timer = null; }
    },
    get fired() { return fired; },
  };
}
