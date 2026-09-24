'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { initDpad, isTv } from '../lib/dpad';

/** Enables remote-control navigation and 10-foot sizing on TV devices. */
export default function Dpad() {
  const pathname = usePathname();

  useEffect(() => {
    const teardown = initDpad();
    if (isTv()) document.documentElement.dataset.tv = 'true';
    return teardown;
  }, []);

  /**
   * Every route starts at the top.
   *
   * history.scrollRestoration defaults to 'auto', so the browser restores the
   * previous offset - a detail page opened after scrolling a rail, or reached
   * by Back, arrived part-way down with the title off screen (measured: 3029px
   * down from a home-page rail). Nothing in the app reset it.
   *
   * 'manual' stops the browser guessing; the explicit scroll covers a
   * client-side route change, where there is no page load to reset anything.
   */
  useEffect(() => {
    try { history.scrollRestoration = 'manual'; } catch { /* unsupported */ }
  }, []);

  useEffect(() => {
    /**
     * Hold the top for a moment, not just once on arrival.
     *
     * A single reset loses a race that only shows on a slower device: the
     * detail page paints short, the browser or the framework restores a
     * previous offset, and THEN the cast row and similar-titles grid land and
     * make the page tall enough for that offset to be valid. By the time the
     * content exists, the scroll has already happened.
     *
     * So it re-asserts the top while the page settles, and stops the moment
     * the viewer scrolls deliberately - otherwise it would fight them.
     *
     * Instant, not smooth: this is a new page, not a movement within one, and
     * a TV animating a long scroll on arrival reads as a glitch.
     */
    let cancelled = false;
    const top = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    top();

    // A real scroll gesture ends it. `wheel`/`touchstart`/`keydown` are the
    // viewer's own intent; a programmatic scroll fires none of them.
    const stop = () => { cancelled = true; };
    ['wheel', 'touchstart', 'keydown'].forEach(n =>
      window.addEventListener(n, stop, { passive: true, once: true }));

    // Cheap: a handful of frames over ~600ms, which covers the late content
    // without pinning the page for long enough to be felt.
    let n = 0;
    const id = setInterval(() => {
      if (cancelled || ++n > 6) { clearInterval(id); return; }
      if (window.scrollY !== 0) top();
    }, 100);

    return () => {
      clearInterval(id);
      ['wheel', 'touchstart', 'keydown'].forEach(n2 =>
        window.removeEventListener(n2, stop));
    };
  }, [pathname]);

  return null;
}
