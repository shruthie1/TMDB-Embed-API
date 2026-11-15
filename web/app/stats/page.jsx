'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Skeleton } from '../../components/ui';

/**
 * Title names and posters for the rows on screen, fetched as they are needed.
 *
 * The resolver DOES store metadata, but only for titles someone has opened -
 * measured on the live box, 1 of 134 cached titles had a name, so the page
 * showed bare tmdb ids. Backfilling was the obvious fix and the wrong one: it
 * is a one-off that goes stale the moment a new title is cached. Fetching on
 * demand is self-healing and reuses the same route every other page uses.
 *
 * Only the rows actually rendered are fetched, and each id once, so a 500-row
 * table does not become 500 requests on load.
 */
function useTitleMeta(rows) {
  const [meta, setMeta] = useState({});
  const wanted = useMemo(
    () => rows.slice(0, 60).map(r => `${r.mediaType}:${r.tmdbId}`),
    [rows],
  );
  useEffect(() => {
    let cancelled = false;
    const missing = wanted.filter(k => !(k in meta));
    if (!missing.length) return undefined;
    (async () => {
      for (const key of missing) {
        if (cancelled) return;
        const [mediaType, tmdbId] = key.split(':');
        try {
          const r = await fetch(`/api/title/${mediaType}/${tmdbId}`, { cache: 'force-cache' });
          const t = r.ok ? await r.json() : null;
          if (!cancelled) {
            // Cache the MISS too, as null: without it a title with no metadata
            // is retried on every render for as long as the page is open.
            setMeta(m => ({ ...m, [key]: t?.title ? t : null }));
          }
        } catch {
          if (!cancelled) setMeta(m => ({ ...m, [key]: null }));
        }
      }
    })();
    return () => { cancelled = true; };
    // `meta` is deliberately absent: it changes on every fetch, and depending
    // on it would restart this loop each time a title lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return meta;
}

/**
 * Usage analytics and an operator drill-down.
 *
 * Reads /api/stats from the resolver - catalogue data only, no host detail -
 * so it is safe to serve from Vercel while the numbers live on the VM.
 *
 * Not linked from anywhere in the app. Reached by url, like /providers. It
 * shows raw stream urls, which are signed CDN links, so treat the url to this
 * page as the credential it effectively is.
 */

const pctOf = (n) => (n == null ? null : `${n}%`);
const ms = (n) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const px = (h) => (h ? `${h}p` : null);
const kb = (n) => (n == null ? null : n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`);
const ago = (sec) => {
  if (!sec) return null;
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

/** An em dash reads as "measured, nothing there" rather than a broken cell. */
const Cell = ({ children }) => <>{children ?? <span className="st-none">—</span>}</>;

/**
 * A rate with its raw counts. 2/3 and 200/300 are both 67%, and only one of
 * them is evidence - so the counts are never dropped.
 */
function Rate({ v }) {
  if (!v || !v.attempts) return <span className="st-none">—</span>;
  const tone = v.rate >= 60 ? 'ok' : v.rate >= 25 ? 'warn' : 'bad';
  return (
    <span className="st-rate">
      <b className={`st-${tone}`}>{pctOf(v.rate)}</b>
      <span className="st-sub">{v.successes}/{v.attempts}</span>
      {v.consecutiveFailures >= 5 && (
        <span className="st-streak">{v.consecutiveFailures} failing now</span>
      )}
    </span>
  );
}

function Bar({ value, max }) {
  const w = max > 0 ? Math.round((100 * value) / max) : 0;
  return (
    <span className="st-bar" aria-hidden="true"><span className="st-bar-fill" style={{ width: `${w}%` }} /></span>
  );
}

/** Copy that reports back, so a click without feedback never looks broken. */
function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button className="st-mini" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      } catch { /* denied, or an insecure origin */ }
    }}>{done ? 'copied' : 'copy'}</button>
  );
}

/** The rows behind one title: urls, ladders, and a live test per source. */
function TitleDetail({ t }) {
  const [rows] = useState(null);
  const [err, setErr] = useState(null);
  const [tests, setTests] = useState({});

  // `/api/stats/title/...` was a resolver endpoint; it 404s on the local
  // backend (measured 2026-09-22), so this only ever rendered the error row
  // after a failed request. Say so plainly instead of spending the request.
  useEffect(() => {
    setErr('Per-title source history needs the resolver, which is not running.');
  }, [t.mediaType, t.tmdbId, t.season, t.episode]);

  // Validates the STORED url, which is the question that matters: is what we
  // saved still playable, or will the next play have to re-resolve?
  const test = async (row) => {
    setTests(s => ({ ...s, [row.provider]: { state: 'running' } }));
    try {
      // `/api/validate` 404s locally - reported as a real failure rather than
      // letting a dead endpoint read as "this url is bad".
      throw new Error('no validator');
    } catch {
      setTests(s => ({ ...s, [row.provider]: { state: 'bad', reason: 'no validator' } }));
    }
  };

  if (err) return <tr className="st-detail"><td colSpan={8}><span className="st-none">{err}</span></td></tr>;
  if (!rows) return <tr className="st-detail"><td colSpan={8}><span className="st-none">Loading sources…</span></td></tr>;
  if (!rows.length) return <tr className="st-detail"><td colSpan={8}><span className="st-none">No stored sources.</span></td></tr>;

  return (
    <tr className="st-detail">
      <td colSpan={8}>
        <div className="st-srcs">
          {rows.map(r => {
            const tst = tests[r.provider];
            return (
              <div key={r.provider} className="st-src">
                <div className="st-src-head">
                  <span className="st-name">{r.provider}</span>
                  {r.host && <span className="st-host">{r.host}</span>}
                  <span className="st-src-meta">
                    {px(r.bestHeight) && <span>{px(r.bestHeight)}</span>}
                    {/* What the manifest declared. A device that cannot decode
                        a stream fails opaquely, and the codec is the first
                        thing anyone asks for. */}
                    {r.codecVideo && <span>{r.codecVideo}</span>}
                    {r.codecAudio && <span>{r.codecAudio}</span>}
                    {r.extractMs != null && <span>{ms(r.extractMs)}</span>}
                    {r.segmentBytes != null && <span>{kb(r.segmentBytes)}</span>}
                    <span>{r.hits || 0} plays</span>
                    <span>{ago(r.validatedAt) ?? 'unknown age'}</span>
                  </span>
                  <span className="st-src-act">
                    {tst?.state === 'running' && <span className="st-sub">testing…</span>}
                    {tst?.state === 'ok' && <span className="st-ok">plays</span>}
                    {tst?.state === 'bad' && <span className="st-bad" title={tst.reason}>dead: {tst.reason}</span>}
                    <button className="st-mini" onClick={() => test(r)}>test</button>
                    <Copy text={r.masterUrl} />
                  </span>
                </div>
                <code className="st-url">{r.masterUrl}</code>
                {r.referer && <div className="st-sub">referer {r.referer}</div>}
                {/* Audio languages, when the provider publishes real
                    #EXT-X-MEDIA renditions. "muxed" is the honest answer
                    everywhere else: one baked-in track, nothing to switch. */}
                <div className="st-audio">
                  {r.audioLangs?.length > 0
                    ? r.audioLangs.map(l => (
                        <span key={l} className="st-rung st-lang">{l}</span>
                      ))
                    : <span className="st-none">audio muxed — single track</span>}
                </div>
                {r.ladder?.length > 0 && (
                  <div className="st-ladder">
                    {r.ladder.map((v, i) => (
                      <span key={i} className="st-rung">
                        {v.resolution}
                        {v.bandwidth ? <i> {(v.bandwidth / 1e6).toFixed(1)}M</i> : null}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </td>
    </tr>
  );
}

export default function StatsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('providers');
  const [open, setOpen] = useState(null);      // expanded title key
  const [q, setQ] = useState('');
  // Defaults to LAST PLAYED, descending. "Most played" answers a different
  // question - it surfaces the household favourites, which barely move - while
  // the thing you usually want is "what did I watch last night".
  const [sort, setSort] = useState('recent');
  const [desc, setDesc] = useState(true);
  // Clicking the active column flips direction; a new column starts descending,
  // which is the useful end for every one of these (newest, most, best).
  const sortBy = useCallback((key) => {
    setSort(prev => { if (prev === key) setDesc(d => !d); else setDesc(true); return key; });
  }, []);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      // `/api/stats` belonged to the resolver and 404s locally, and this poll
      // runs every 30s - so it was a failed request twice a minute for as long
      // as the tab stayed open. `/api/providers` is the one path the local
      // backend does serve, so read provider state from it and show no title
      // history rather than a permanent error.
      const r = await fetch('/api/providers', { cache: 'no-store' });
      if (!r.ok) throw new Error(`providers ${r.status}`);
      const j = await r.json();
      setData({ providers: j.providers || [], titles: [] });
      setError(null);
    } catch { setError('Cannot reach the backend.'); }
  }, []);

  useEffect(() => {
    load();
    // Cumulative counters, not a live feed - a slow poll is honest.
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const toggleProvider = async (name, enabled) => {
    setBusy(name);
    try {
      // The local backend serves GET /api/providers/:name only - there is no
      // enable/disable write, so this POST 404'd and the UI then re-read the
      // unchanged value, which looked like the toggle silently refusing.
      throw new Error('read-only');
    } catch { setError('Providers are read-only on the local backend.'); }
    finally { setBusy(null); }
  };

  const titles = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? data.titles.filter(t => (t.title || '').toLowerCase().includes(needle)
                             || String(t.tmdbId).includes(needle))
      : data.titles;
    // Every column is sortable, so the table answers whatever question is being
    // asked of it rather than the four the buttons used to allow.
    const by = {
      title: (a, b) => String(a.title || a.tmdbId).localeCompare(String(b.title || b.tmdbId)),
      hits: (a, b) => (a.hits || 0) - (b.hits || 0),
      sources: (a, b) => a.sources - b.sources,
      quality: (a, b) => (a.bestHeight || 0) - (b.bestHeight || 0),
      // Fastest is the one column where SMALLER is better, so it is negated to
      // keep "descending" meaning "best first" everywhere.
      fastest: (a, b) => (b.fastestMs || Infinity) - (a.fastestMs || Infinity),
      providers: (a, b) => a.providers.length - b.providers.length,
      // resolvedAt is the fallback: a title cached but never replayed has no
      // lastHitAt, and sorting it to the bottom hides exactly the new arrivals.
      recent: (a, b) => (a.lastHitAt || a.resolvedAt || 0) - (b.lastHitAt || b.resolvedAt || 0),
      added: (a, b) => (a.resolvedAt || 0) - (b.resolvedAt || 0),
    }[sort] || (() => 0);
    const sorted = [...rows].sort(by);
    return desc ? sorted.reverse() : sorted;
  }, [data, q, sort, desc]);

  // Above the early returns below: a hook that runs only on some renders
  // changes React's hook order between them and throws.
  const meta = useTitleMeta(titles);

  if (error) return <main className="st"><p className="st-err">{error}</p></main>;
  if (!data) return (
    <main className="st" aria-busy="true" aria-label="Loading statistics">
      <header className="st-head"><h1>Stats</h1><div className="st-tabs"><Skeleton width={92} height={32} /><Skeleton width={76} height={32} /></div></header>
      <section className="st-summary">
        {Array.from({ length: 4 }, (_, i) => <div className="st-stat" key={i}>
          <Skeleton variant="text" width="58%" /><Skeleton variant="text" width="42%" height="1.5em" style={{ marginTop: 8 }} />
        </div>)}
      </section>
      <div className="st-controls"><Skeleton width="260px" height={34} /><div className="st-sorts"><Skeleton width={74} height={30} /><Skeleton width={74} height={30} /></div></div>
      <section className="st-wrap">
        <table className="st-table"><tbody>{Array.from({ length: 7 }, (_, i) => <tr key={i}>
          <td><Skeleton width={180} height={34} /></td><td><Skeleton width={80} height={24} /></td>
          <td><Skeleton width={80} height={24} /></td><td><Skeleton width={80} height={24} /></td>
          <td><Skeleton width={80} height={24} /></td><td><Skeleton width={80} height={24} /></td>
        </tr>)}</tbody></table>
      </section>
    </main>
  );

  const { summary, providers } = data;
  const maxRows = Math.max(1, ...providers.map(p => p.cache.rows));
  const maxHits = Math.max(1, ...titles.map(t => t.hits || 0));
  const noHits = (summary.hits ?? 0) === 0;

  return (
    <main className="st">
      <header className="st-head">
        <h1>Stats</h1>
        <div className="st-tabs" role="tablist">
          {[['providers', 'Providers'], ['titles', 'Titles']].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k}
                    className={`st-tab ${tab === k ? 'on' : ''}`}
                    onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
      </header>

      <section className="st-summary">
        {[
          ['Sources cached', summary.rows],
          ['Titles', summary.titles],
          ['Plays from cache', summary.hits ?? 0],
          ['Best quality seen', px(summary.bestHeight) ?? '—'],
        ].map(([k, v]) => (
          <div key={k} className="st-stat">
            <span className="st-stat-v">{v}</span>
            <span className="st-stat-k">{k}</span>
          </div>
        ))}
      </section>

      {noHits && (
        <p className="st-note">
          Play counts and quality start from the metadata migration.
          {summary.legacyRows > 0 && ` ${summary.legacyRows} of ${summary.rows} rows predate it and read “—” until they are resolved again.`}
        </p>
      )}

      {tab === 'providers' && (
        <div className="st-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th>Provider</th><th>From the VM</th><th>From devices</th>
                <th>Best</th><th>Typical</th><th>Extract</th><th>Playback</th>
                <th className="st-num">Cached</th><th />
              </tr>
            </thead>
            <tbody>
              {providers.map(p => (
                <tr key={p.provider} className={p.registered && p.enabled ? '' : 'st-off'}>
                  <td>
                    <span className="st-name">{p.provider}</span>
                    {p.kind === 'tier' && <span className="st-tag">fast tier</span>}
                    {!p.registered && <span className="st-tag">unregistered</span>}
                    {p.registered && !p.enabled && <span className="st-tag">disabled</span>}
                  </td>
                  {/* Two vantages, never merged: vidking ran 41/50 server-side
                      while failing repeatedly from devices, and one blended
                      number would hide which half is broken. */}
                  <td><Rate v={p.vm} /></td>
                  <td><Rate v={p.client} /></td>
                  <td><Cell>{px(p.cache.bestHeight)}</Cell></td>
                  <td><Cell>{px(p.cache.avgHeight)}</Cell></td>
                  <td><Cell>{ms(p.cache.avgExtractMs)}</Cell></td>
                  <td>
                    {p.cache.playCount
                      ? <span className="st-rate"><span>{ms(p.cache.avgStartupMs) || '—'} start</span><span className="st-sub">{ms(p.cache.avgStallMs) || '0ms'} stall · {p.cache.playCount} plays</span></span>
                      : <span className="st-none">not played yet</span>}
                  </td>
                  <td className="st-num">
                    <span className="st-count">{p.cache.rows}</span>
                    <Bar value={p.cache.rows} max={maxRows} />
                  </td>
                  <td className="st-num">
                    {p.registered && (
                      <button className="st-mini" disabled={busy === p.provider}
                              onClick={() => toggleProvider(p.provider, p.enabled)}>
                        {busy === p.provider ? '…' : p.enabled ? 'disable' : 'enable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'titles' && (
        <>
          <div className="st-controls">
            <input className="st-search" value={q} placeholder="Search title or tmdb id"
                   onChange={e => setQ(e.target.value)} aria-label="Search titles" />
            <span className="st-hint">{titles.length} title{titles.length === 1 ? '' : 's'}</span>
          </div>
          <div className="st-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  {/* Every column sorts. The four fixed buttons this replaces
                      could only answer four questions, and "most played" - the
                      old default - surfaces household favourites rather than
                      what was watched last night. */}
                  {[['title', 'Title', ''], ['hits', 'Plays', 'st-num'],
                    ['sources', 'Sources', 'st-num'], ['quality', 'Best', ''],
                    ['fastest', 'Fastest', ''], ['providers', 'Providers', ''],
                    ['recent', 'Last played', ''], ['added', 'Added', '']].map(([k, label, cls]) => (
                    <th key={k} className={cls}
                        aria-sort={sort === k ? (desc ? 'descending' : 'ascending') : 'none'}>
                      <button className={`st-th ${sort === k ? 'on' : ''}`} onClick={() => sortBy(k)}>
                        {label}
                        <span className="st-arrow" aria-hidden="true">
                          {sort === k ? (desc ? '\u25be' : '\u25b4') : ''}
                        </span>
                      </button>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {titles.map(t => {
                  const key = `${t.mediaType}-${t.tmdbId}-${t.season}-${t.episode}`;
                  const isOpen = open === key;
                  // Fetched name wins over the resolver's, which is null for
                  // all but the titles someone has already opened.
                  const m = meta[`${t.mediaType}:${t.tmdbId}`];
                  const name = m?.title || t.title || `tmdb ${t.tmdbId}`;
                  return [
                    <tr key={key} className={`st-clickable ${isOpen ? 'st-open' : ''}`}
                        onClick={() => setOpen(isOpen ? null : key)}>
                      <td className="st-title-cell">
                        <span className="st-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                        {/* The poster carries the recognition; the name is for
                            search and for anything without artwork. */}
                        {m?.poster
                          ? <img className="st-poster" src={m.poster} alt="" loading="lazy" width={34} height={51} />
                          : <span className="st-poster st-poster-none" aria-hidden="true" />}
                        <span className="st-title-text">
                          <span className="st-name">{name}</span>
                          {t.season > 0 && <span className="st-sub">S{t.season}E{t.episode}</span>}
                          {m?.year && <span className="st-sub">{m.year}</span>}
                        </span>
                      </td>
                      <td className="st-num">
                        <span className="st-count">{t.hits || 0}</span>
                        {t.hits > 0 && <Bar value={t.hits} max={maxHits} />}
                      </td>
                      <td className="st-num">{t.sources}</td>
                      <td><Cell>{px(t.bestHeight)}</Cell></td>
                      <td><Cell>{ms(t.fastestMs)}</Cell></td>
                      <td className="st-provs">{t.providers.join(', ')}</td>
                      <td><Cell>{ago(t.lastHitAt)}</Cell></td>
                      {/* When it was first resolved, as opposed to last played:
                          a title cached but never replayed has no lastHitAt, and
                          this is the column that finds it. */}
                      <td><Cell>{ago(t.resolvedAt)}</Cell></td>
                      <td className="st-num">
                        <a className="st-mini" href={`/title/${t.mediaType}/${t.tmdbId}`}
                           onClick={e => e.stopPropagation()}>open</a>
                      </td>
                    </tr>,
                    isOpen ? <TitleDetail key={`${key}-d`} t={t} /> : null,
                  ];
                })}
                {!titles.length && (
                  <tr><td colSpan={8} className="st-none">
                    {q ? 'Nothing matches that search.' : 'Nothing cached yet.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
