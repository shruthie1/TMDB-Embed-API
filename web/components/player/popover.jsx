'use client';
import { useLayoutEffect } from 'react';

/**
 * Player sheet placement, ported from the APK (PlayerScreen.kt MenuPanel,
 * PlayerMenuLayout.kt, 1.2.15).
 *
 * Landscape with a known opener: a popover whose bottom edge sits 8px above
 * the button, centred on it and kept inside the screen, over a light 0.2
 * scrim. Without an opener (or in portrait, or on TV) the CSS layout stays:
 * portrait bottom sheet, TV side panel.
 */
export const POPOVER_GAP = 8;
export const SCRIM_ANCHORED = 0.2;
export const SCRIM_PLAIN = 0.4;

/** Screen margin, same as the APK: min(16, height / 16). */
export const popoverInset = (vh) => Math.min(16, vh / 16);

/**
 * Pure placement. `anchor` is the opener's rect, `size` the sheet's natural
 * width/height, `viewport` the screen. Returns left/top plus the height cap
 * that keeps the sheet between the top margin and the button.
 */
export function popoverPlacement(anchor, size, viewport, gap = POPOVER_GAP) {
  const margin = popoverInset(viewport.height);
  const bottom = Math.round(anchor.top - gap);
  const maxHeight = Math.max(0, Math.min(480, viewport.height - margin * 2, bottom - margin));
  const height = Math.min(size.height, maxHeight);
  const centre = anchor.left + anchor.width / 2;
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(Math.round(centre - size.width / 2), margin), maxLeft);
  const top = Math.max(Math.round(bottom - height), margin);
  return { left, top, maxHeight };
}

/** True when the APK would anchor: phone/desktop landscape, not TV. */
export function anchoredLayout() {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.dataset.tv === 'true') return false;
  return window.innerWidth > window.innerHeight;
}

/**
 * Places the open sheet above its opener. `ref` is the sheet; the opener is
 * the button that is the first child of the sheet's `.pmenu-wrap`. A sheet
 * inside the settings sheet (`.sheet-picks`) or outside the control bar (the
 * embed stage, whose buttons sit at the top) is left to the CSS.
 *
 * Position is `fixed`; any transformed ancestor would offset it, so the first
 * placement is measured and corrected by the difference.
 */
export function useAnchoredSheet(ref, deps) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = el.closest('.pmenu-wrap')?.querySelector(':scope > button');
    const usable = opener && el.closest('.pctl') && !el.closest('.sheet-picks');
    const place = () => {
      const on = Boolean(usable) && anchoredLayout();
      el.toggleAttribute('data-anchored', on);
      if (!on) { el.style.left = el.style.top = el.style.right = el.style.bottom = el.style.maxHeight = el.style.width = ''; return; }
      // Inline, so no docked-sheet rule (bottom/right offsets) can stretch it.
      el.style.right = 'auto'; el.style.bottom = 'auto';
      // Natural size: no CSS height cap while measuring (an inner list that
      // scrolls hides its overflow from the sheet's scrollHeight).
      el.style.maxHeight = 'none'; el.style.width = '';
      el.style.left = '0px'; el.style.top = '0px';
      const box = el.getBoundingClientRect();
      // The open animation translates the sheet; measure without it.
      const tf = getComputedStyle(el).transform;
      const t = typeof DOMMatrixReadOnly === 'function' && tf && tf !== 'none' ? new DOMMatrixReadOnly(tf) : { e: 0, f: 0 };
      const origin = { left: box.left - t.e, top: box.top - t.f, width: el.offsetWidth };
      // Pin the measured width: at its final left a fixed box could shrink to fit and grow taller.
      el.style.width = `${origin.width}px`;
      const r = opener.getBoundingClientRect();
      const p = popoverPlacement(r, { width: origin.width, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      el.style.maxHeight = `${p.maxHeight}px`;
      el.style.left = `${p.left - origin.left}px`;
      el.style.top = `${p.top - origin.top}px`;
    };
    place();
    // Rows arrive and drill-downs change the content size: follow it.
    let last = '';
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const key = `${el.scrollWidth}x${el.scrollHeight}`;
      if (key !== last) { last = key; place(); }
    }) : null;
    ro?.observe(el);
    window.addEventListener('resize', place);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** The dim layer behind an open sheet. A tap on it closes the sheet. */
export function SheetScrim({ onClose }) {
  return (
    <div className="pmenu-scrim" aria-hidden="true" data-anchored={anchoredLayout() ? '' : undefined}
         onPointerDown={(e) => e.stopPropagation()}
         onClick={(e) => { e.stopPropagation(); onClose?.(); }} />
  );
}
