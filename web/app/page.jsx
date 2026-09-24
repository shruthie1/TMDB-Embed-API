'use client';
import { Fragment, useEffect, useState } from 'react';
import { Row } from '../components/Row';
import Hero from '../components/Hero';
import { fetchRow, fetchTitleFull } from '../lib/api';
import { getContinueWatching, getSeeds } from '../lib/progress';
import { getList } from '../lib/list';
import { warmContinueWatching } from '../lib/prefetch';

// `href` gives each row a "See all" into the equivalent browse view, so a
// rail is an entry point rather than a dead end capped at 18 titles.
// Ordered as a MIX rather than by category: what is NEW leads the discovery
// rails, then Indian trending (the hero and the household's default), then the
// global rows and the per-language rails. Five language rows in a block read as
// one long Indian section and pushed everything else off the page; interleaving
// them means scrolling always turns up something different.
//
// 'recent' leads because a personal library's freshest additions are the reason
// to open the app at all - buried last, anything newly added was never seen.
// The two PERSONAL rails still sit above it: continue-watching is how you
// resume, and making someone scroll past a discovery row to reach a half-
// watched film is a worse trade than a slightly later 'new'.
//
// 'series' sits last because this is a movie household - measured on the live
// cache, movies take 473 rows / 627 hits / 45 plays against TV's 37 / 34 / 4.
// A series rail third was spending prime vertical space on 8% of the watching.
const ROWS = [
  { kind: 'continue',     label: 'Continue watching' },
  { kind: 'list',         label: 'My list', href: '/list' },
  { kind: 'recent',       label: 'Recently added',
    href: '/browse?sort=primary_release_date.desc' },
  { kind: 'trending',     label: 'Trending in India', href: '/browse?sort=popularity.desc' },
  { kind: 'te',           label: 'Telugu',    href: '/browse?lang=te' },
  { kind: 'ta',           label: 'Tamil',     href: '/browse?lang=ta' },
  { kind: 'kn',           label: 'Kannada',   href: '/browse?lang=kn' },
  { kind: 'ml',           label: 'Malayalam', href: '/browse?lang=ml' },
  { kind: 'series',       label: 'Indian series',
    href: '/browse?type=tv&lang=te,ta,kn,ml,hi' },
];

