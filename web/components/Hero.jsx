'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { poster } from '../lib/api';
import { Badge, Skeleton } from './ui';
import { inList, toggleList } from '../lib/list';
import { languageName } from '../lib/subtitles';

/** Auto-advance interval. Must match --hero-rotate in app/tokens.css. */
const ROTATE_MS = 8000;

/**
 * Rotating hero. Pauses on hover/focus and under reduced-motion, so it never
 * yanks the page out from under someone mid-read.
 */
export default function Hero({ titles = [], loading }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [saved, setSaved] = useState(false);
  const swipeStart = useRef(null);
  // Six, like the spotlight carousels on Netflix, Prime Video and JioHotstar.
  const pool = titles.filter(t => t.backdrop).slice(0, 6);
  const current = pool[i % pool.length];
  const move = (direction) => setI(v => (v + direction + pool.length) % pool.length);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.info('[chitram hero] render', {
        loading,
        received: titles.length,
        withBackdrop: pool.length,
        titles: titles.map(t => ({ id: t.tmdbId, title: t.title, backdrop: t.backdrop })),
      });
    }
  }, [loading, titles, pool.length]);

  // Saved state belongs to the title on screen, so it must follow rotation.
  useEffect(() => {
    if (current) setSaved(inList(current.mediaType, current.tmdbId));
  }, [current]);

  useEffect(() => {
    if (paused || pool.length < 2) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // One timer per slide, restarted on every change (auto or a tapped bar), so
    // the active indicator's fill (--hero-rotate in tokens.css) stays in step.
    const id = setTimeout(() => setI(v => (v + 1) % pool.length), ROTATE_MS);
    return () => clearTimeout(id);
  }, [paused, pool.length, i]);

  if (loading) {
    return (
      <div className="home-hero" aria-hidden="true">
        <Skeleton className="home-hero-art" />
        <div className="home-hero-in home-hero-skel-in">
          <Skeleton variant="text" width="62%" height="3.8em" />
          <div className="detail-meta"><Skeleton variant="text" width={180} /></div>
          <Skeleton variant="text" width="92%" style={{ marginTop: 18 }} />
          <Skeleton variant="text" width="78%" style={{ marginTop: 8 }} />
          <Skeleton width={150} height={46} style={{ marginTop: 26 }} />
        </div>
      </div>
    );
  }
  if (!pool.length) return null;

  const t = pool[i % pool.length];
  const meta = [t.year, t.rating ? `★ ${Number(t.rating).toFixed(1)}` : null].filter(Boolean);

  return (
    <section
      className="home-hero"
      data-paused={paused || undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onPointerDown={e => { swipeStart.current = { x: e.clientX, y: e.clientY }; setPaused(true); }}
      onPointerUp={e => {
        const start = swipeStart.current;
        swipeStart.current = null;
        if (!start || pool.length < 2) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.2) move(dx < 0 ? 1 : -1);
        setPaused(false);
      }}
      onPointerCancel={() => { swipeStart.current = null; setPaused(false); }}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
      }}
      aria-label="Featured"
      aria-roledescription="carousel"
    >
      <div className="home-hero-art page-backdrop" key={t.tmdbId}
           style={{ '--bg-lg': `url(${poster(t.backdrop, 'w1280')})`, '--bg-sm': `url(${poster(t.backdrop, 'w780')})` }}
           aria-hidden="true" />
      <div className="home-hero-in">
        <h1 className="home-hero-title">{t.title}</h1>
        <div className="detail-meta">
          {meta.map((m, k) => <span key={k}>{m}</span>)}
          {t.originalLang && <span><Badge>{languageName(t.originalLang)}</Badge></span>}
        </div>
        {t.overview && <p className="home-hero-overview">{t.overview}</p>}
        <div className="actions" data-focus-group="">
          {/* This navigates to the title page; playback starts there. Calling
              it "Play" promised something the click does not do. */}
          <Link href={`/title/${t.mediaType}/${t.tmdbId}`}
                className="btn primary focusable" data-focus=""
                aria-label={`Open ${t.title}`}>
            <svg className="ico" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M6 4v16l14-8z" />
            </svg>
            Watch now
          </Link>
          <button className="btn focusable" data-focus=""
                  aria-pressed={saved}
                  onClick={() => { setSaved(toggleList(t)); }}>
            {saved ? 'In My List' : '+ My List'}
          </button>
        </div>
      </div>
      {/* Outside the text column, so it centres on the whole hero. */}
      {pool.length > 1 && (
        <div className="hero-controls">
          <div className="hero-dots" role="tablist" aria-label="Featured titles">
            {pool.map((p, k) => (
              <button key={p.tmdbId} className={`hero-dot ${k === i ? 'on' : ''}`}
                      aria-label={`Show ${p.title}`} aria-selected={k === i} role="tab"
                      onClick={() => setI(k)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
