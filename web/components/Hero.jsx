'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { heroBackdrop } from '../lib/api';
import TitleLogo, { useHeroLogo } from './TitleLogo';
import { Badge, Skeleton } from './ui';
import { inList, toggleList } from '../lib/list';
import { languageName } from '../lib/subtitles';
import { isTv } from '../lib/dpad';
import { seedTitle } from '../lib/titleSeed';

/** Auto-advance interval. Must match --hero-rotate in app/tokens.css. */
const ROTATE_MS = 8000;

/** Same breakpoint as `.page-backdrop` --bg-sm in globals.css. */
function narrowScreen() {
  try { return window.matchMedia('(max-width:719px)').matches; } catch { return false; }
}

function focusVisible(el) {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

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

  // Row titles carry no logo; the full record has it (text title until then).
  const heroLogo = useHeroLogo(current);

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

  // The backdrop is a CSS background, which Chrome fetches at low priority,
  // so on a phone the row posters beat it to the bandwidth (LCP 5.4s on Slow
  // 4G). Ask for the slide on screen at high priority; the CSS then reuses it.
  const artUrl = current?.backdrop ? heroBackdrop(current.backdrop, narrowScreen()) : null;
  useEffect(() => {
    if (!artUrl) return;
    const img = new Image();
    img.fetchPriority = 'high';
    img.src = artUrl;
  }, [artUrl]);

  if (loading) {
    return (
      <div className="home-hero" aria-hidden="true">
        {/* .page-backdrop, as on the real hero: without it main gains the
            header's top padding and the whole page dropped when data landed. */}
        <Skeleton className="home-hero-art page-backdrop" />
        {/* The real hero's own classes, so each bar takes the line box of the
            text it stands in for (see CardSkeleton). */}
        <div className="home-hero-in home-hero-skel-in">
          <h1 className="home-hero-title"><span className="skel skel-line" style={{ width: '62%' }} /></h1>
          <div className="detail-meta"><span><span className="skel skel-line" style={{ width: '5em' }} /></span>
            <span><span className="badge skel skel-ghost">Telugu</span></span></div>
          <p className="home-hero-overview">
            <span className="skel skel-line" style={{ width: '92%' }} />
            <span className="skel skel-line" style={{ width: '78%' }} />
          </p>
          <div className="actions">
            <span className="btn primary skel skel-btn" style={{ width: '9.5em' }} />
            <span className="btn skel skel-btn" style={{ width: '8em' }} />
          </div>
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
      // A real mouse only: a phone tap fires mouseenter but usually no
      // mouseleave, and a tap's focus never blurs, so both used to pause the
      // carousel for good. Keyboard / D-pad focus still pauses it.
      onPointerEnter={e => { if (e.pointerType === 'mouse') setPaused(true); }}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setPaused(false); }}
      onFocusCapture={e => { if (isTv() || focusVisible(e.target)) setPaused(true); }}
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
        // TV: the remote must walk Watch now -> My List and leave the hero for
        // the side rail. Taking every Left/Right trapped focus here, because
        // dpad.js skips keys that are already defaultPrevented. So Left always
        // goes to dpad, and Right cycles only from the last button.
        if (isTv() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          const btns = [...e.currentTarget.querySelectorAll('.actions [data-focus]')];
          const at = btns.indexOf(document.activeElement);
          if (e.key === 'ArrowLeft' || (at >= 0 && at < btns.length - 1)) return;
        }
        if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
      }}
      aria-label="Featured"
      aria-roledescription="carousel"
    >
      <div className="home-hero-art page-backdrop" key={t.tmdbId}
           style={{ '--bg-lg': `url(${heroBackdrop(t.backdrop, false)})`, '--bg-sm': `url(${heroBackdrop(t.backdrop, true)})` }}
           aria-hidden="true" />
      <div className="home-hero-in">
        <h1 className={`home-hero-title${heroLogo ? ' has-logo' : ''}`}><TitleLogo title={t.title} logo={heroLogo} /></h1>
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
                aria-label={`Open ${t.title}`} onClick={() => seedTitle(t)}>
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