export default function Home() {
  // Each row owns its loading state, so rows appear as they arrive
  // instead of the page blocking on the slowest one.
  const [data, setData] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  // Personalised rows, derived from what has actually been watched. Kept
  // separate from ROWS because their labels and count depend on history.
  const [recs, setRecs] = useState([]);

  useEffect(() => {
    let alive = true;
    const cw = getContinueWatching(3);
    setData(d => ({ ...d, continue: cw, list: getList() }));

    // Season lists let the rail respect season/series boundaries (S1E7 ->
    // S2E1, and a finished show drops off). Fetched only for shows already
    // on the rail, and these records are cached server-side.
    const shows = [...new Set(cw.filter(p => p.mediaType === 'tv').map(p => p.tmdbId))];
    if (shows.length) {
      Promise.all(shows.map(id =>
        fetchTitleFull('tv', id)
          .then(r => (r.ok ? [id, r.body.seasonList] : null))
          .catch(() => null)))
        .then(pairs => {
          const map = Object.fromEntries(pairs.filter(Boolean));
          if (Object.keys(map).length) {
            setData(d => ({ ...d, continue: getContinueWatching(3, map) }));
          }
        });
    }
    // The most likely next play is whatever you were last watching.
    warmContinueWatching(cw);
    // "Because you watched X" - ONE row, for the most recent thing watched.
    // Two rows pushed the discovery rails (Telugu, Tamil, ...) below the fold
    // and read as repetition, since recent history is usually similar titles.
    const seeds = getSeeds(1);
    if (seeds.length) {
      Promise.all(seeds.map(sd =>
        fetch(`/api/similar/${sd.mediaType}/${sd.tmdbId}`)
          .then(r => (r.ok ? r.json() : null))
          .then(d => (d?.titles?.length
            ? { key: `rec-${sd.mediaType}-${sd.tmdbId}`,
                label: `Because you watched ${sd.title}`, titles: d.titles }
            : null))
          .catch(() => null)))
        .then(rows => { if (alive) setRecs(rows.filter(Boolean)); });
    }

    for (const { kind } of ROWS) {
      if (kind === 'continue' || kind === 'list') continue;
      fetchRow(kind).then(res => {
        if (!alive) return;
        const titles = res.ok ? (res.body?.titles || []) : [];
        setRowErrors(errors => ({
          ...errors,
          [kind]: res.ok ? null : (res.error || `Request failed${res.status ? ` (${res.status})` : ''}`),
        }));
        if (process.env.NODE_ENV !== 'production') {
          console.info('[chitram home] row', kind, {
            ok: res.ok,
            status: res.status,
            count: titles.length,
            error: res.error || res.body?.error || null,
          });
        }
        setData(d => ({ ...d, [kind]: titles }));
      });
    }
    return () => { alive = false; };
  }, []);

  const retryRow = (kind) => {
    setRowErrors(errors => ({ ...errors, [kind]: null }));
    fetchRow(kind).then(res => {
      const titles = res.ok ? (res.body?.titles || []) : [];
      setData(dataNow => ({ ...dataNow, [kind]: titles }));
      setRowErrors(errors => ({
        ...errors,
        [kind]: res.ok ? null : (res.error || `Request failed${res.status ? ` (${res.status})` : ''}`),
      }));
    });
  };

  // Returning viewers lead the carousel with unfinished titles. Trending fills
  // the remaining slots so one Continue Watching item never collapses the
  // hero into a static banner.
  const heroTitles = data.continue === undefined || data.trending === undefined
    ? undefined
    : [...(data.continue || []), ...(data.trending || [])]
      // Continue-watching entries are intentionally lightweight local records
      // and usually have no backdrop. Filter before limiting the pool, or
      // three such records would consume all hero slots and leave no trending
      // title available to render.
      .filter(title => title.backdrop)
      .filter((title, index, all) => all.findIndex(other =>
        other.mediaType === title.mediaType && other.tmdbId === title.tmdbId
      ) === index)
      .slice(0, 3);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.info('[chitram home] hero', {
        continueCount: data.continue?.length,
        trendingCount: data.trending?.length,
        loading: heroTitles === undefined,
        titles: heroTitles?.map(t => ({ id: t.tmdbId, title: t.title, backdrop: t.backdrop })) || [],
      });
    }
  }, [data.continue, data.trending, heroTitles]);

  // Which row the suggestions follow. Continue watching when it exists (what
  // to play next belongs beside where you left off); otherwise the first
  // discovery row, so they never sink below everything else.
  const recAnchor = data.continue?.length ? 'continue' : 'trending';

  return (
    <div className="home-page">
      <Hero titles={heroTitles || []} loading={heroTitles === undefined} />

      {ROWS.map(({ kind, label, href }) => {
        const titles = data[kind];
        // Continue-watching is local and instant; hide it when empty
        // rather than showing an empty rail.
        // Local rows are instant; hide them when empty rather than showing
        // an empty rail or a skeleton that never fills.
        if ((kind === 'continue' || kind === 'list') && (!titles || titles.length === 0)) return null;
        return (
          <Fragment key={kind}>
            <Row
              label={label}
              href={href}
              titles={titles || []}
              loading={titles === undefined}
              error={rowErrors[kind]}
              onRetry={() => retryRow(kind)}
              homeSection
            />
            {/* Suggestions sit directly under Continue watching: what to play
                next belongs beside where you left off, above the generic
                discovery rows. With no history they anchor to the first
                discovery row instead, never to the bottom of the page. */}
            {kind === recAnchor && recs.map(r => (
              <Row key={r.key} label={r.label} titles={r.titles} homeSection />
            ))}
          </Fragment>
        );
      })}


    </div>
  );
}
