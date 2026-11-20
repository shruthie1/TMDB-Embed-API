import { useEffect } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// What Tab can actually land on: the browser skips display:none and
// visibility:hidden, so the ends of the loop must skip them too.
const tabbable = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(
  (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');

/**
 * Keep Tab and Shift+Tab inside `ref` while it is mounted.
 *
 * The player is an aria-modal dialog over the title page, but Tab walked out
 * of it into the cast and the cards behind (measured on chtrm2 at 1280x720 TV:
 * 25 of 25 presses landed outside). Arrow keys are scoped by lib/dpad.js;
 * this covers Tab only, and only at the two ends of the loop.
 */
export default function useFocusTrap(ref) {
  useEffect(() => {
    const onKey = (e) => {
      const root = ref.current;
      if (e.key !== 'Tab' || !root) return;
      const items = tabbable(root);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const a = document.activeElement;
      if (!root.contains(a)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [ref]);
}
