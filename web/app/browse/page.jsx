'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardSkeleton } from '../../components/Card';
import { FilterBar, FilterPanel } from '../../components/Filters';
import { Button, EmptyState, ErrorState, Skeleton } from '../../components/ui';

const nums = (v) => (v || '').split(',').filter(Boolean).map(Number);
const strs = (v) => (v || '').split(',').filter(Boolean);

/** URL is the source of truth, so a filtered view is shareable and Back works. */
function readFilters(sp) {
  return {
    type: sp.get('type') === 'tv' ? 'tv' : 'movie',
    langs: strs(sp.get('lang')),
    genres: nums(sp.get('genre')),
    decade: sp.get('decade') || null,
    minRating: sp.get('min') ? Number(sp.get('min')) : null,
    sort: sp.get('sort') || 'popularity.desc',
  };
}

function toQuery(f, page) {
  const q = new URLSearchParams();
  if (f.type !== 'movie') q.set('type', f.type);
  if (f.langs.length) q.set('lang', f.langs.join(','));
  if (f.genres.length) q.set('genre', f.genres.join(','));
  if (f.decade) q.set('decade', f.decade);
  if (f.minRating) q.set('min', String(f.minRating));
  if (f.sort !== 'popularity.desc') q.set('sort', f.sort);
  if (page && page > 1) q.set('page', String(page));
  return q;
}

function Browse() {
  const router = useRouter();
  const sp = useSearchParams();
  const f = readFilters(sp);

  const [state, setState] = useState({ loading: true, titles: [], total: 0, totalPages: 1, error: null });
  const [page, setPage] = useState(Number(sp.get('page') || 1));
  const [panel, setPanel] = useState(false);

  const setFilters = useCallback((next) => {
    setPage(1);
    router.replace(`/browse?${toQuery(next, 1)}`, { scroll: false });
  }, [router]);

  // Paging is part of the view: reloading or sharing a url must land where you
  // were, not back at page 1. `replace` rather than `push` so Back leaves
  // /browse instead of walking every page you loaded.
  const loadMore = useCallback(() => {
    const next = page + 1;
    setPage(next);
    router.replace(`/browse?${toQuery(f, next)}`, { scroll: false });
  }, [router, f, page]);

  const key = toQuery(f, page).toString();

  const loadedRef = useRef(0);
  const fRef = useRef(f);
  fRef.current = f;

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true, error: null }));

    const cur = fRef.current;
    const apiFor = (pg) => {
      const api = new URLSearchParams(toQuery(cur, pg).toString());
      // decade -> explicit from/to, so the API stays dumb about presentation
      if (cur.decade) {
        const [from, to] = cur.decade.split('-');
        api.delete('decade'); api.set('from', from); api.set('to', to);
      }
      api.set('type', cur.type);
      api.set('page', String(pg));
      return api;
    };

    // Arriving cold on ?page=3 must show pages 1..3, not page 3 alone with an
    // empty grid above it. Clicking Load more fetches only the new page.
    const fresh = loadedRef.current === 0 || page <= loadedRef.current;
    const pages = fresh ? Array.from({ length: page }, (_, i) => i + 1) : [page];

    Promise.all(pages.map(pg => fetch(`/api/discover?${apiFor(pg)}`).then(r => r.json())))
      .then(results => {
        if (!alive) return;
        loadedRef.current = page;
        const incoming = results.flatMap(d => d.titles || []);
        const last = results[results.length - 1] || {};
        setState(s => {
          // Paging can repeat a title across pages; dedupe or React sees
          // duplicate keys and may drop rows.
          const merged = fresh ? incoming : [...s.titles, ...incoming];
          const seen = new Set();
          const titles = merged.filter(t => {
            const k = `${t.mediaType}-${t.tmdbId}`;
            if (seen.has(k)) return false;
            seen.add(k); return true;
          });
          return {
            loading: false, error: null, titles,
            total: last.totalResults, totalPages: last.totalPages,
          };
        });
      })
      .catch(() => alive && setState(s => ({ ...s, loading: false, error: 'Could not load titles.' })));
    return () => { alive = false; };
  }, [key, page]);

  const hasMore = page < state.totalPages;

  return (
    <div className="browse">
      <div className="browse-head">
        <h1 className="page-title">Browse</h1>
        <Button icon="filters" onClick={() => setPanel(true)} className="filter-trigger">Filters</Button>
      </div>

      <FilterBar f={f} set={setFilters} count={state.loading && page === 1 ? null : state.total} />

      {state.error ? (
        <ErrorState hint={state.error} onRetry={() => setPage(p => p)} />
      ) : (
        <>
          <div className="grid-titles" data-focus-group="">
            {state.titles.map((t, i) => (
              <Card key={`${t.mediaType}-${t.tmdbId}`} title={t} i={i % 20} showType />
            ))}
            {state.loading && Array.from({ length: page > 1 ? 6 : 18 }, (_, i) => (
              <CardSkeleton key={`s${i}`} i={i} />
            ))}
          </div>

          {!state.loading && state.titles.length === 0 && (
            <EmptyState
              icon="search"
              title="No titles match those filters"
              hint="Try removing a filter, or widen the decade."
              action={<Button onClick={() => setFilters({ ...f, langs: [], genres: [], decade: null, minRating: null })}>Clear filters</Button>}
            />
          )}

          {hasMore && !state.loading && (
            <div className="load-more">
              <Button onClick={loadMore} icon="chevron">Load more</Button>
            </div>
          )}
        </>
      )}

      <FilterPanel f={f} set={setFilters} open={panel} onClose={() => setPanel(false)} count={state.total} />
    </div>
  );
}

function BrowseSkeleton() {
  return (
    <div className="browse" aria-busy="true" aria-label="Loading browse">
      <div className="browse-head">
        <Skeleton variant="text" width={126} height="2.2em" />
        <Skeleton width={94} height={40} />
      </div>
      <div className="filterbar browse-skel-filters">
        <div className="chips">
          <Skeleton width={74} height={32} /><Skeleton width={70} height={32} />
          <Skeleton width={106} height={32} /><Skeleton width={86} height={32} />
        </div>
        <Skeleton width={116} height={34} />
      </div>
      <div className="grid-titles" data-focus-group="">
        {Array.from({ length: 18 }, (_, i) => <CardSkeleton key={i} i={i} />)}
      </div>
    </div>
  );
}

export default function BrowsePage() {
  return (
    <Suspense fallback={<BrowseSkeleton />}>
      <Browse />
    </Suspense>
  );
}
