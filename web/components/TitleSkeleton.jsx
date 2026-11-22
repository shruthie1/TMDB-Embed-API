'use client';
import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { posterSources } from '../lib/posterSources';
import { peekSeed } from '../lib/titleSeed';
import { Skeleton } from './ui';
import { CastRowSkeleton } from './CastRow';
import { EpisodeListSkeleton } from './EpisodeList';
import { Row } from './Row';
import HeroBackdrop from './HeroBackdrop';
import Icon from './Icon';

/**
 * The hero's poster, text and actions while the title loads. Each text bar
 * sits inside the real element (title, tagline, meta, synopsis, Read more),
 * so every block takes the box the loaded one will. The tagline line, three
 * synopsis lines and the Read more line are reserved on desktop and TV
 * (globals.css), so the loaded hero does not grow or shrink on arrival.
 */
export function HeroInnerSkeleton({ seed = null }) {
  return (
    <div className="hero-inner">
      {seed?.poster ? <SeedPoster seed={seed} /> : <Skeleton className="hero-poster" />}
      <div className="hero-text">
        <h1 className="detail-title">
          {seed?.title || <span className="skel skel-line" style={{ width: '56%' }} />}
        </h1>
        <p className="tagline"><span className="skel skel-line" style={{ width: '32%' }} /></p>
        <div className="detail-meta">
          {seed?.year && <span>{seed.year}</span>}
          <span><span className="skel skel-line" style={{ width: seed?.year ? '8em' : '12em' }} /></span>
          <span><span className="badge skel skel-ghost">English</span></span>
        </div>
        <p className="detail-overview">
          <span className="skel skel-line" style={{ width: '100%' }} />
          <span className="skel skel-line" style={{ width: '94%' }} />
          <span className="skel skel-line" style={{ width: '62%' }} />
        </p>
        {/* Same class as the real "Read more", so it takes its line. */}
        <span className="detail-overview-toggle"><span className="skel skel-line" style={{ width: '5em' }} /></span>
      </div>
      <div className="hero-actions">
        <div className="actions">
          <span className="btn primary skel skel-btn" style={{ width: '8em' }} />
          <span className="btn skel skel-btn" style={{ width: '8em' }} />
        </div>
      </div>
    </div>
  );
}

/**
 * The tapped card's poster: the exact url the card showed (already in the
 * browser cache), else the detail poster url the page will load anyway.
 */
function SeedPoster({ seed }) {
  const [src] = useState(() => seed.posterSrc || posterSources(seed)[0]);
  const [loading, setLoading] = useState(!seed.posterSrc);
  return (
    <div className={`hero-poster${loading ? ' loading' : ''}`}>
      <img src={src} alt="" width="342" height="513" decoding="async" fetchpriority="high"
           ref={img => { if (img?.complete && img.naturalWidth) setLoading(false); }}
           onLoad={() => setLoading(false)} onError={() => setLoading(false)} />
    </div>
  );
}

/** The seed for this route, read on the client only (see lib/titleSeed.js). */
export function useTitleSeed(type, id) {
  return peekSeed(type, id);
}

/** The facts grid at the foot of the page, until the full record lands. */
export function FactsSkeleton() {
  return (
    <div className="facts" aria-hidden="true">
      {['5em', '6em', '6em', '5em'].map((w, i) => (
        <div className="fact" key={i}>
          <span className="k"><span className="skel skel-line" style={{ width: w }} /></span>
          <span className="v"><span className="skel skel-line" style={{ width: '70%' }} /></span>
        </div>
      ))}
    </div>
  );
}

/**
 * The route's loading boundary (loading.jsx). Same markup and classes as the
 * title page in its own loading state (page.jsx), including the Episodes
 * block for a series, so the swap between the two moves nothing.
 */
export default function TitleSkeleton({ onBack }) {
  const router = useRouter();
  const params = useParams();
  const seed = useTitleSeed(params?.type, params?.id);
  return (
    <article className="detail title-skeleton" aria-busy="true" aria-label="Loading title">
      <button type="button" className="detail-back focusable" data-focus="" onClick={onBack || (() => router.back())} aria-label="Go back">
        <Icon name="back" size={16} />
        <span>Back</span>
      </button>
      <div className="hero">
        <HeroBackdrop path={seed?.backdrop || null} />
        <HeroInnerSkeleton seed={seed} />
      </div>
      {params?.type === 'tv' && <EpisodeListSkeleton />}
      <CastRowSkeleton />
      <Row label="More like this" titles={[]} loading />
      <FactsSkeleton />
    </article>
  );
}
