'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Long enough to read the time and reach a button without them vanishing. */
export const HIDE_MS = 8000;

/**
 * Owns whether the control bar is showing. Nothing else may write it.
 *
 * Three separate regressions came from a second writer: the wake-up listener
 * racing the tap handler, the menu effect racing the hide timer, and a
 * synthesised `mousemove` racing a tap. So this hook is the only place
 * `visible` changes, and `reveal()` moves one way — show and restart the
 * clock. A one-way function cannot be raced; a toggle can.
 *
 * @param {object}  opts
 * @param {boolean} opts.holdOpen  keep the controls up regardless of the timer
 *                                 (a menu is open, or playback is paused)
 * @param {HTMLElement|null} opts.surface  element whose interactions wake them
 */
export function useControlVisibility({ holdOpen = false, surface = null } = {}) {
  const [visible, setVisible] = useState(true);
  const timer = useRef(null);
  // Read through a ref: the timer is armed inside a closure that would
  // otherwise capture whatever `holdOpen` was when the effect last ran.
  const hold = useRef(holdOpen);
  hold.current = holdOpen;

  const clear = useCallback(() => clearTimeout(timer.current), []);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    if (!hold.current) {
      timer.current = setTimeout(() => setVisible(false), HIDE_MS);
    }
  }, []);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setVisible(false);
  }, []);

  // Wake on real intent only. NOT `mousemove`: it fires constantly and touch
  // devices synthesise one alongside every tap, which is what raced the tap
  // handler each time this behaviour broke.
  useEffect(() => {
    reveal();
    const el = surface;
    const evts = ['wheel', 'focusin'];
    evts.forEach(n => el?.addEventListener(n, reveal, { passive: true }));
    // Keys go to the document, so a shortcut or a D-pad press on a TV brings
    // the controls back even though they never reach the player element.
    window.addEventListener('keydown', reveal);
    return () => {
      clear();
      evts.forEach(n => el?.removeEventListener(n, reveal));
      window.removeEventListener('keydown', reveal);
    };
  }, [surface, reveal, clear]);

  // Held open (menu open, or paused) cancels a pending hide; releasing it
  // restarts the clock rather than hiding immediately.
  useEffect(() => {
    if (holdOpen) { setVisible(true); clear(); return; }
    timer.current = setTimeout(() => setVisible(false), HIDE_MS);
    return clear;
  }, [holdOpen, clear]);

  return { visible, reveal, hide };
}
