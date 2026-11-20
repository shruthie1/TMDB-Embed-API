'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Card, CardSkeleton } from './Card';
import Icon from './Icon';

/**
 * A horizontal rail.
 *
 * Renders skeletons of the expected count while loading, so the row occupies
 * its final height immediately (no layout shift). On pointer devices wide
 * enough for it, the wrapper exposes a subtle edge fade while more content is
 * available. Scrolling stays native: touch, trackpad, mouse wheel and TV
 * D-pad focus all use the same rail.
 */
export function Row({ label, titles, loading, skeletonCount = 10, href, emptyHint,
  error, onRetry, homeSection = false, ranked = false }) {
  const railRef = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // The fade reflects real scroll position and disappears at the end of a row.
  const measure = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 });
  }, []);

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
  }, [measure, titles, loading]);

  // Small pointer/remote affordance for larger screens. Touch devices keep
  // the cleaner gesture-only rail.
  const page = (direction) => {
    const el = railRef.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.92, behavior: 'smooth' });
  };

  const empty = !loading && (!titles || titles.length === 0);
  if (empty && !emptyHint) return null;

  return (
    <section className={`row-sec${homeSection ? ' home-row' : ''}`}>
      <div className="row-head">
        <h2 className="row-label">{label}</h2>
        {href && !empty && (
          <Link href={href} className="see-all focusable" data-focus="">See all</Link>
        )}
      </div>

      {error ? (
        <div className="row-error" role="status">
          <span>Couldn’t load this section.</span>
          {onRetry && <button type="button" className="row-retry focusable" data-focus=""
                              onClick={onRetry}>Retry</button>}
        </div>
      ) : empty ? (
        <p className="row-empty">{emptyHint}</p>
      ) : (
        <div className={`rail-wrap${edges.left ? ' has-left' : ''}${edges.right ? ' has-right' : ''}`}>
          {edges.left && (
            <button className="rail-mini-arrow left" type="button"
                    aria-label={`Scroll ${label} left`} onClick={() => page(-1)}>
              <Icon name="chevron" size={14} className="flip" />
            </button>
          )}
          <div className="rail" role="list" data-rail="" ref={railRef}>
            {loading
              ? Array.from({ length: skeletonCount }, (_, i) => <CardSkeleton key={i} i={i} />)
              : titles.map((t, i) => (
                  <Card key={`${t.mediaType}-${t.tmdbId}`} title={t} i={i}
                        progressPct={t.progressPct} rank={ranked ? i + 1 : null} />
                ))}
          </div>
          {edges.right && (
            <button className="rail-mini-arrow right" type="button"
                    aria-label={`Scroll ${label} right`} onClick={() => page(1)}>
              <Icon name="chevron" size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
