'use client';
import { useEffect, useRef } from 'react';
import { Chip, Button } from './ui';
import Icon from './Icon';

export const LANGS = [
  { code: 'te', name: 'Telugu' }, { code: 'ta', name: 'Tamil' },
  { code: 'kn', name: 'Kannada' }, { code: 'ml', name: 'Malayalam' },
  { code: 'hi', name: 'Hindi' }, { code: 'en', name: 'English' },
];

export const GENRES = [
  { id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }, { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' }, { id: 18, name: 'Drama' }, { id: 14, name: 'Fantasy' },
  { id: 27, name: 'Horror' }, { id: 9648, name: 'Mystery' }, { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sci-Fi' }, { id: 53, name: 'Thriller' }, { id: 10751, name: 'Family' },
];

export const DECADES = [
  { id: '2020-2029', name: '2020s' }, { id: '2010-2019', name: '2010s' },
  { id: '2000-2009', name: '2000s' }, { id: '1990-1999', name: '90s' },
];

export const SORTS = [
  { id: 'popularity.desc', name: 'Popular' },
  { id: 'vote_average.desc', name: 'Top rated' },
  { id: 'primary_release_date.desc', name: 'Newest' },
  { id: 'title.asc', name: 'A–Z' },
];

const toggle = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);

/** Active facets as removable chips — always visible, so state is never hidden. */
export function FilterBar({ f, set, count }) {
  const active = [
    ...f.langs.map(c => ({ k: `lang-${c}`, label: LANGS.find(l => l.code === c)?.name || c,
                           clear: () => set({ ...f, langs: f.langs.filter(x => x !== c) }) })),
    ...f.genres.map(g => ({ k: `genre-${g}`, label: GENRES.find(x => x.id === g)?.name || g,
                            clear: () => set({ ...f, genres: f.genres.filter(x => x !== g) }) })),
    ...(f.decade ? [{ k: 'decade', label: DECADES.find(d => d.id === f.decade)?.name || f.decade,
                      clear: () => set({ ...f, decade: null }) }] : []),
    ...(f.minRating ? [{ k: 'rating', label: `★ ${f.minRating}+`,
                         clear: () => set({ ...f, minRating: null }) }] : []),
  ];


  return (
    <div className="filterbar">
      <div className="chips">
        <Chip active={f.type === 'movie'} onClick={() => set({ ...f, type: 'movie' })}>Movies</Chip>
        <Chip active={f.type === 'tv'} onClick={() => set({ ...f, type: 'tv' })}>Series</Chip>
        <span className="fbar-sep" aria-hidden="true" />
        {active.map(a => <Chip key={a.k} active onRemove={a.clear}>{a.label}</Chip>)}
        {active.length > 0 && (
          <button className="clear-all focusable" data-focus=""
                  onClick={() => set({ ...f, langs: [], genres: [], decade: null, minRating: null })}>
            Clear all
          </button>
        )}
      </div>
      <div className="fbar-right">
        {/* Sort was invisible unless you opened the panel, so a view could be
            ordered in a way nothing on screen explained. */}
        <label className="sort-field">
          <span className="sr-only">Sort by</span>
          <select className="sort-select focusable" data-focus="" value={f.sort}
                  onChange={e => set({ ...f, sort: e.target.value })}>
            {SORTS.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <Icon name="chevron" size={12} className="sort-caret" />
        </label>
        {count != null && (
          <p className="result-count">{count.toLocaleString()} {count === 1 ? 'title' : 'titles'}</p>
        )}
      </div>
    </div>
  );
}

/** Sidebar on desktop, bottom sheet on mobile, full overlay on TV. */
export function FilterPanel({ f, set, open, onClose, count }) {
  const panelRef = useRef(null);
  const returnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    returnRef.current = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    // Move focus into the sheet, or a keyboard user is stranded outside it.
    panelRef.current?.querySelector('[data-focus]')?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      // Return focus to the trigger rather than dumping it on <body>.
      if (returnRef.current instanceof HTMLElement) returnRef.current.focus();
    };
  }, [open, onClose]);

  return (
    <>
      <div className={`sheet-scrim ${open ? 'on' : ''}`} onClick={onClose} aria-hidden={!open} />
      <aside ref={panelRef} className={`fpanel ${open ? 'open' : ''}`}
             aria-label="Filters" aria-hidden={!open}
             // Closed, the panel only slides off screen: without inert, Tab
             // (and a desktop keyboard) still walked its hidden buttons.
             inert={open ? undefined : ''}
             role="dialog" aria-modal={open ? 'true' : undefined}>
        <div className="fpanel-grab" />
        <div className="fpanel-head">
          <h2 className="row-label">Filters</h2>
          <button className="icon-btn focusable" data-focus="" aria-label="Close filters" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="fgroup">
          <p className="flabel">Type</p>
          <div className="chips">
            <Chip active={f.type === 'movie'} onClick={() => set({ ...f, type: 'movie' })}>Movies</Chip>
            <Chip active={f.type === 'tv'} onClick={() => set({ ...f, type: 'tv' })}>Series</Chip>
          </div>
        </div>

        <div className="fgroup">
          <p className="flabel">Language</p>
          <div className="chips">
            {LANGS.map(l => (
              <Chip key={l.code} active={f.langs.includes(l.code)}
                    onClick={() => set({ ...f, langs: toggle(f.langs, l.code) })}>{l.name}</Chip>
            ))}
          </div>
        </div>

        <div className="fgroup">
          <p className="flabel">Genre</p>
          <div className="chips">
            {GENRES.map(g => (
              <Chip key={g.id} active={f.genres.includes(g.id)}
                    onClick={() => set({ ...f, genres: toggle(f.genres, g.id) })}>{g.name}</Chip>
            ))}
          </div>
        </div>

        <div className="fgroup">
          <p className="flabel">Decade</p>
          <div className="chips">
            {DECADES.map(d => (
              <Chip key={d.id} active={f.decade === d.id}
                    onClick={() => set({ ...f, decade: f.decade === d.id ? null : d.id })}>{d.name}</Chip>
            ))}
          </div>
        </div>

        <div className="fgroup">
          <p className="flabel">Minimum rating</p>
          <div className="chips">
            {[7, 8].map(r => (
              <Chip key={r} active={f.minRating === r}
                    onClick={() => set({ ...f, minRating: f.minRating === r ? null : r })}>★ {r}+</Chip>
            ))}
          </div>
        </div>

        <div className="fgroup">
          <p className="flabel">Sort by</p>
          <div className="chips">
            {SORTS.map(s => (
              <Chip key={s.id} active={f.sort === s.id} onClick={() => set({ ...f, sort: s.id })}>{s.name}</Chip>
            ))}
          </div>
        </div>

        <div className="fpanel-foot">
          <Button variant="primary" onClick={onClose} className="wide">
            Show {count != null ? count.toLocaleString() : ''} {count === 1 ? 'title' : 'titles'}
          </Button>
        </div>
      </aside>
    </>
  );
}
