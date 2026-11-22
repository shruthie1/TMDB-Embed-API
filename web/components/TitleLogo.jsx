'use client';
import { useEffect, useState } from 'react';
import { fetchTitleFull, logoUrl } from '../lib/api';

/**
 * The hero title: the TMDB title logo when the title has one, else the text.
 * The text stays as the image's alt, so screen readers and a failed load
 * still read the title. A logo that fails to load falls back to the text.
 */
export default function TitleLogo({ title, logo }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [logo]);
  const src = !failed && logo ? logoUrl(logo) : null;
  if (!src) return title;
  return (
    <img className="title-logo" src={src} alt={title} decoding="async"
         onError={() => setFailed(true)} />
  );
}

/**
 * Logo path for a home-hero title. Row titles carry no logo, so this reads
 * the full record (the same /full url the title page opens next, edge-cached).
 * Returns undefined while loading, null when the title has none.
 */
export function useHeroLogo(t) {
  const key = t ? `${t.mediaType}/${t.tmdbId}` : null;
  const [logos, setLogos] = useState({});
  useEffect(() => {
    if (!t || t.logo !== undefined || key in logos) return undefined;
    const ctrl = new AbortController();
    fetchTitleFull(t.mediaType, t.tmdbId, { signal: ctrl.signal })
      // getJson shape: { ok, body }. Reading `.logo` off the wrapper was
      // always undefined, so the home hero never showed a logo.
      .then(r => setLogos(m => ({ ...m, [key]: (r?.ok && r.body?.logo) || null })))
      .catch(() => { if (!ctrl.signal.aborted) setLogos(m => ({ ...m, [key]: null })); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!t) return null;
  if (t.logo !== undefined) return t.logo;
  return logos[key];
}
