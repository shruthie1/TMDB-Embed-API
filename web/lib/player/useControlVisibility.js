'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Idle time before the bar fades while playing: mouse/keyboard, then TV.
 *  A remote is slower to reach for, so the TV bar waits longer. */
export const HIDE_MS = 4000;
export const HIDE_TV_MS = 7000;

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
 * @param {number}  opts.hideMs    idle time before hiding while playing
 */
export function useControlVisibility({ holdOpen = false, surface = null, hideMs = HIDE_MS } = {}) {
  const [visible, setVisible] = useState(true);
  const timer = useRef(null);
  // Read through a ref: the timer is armed inside a closure that would
  // otherwise capture whatever `holdOpen` was when the effect last ran.
  const hold = useRef(holdOpen);
  hold.current = holdOpen;
  const delay = useRef(hideMs);
  delay.current = hideMs;

  const clear = useCallback(() => clearTimeout(timer.current), []);

  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    if (!hold.current) {
      timer.current = setTimeout(() => setVisible(false), delay.current);
    }
  }, []);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    setVisible(false);
  }, []);

  // Wake on real intent only. NOT `mousemove`: touch devices synthesise one
  // alongside every tap, which is what raced the tap handler each time this
  // behaviour broke. A `pointermove` from a real MOUSE is safe (a finger's
  // pointermove says pointerType "touch"), and a mouse user expects the bar
  // when they move it.
  useEffect(() => {
    reveal();
    const el = surface;
    const evts = ['wheel', 'focusin'];
    evts.forEach(n => el?.addEventListener(n, reveal, { passive: true }));
    const onPointer = (e) => { if (e.pointerType === 'mouse') reveal(); };
    el?.addEventListener('pointermove', onPointer, { passive: true });
    // Keys go to the document, so a shortcut or a D-pad press on a TV brings
    // the controls back even though they never reach the player element.
    window.addEventListener('keydown', reveal);
    return () => {
      clear();
      evts.forEach(n => el?.removeEventListener(n, reveal));
      el?.removeEventListener('pointermove', onPointer);
      window.removeEventListener('keydown', reveal);
    };
  }, [surface, reveal, clear]);

  // Held open (menu open, or paused) cancels a pending hide; releasing it
  // restarts the clock rather than hiding immediately.
  useEffect(() => {
    if (holdOpen) { setVisible(true); clear(); return; }
    // Clear first: on mount the wake-up effect has already armed a timer, and
    // overwriting the ref orphaned it, so it hid the bar even after a menu
    // opened or playback paused.
    clear();
    timer.current = setTimeout(() => setVisible(false), delay.current);
    return clear;
  }, [holdOpen, clear]);

  return { visible, reveal, hide };
}
