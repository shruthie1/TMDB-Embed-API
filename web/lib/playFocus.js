'use client';
import { useCallback, useRef } from 'react';
import { isTv } from './dpad';

/**
 * Play/Resume holds focus on the title page (owner 2026-11-24: "focus on play
 * and resume buttons on loading").
 *
 * The skeleton, the loaded hero and the route's loading boundary each render
 * their own Play button, so React swaps the node when the record lands and
 * focus fell to <body>: measured on chtrm2 with the title API held 4 s, the
 * TV page sat on BODY for the whole skeleton and Dpad.jsx's 3 s poll only
 * caught the loaded Play afterwards; desktop never focused it.
 *
 * Each Play claims focus from its ref callback, in the same commit that
 * removed the old one, so no frame paints without it. It only takes focus that nobody
 * holds (body) or another Play holds: a viewer who moved to Back stays there.
 * Never on a touch phone: a coarse pointer gets no programmatic focus.
 */
export const PLAY_ATTR = 'data-play-focus';

export function mayAutoFocus() {
  if (typeof window === 'undefined') return false;
  if (isTv()) return true;
  try { return !window.matchMedia('(pointer: coarse)').matches; } catch { return true; }
}

/** Focus `el` when focus is free (body) or on another Play. */
export function claimPlay(el) {
  if (!el || !el.isConnected || !mayAutoFocus()) return false;
  const a = document.activeElement;
  if (a && a !== document.body && a !== el && !a.hasAttribute?.(PLAY_ATTR)) return false;
  // Only while the page is in front: the player dialog owns focus.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  if (a !== el) el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/**
 * A ref callback for a Play button: claims focus each time a new node
 * attaches. `ref.node.current` holds the node, for a later claimPlay().
 */
export function usePlayFocus() {
  const node = useRef(null);
  const ref = useCallback((el) => { node.current = el; if (el) claimPlay(el); }, []);
  ref.node = node;
  return ref;
}
