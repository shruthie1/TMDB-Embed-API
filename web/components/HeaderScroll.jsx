'use client';
import { useEffect } from 'react';

/**
 * Marks the header once the page scrolls past 24px, so it can turn solid, and
 * publishes its height as --header-h; sets --backdrop-reach on every
 * .page-backdrop (see globals.css).
 */
export default function HeaderScroll() {
  useEffect(() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      bar.toggleAttribute('data-scrolled', window.scrollY > 24);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    const root = document.documentElement;
    // Each .page-backdrop reaches up to y=0 by exactly the distance between
    // its box and the page top, so the image itself starts where its box does.
    const reach = () => {
      for (const el of document.querySelectorAll('.page-backdrop')) {
        const top = el.parentElement.getBoundingClientRect().top + window.scrollY;
        el.style.setProperty('--backdrop-reach', `${Math.max(0, Math.round(top))}px`);
        // The box too: the details hero sizes itself to end at the first
        // screen's bottom edge (globals.css, landscape details).
        el.parentElement.style.setProperty('--backdrop-reach', `${Math.max(0, Math.round(top))}px`);
      }
    };
    let mraf = 0;
    const measure = () => {
      mraf = 0;
      root.style.setProperty('--header-h', `${bar.offsetHeight}px`);
      reach();
    };
    const schedule = () => { if (!mraf) mraf = requestAnimationFrame(measure); };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(bar);
    // Pages mount their hero after client navigation and data loads.
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    mo?.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    measure();
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(mraf);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
  return null;
}
