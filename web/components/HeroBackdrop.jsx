'use client';
import { useEffect, useState } from 'react';
import { heroBackdrop } from '../lib/api';

/** Phones get w1280, everything else `original` (matches the .page-backdrop media rule). */
export function backdropUrl(path, narrow) {
  return path ? heroBackdrop(path, narrow) : null;
}

/**
 * The detail page's one backdrop element. It mounts with the skeleton and
 * stays mounted when the data lands, so the art never unmounts and repaints.
 *
 * A new image is preloaded and swapped in only once it has decoded; until
 * then the previous one stays on screen. Before this the skeleton and the
 * page were separate elements and the fast record (Cinemeta backdrop) and
 * full record (TMDB backdrop) had different urls, so the hero went dark twice
 * on a cold load (measured 2026-11-20, movie/811941 on TV).
 */
export default function HeroBackdrop({ path }) {
  const [shown, setShown] = useState(null);
  // The first image failed and nothing is on screen: stop the shimmer.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path) return undefined;
    const narrow = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(max-width:719px)').matches : false;
    const url = backdropUrl(path, narrow);
    let alive = true;
    const img = new Image();
    // The backdrop is the page's LCP. A script-made Image starts at low
    // priority and lost the phone's bandwidth to the posters and cast photos.
    img.fetchPriority = 'high';
    const show = () => { if (alive) setShown(url); };
    img.onload = () => {
      // decode() so the swap paints a ready bitmap, not a blank frame.
      if (typeof img.decode === 'function') img.decode().then(show, show);
      else show();
    };
    img.onerror = () => { if (alive) setFailed(true); };
    img.src = url;
    return () => { alive = false; img.onload = null; img.onerror = null; };
  }, [path]);

  const loading = !shown && !failed;
  return (
    <div
      className={`hero-art page-backdrop${loading ? ' skel' : ''}`}
      aria-hidden="true"
      data-src={shown || undefined}
      style={shown ? { '--bg-lg': `url(${shown})`, '--bg-sm': `url(${shown})` } : undefined}
    />
  );
}
