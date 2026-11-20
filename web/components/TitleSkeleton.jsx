'use client';
import { useRouter } from 'next/navigation';
import { Skeleton } from './ui';
import { CastRowSkeleton } from './CastRow';
import { Row } from './Row';
import Icon from './Icon';

/**
 * Stands in for the title page until its data lands. Same markup and classes
 * as the loaded page (Back, the backdrop, poster, title, meta, synopsis,
 * actions, Cast, More like this), each text bar inside the real element, so
 * every block sits where the loaded one will and nothing moves on arrival.
 */
export default function TitleSkeleton({ onBack }) {
  const router = useRouter();
  return (
    <div className="detail title-skeleton" aria-busy="true" aria-label="Loading title">
      {/* The real Back: it works before the data arrives, and the page below
          it starts at the same offset as the loaded one. */}
      <button type="button" className="detail-back focusable" data-focus="" onClick={onBack || (() => router.back())} aria-label="Go back">
        <Icon name="back" size={16} />
        <span>Back</span>
      </button>
      <div className="hero">
        {/* .page-backdrop, as on the loaded hero: without it main gains the
            header's top padding and the page dropped when data landed. */}
        <Skeleton className="hero-art page-backdrop" />
        <div className="hero-inner">
          <Skeleton className="hero-poster" />
          <div className="hero-text">
            <h1 className="detail-title"><span className="skel skel-line" style={{ width: '56%' }} /></h1>
            <div className="detail-meta">
              <span><span className="skel skel-line" style={{ width: '12em' }} /></span>
              <span><span className="badge skel skel-ghost">English</span></span>
            </div>
            <p className="detail-overview">
              <span className="skel skel-line" style={{ width: '100%' }} />
              <span className="skel skel-line" style={{ width: '94%' }} />
              <span className="skel skel-line" style={{ width: '62%' }} />
            </p>
            {/* Same class as the real "Read more", so it shows exactly where
                that one does (phones) and nowhere else. */}
            <span className="detail-overview-toggle"><span className="skel skel-line" style={{ width: '5em' }} /></span>
          </div>
          <div className="hero-actions">
            <div className="actions">
              <span className="btn primary skel skel-btn" style={{ width: '8em' }} />
              <span className="btn skel skel-btn" style={{ width: '8em' }} />
            </div>
          </div>
        </div>
      </div>
      <CastRowSkeleton />
      <Row label="More like this" titles={[]} loading />
    </div>
  );
}
