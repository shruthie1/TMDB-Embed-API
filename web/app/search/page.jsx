'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardSkeleton } from '../../components/Card';
import { Chip, EmptyState, Button, Skeleton } from '../../components/ui';
import Icon from '../../components/Icon';
import { searchTitles } from '../../lib/api';
import { getRecent, addRecent, removeRecent, clearRecent } from '../../lib/recent';
import { abortReason } from '../../lib/abortReason';

const SUGGEST = [
  { label: 'Telugu', href: '/browse?lang=te' },
  { label: 'Tamil', href: '/browse?lang=ta' },
  { label: 'Kannada', href: '/browse?lang=kn' },
  { label: 'Action', href: '/browse?genre=28' },
  { label: 'Top rated', href: '/browse?sort=vote_average.desc' },
];

export default function Search() {
  const [q, setQ] = useState('');
  const [state, setState] = useState({ loading: false, titles: [], done: false });
  const [recent, setRecent] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    setRecent(getRecent());
  }, []);

  useEffect(() => {
    if (!q.trim()) { setState({ loading: false, titles: [], done: false }); return; }
    setState(s => ({ ...s, loading: true }));
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const res = await searchTitles(q, { signal: ctrl.signal });
      setState({ loading: false, titles: res.ok ? res.body.titles : [], done: true });
      // Only remember a query that actually found something.
      if (res.ok && res.body.titles?.length) { addRecent(q); setRecent(getRecent()); }
    }, 260); // debounce — instant-feel without hammering the API
    return () => { clearTimeout(t); ctrl.abort(abortReason('search superseded by newer query')); };
  }, [q]);

  const drop = useCallback((term) => { removeRecent(term); setRecent(getRecent()); }, []);

  const movies = state.titles.filter(t => t.mediaType === 'movie');
  const series = state.titles.filter(t => t.mediaType === 'tv');
  const idle = !q.trim();

  return (
    <div className="search-page">
      <div className="search-field">
        <Icon name="search" size={19} className="search-ico" />
        <input
          ref={inputRef}
          className="search-input" data-focus=""
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search films and series"
          aria-label="Search films and series"
        />
        {q && (
          <button className="icon-btn focusable" data-focus="" aria-label="Clear search" onClick={() => { setQ(''); inputRef.current?.focus(); }}>
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      {!idle && !state.loading && state.done && (
        <p className="search-summary" aria-live="polite">
          {state.titles.length} {state.titles.length === 1 ? 'result' : 'results'} for “{q}”
        </p>
      )}

      {idle && (
        <div className="search-idle">
          {recent.length > 0 && (
            <section className="row-sec">
              <div className="row-head">
                <h2 className="row-label">Recent</h2>
                <button className="clear-all focusable" data-focus="" onClick={() => { clearRecent(); setRecent([]); }}>Clear</button>
              </div>
              <div className="chips">
                {recent.map(term => (
                  <Chip key={term} onClick={() => setQ(term)} onRemove={() => drop(term)}>{term}</Chip>
                ))}
              </div>
            </section>
          )}
          <section className="row-sec">
            <div className="row-head"><h2 className="row-label">Browse instead</h2></div>
            <div className="chips">
              {SUGGEST.map(s => (
                <a key={s.href} href={s.href} className="chip focusable" data-focus="">{s.label}</a>
              ))}
            </div>
          </section>
        </div>
      )}

      {state.loading && (
        <section className="row-sec search-results-skel" aria-busy="true" aria-label="Loading search results">
          <div className="row-head">
            <Skeleton variant="text" width={92} height="1.2em" />
          </div>
          <div className="grid-titles" data-focus-group="">
            {Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} i={i} />)}
          </div>
        </section>
      )}

      {!state.loading && !idle && state.titles.length > 0 && (
        <>
          {movies.length > 0 && (
            <section className="row-sec" style={{ marginTop: 26 }}>
              <div className="row-head"><h2 className="row-label">Films</h2></div>
              <div className="grid-titles" data-focus-group="">
                {movies.map((t, i) => <Card key={`m-${t.tmdbId}`} title={t} i={i} />)}
              </div>
            </section>
          )}
          {series.length > 0 && (
            <section className="row-sec">
              <div className="row-head"><h2 className="row-label">Series</h2></div>
              <div className="grid-titles">
                {series.map((t, i) => <Card key={`t-${t.tmdbId}`} title={t} i={i} />)}
              </div>
            </section>
          )}
        </>
      )}

      {!state.loading && state.done && state.titles.length === 0 && (
        <EmptyState
          icon="search"
          title={`Nothing found for “${q}”`}
          hint="Check the spelling, or browse by language and genre instead."
          action={<Button icon="filters" onClick={() => { window.location.href = '/browse'; }}>Browse</Button>}
        />
      )}
    </div>
  );
}
