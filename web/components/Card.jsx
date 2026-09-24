'use client';
import Link from 'next/link';
import { useState } from 'react';
import { poster } from '../lib/api';
import { intentProps } from '../lib/prefetch';

/**
 * Skeleton is the SAME shape as the card, so nothing shifts when data lands.
 *
 * It uses the card's OWN classes for the text block rather than free-standing
 * bars. Hand-matched heights drifted: measured before this, the skeleton was
 * 12px shorter than the card on a phone, 16px on a laptop and 24px on a TV, so
 * every grid jumped as the data arrived. .card-title reserves two clamped
 * lines and .card-meta reserves one; borrowing them means the two cannot
 * diverge again when either is restyled.
 */
export function CardSkeleton({ i = 0 }) {
  return (
    <div className="card" style={{ '--i': i }} aria-hidden="true">
      <div className="skel skel-poster" />
      {/* ONE bar: .card-title is white-space:nowrap with a single clamped
          line, so a second bar was clipped rather than measured. */}
      <div className="card-title">
        <span className="skel skel-line" style={{ width: '84%' }} />
      </div>
      <div className="card-meta">
        <span className="skel skel-line" style={{ width: '40%' }} />
      </div>
      {/* The real card always ends with .prog or .rule; without one here the
          skeleton stayed 4-5px short and the grid still nudged on load. */}
      <div className="rule" />
    </div>
  );
}

export function Card({ title, i = 0, progressPct, showType = false }) {
  const epTag = title.mediaType === 'tv' && title.episode
    ? `S${title.season}E${title.episode}` : null;
  // Browse and search mix films and series in one grid; without this a series
  // is indistinguishable from a film until you open it.
  const typeTag = showType && title.mediaType === 'tv' ? 'Series' : null;
  const src = poster(title.poster, 'w342');
  const [imageFailed, setImageFailed] = useState(false);
  const meta = [title.year, title.runtimeMin ? `${title.runtimeMin} min` : null]
    .filter(Boolean).join(' · ');

  return (
    <Link
      href={`/title/${title.mediaType}/${title.tmdbId}`}
      className="card focusable enter"
      data-focus=""
      style={{ '--i': i }}
      aria-label={`${title.title}${typeTag ? ', series' : ''}${epTag ? `, ${epTag}` : ''}${title.year ? `, ${title.year}` : ''}`}
      // Resolve in the background once intent is sustained, so the click
      // usually lands on a warm cache instead of a 6-37s cold resolve.
      {...intentProps(title.mediaType, title.tmdbId,
                      { season: title.season, episode: title.episode })}
    >
      <div className="poster">
        {src && !imageFailed
          ? <img src={src} alt="" loading="lazy" decoding="async" width="342" height="513"
              onError={() => setImageFailed(true)} />
          : <span className="poster-fallback">{title.title}</span>}
        {typeTag && <span className="card-type">{typeTag}</span>}
      </div>
      <div className="card-title">{title.title}</div>
      {/* Always rendered, even when empty: a card WITHOUT a meta line (a film
          with no year) sat shorter than one with an episode tag beside it, so
          the progress bars in a row landed at different heights. Reserving the
          slot keeps every card in a row the same shape. */}
      <div className="card-meta">
        {epTag
          ? <><b>{epTag}</b>{title.epTitle ? ` · ${title.epTitle}` : ''}</>
          : meta}
      </div>
      {progressPct > 0
        ? <div className="prog" aria-label={`${Math.round(progressPct)}% watched`}>
            <i style={{ width: `${progressPct}%` }} />
          </div>
        : <div className="rule" />}
    </Link>
  );
}
