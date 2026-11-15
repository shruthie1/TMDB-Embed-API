'use client';
import { useEffect, useMemo, useState } from 'react';
import { Row } from '../components/Row';
import Hero from '../components/Hero';
import { fetchRow, fetchTitleFull } from '../lib/api';
import { getContinueWatching, getSeeds } from '../lib/progress';
import { getList } from '../lib/list';
import { warmContinueWatching } from '../lib/prefetch';
import { getPrefs, prefsQuery, effectiveLangs, PREFS_EVENT } from '../lib/prefs';
import { homeRows, dedupeRows } from '../lib/homeRows';

export default function Home() {
  // Each row owns its loading state, so rows appear as they arrive
  // instead of the page blocking on the slowest one.
  const [data, setData] = useState({});
  const [rowErrors, setRowErrors] = useState({});
  // Personalised rows, derived from what has actually been watched. Kept
  // separate from the discovery rows because their labels and count depend on history.
  const [recs, setRecs] = useState([]);
  // Defaults on the server render; the stored choice after mount.
  // null until mounted: the stored choice lives in localStorage, and fetching
  // rows for the defaults first would load every rail twice.
  const [prefs, setPrefs] = useState(null);
  const rows = useMemo(() => (prefs ? homeRows(effectiveLangs(prefs)) : []), [prefs]);
  const query = prefs ? prefsQuery(prefs) : '';

  useEffect(() => {
    setPrefs(getPrefs());
    // A save in the header modal refreshes the rails in place.
    const onSave = () => {
      setData(d => ({ continue: d.continue, list: d.list }));
      setPrefs(getPrefs());
    };
    window.addEventListener(PREFS_EVENT, onSave);
    return () => window.removeEventListener(PREFS_EVENT, onSave);
  }, []);

  useEffect(() => {
    if (!prefs) return undefined;
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
    // "Because you watched X" for up to three recent titles, spread through
    // the page (see `display`) so they do not stack into one wall.
    const seeds = getSeeds(3);
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

    for (const { kind } of rows) {
      if (kind === 'continue' || kind === 'list') continue;
      fetchRow(kind, { query }).then(res => {
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
  }, [prefs, rows, query]);

  const retryRow = (kind) => {
    setRowErrors(errors => ({ ...errors, [kind]: null }));
    fetchRow(kind, { query }).then(res => {
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
  const heroTitles = data.continue === undefined || data.top10 === undefined
    ? undefined
    : [...(data.continue || []), ...(data.top10 || []), ...(data.trending || [])]
      // Continue-watching entries are intentionally lightweight local records
      // and usually have no backdrop. Filter before limiting the pool, or
      // three such records would consume all hero slots and leave no trending
      // title available to render.
      .filter(title => title.backdrop)
      .filter((title, index, all) => all.findIndex(other =>
        other.mediaType === title.mediaType && other.tmdbId === title.tmdbId
      ) === index)
      .slice(0, 6);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.info('[chitram home] hero', {
        continueCount: data.continue?.length,
        top10Count: data.top10?.length,
        loading: heroTitles === undefined,
        titles: heroTitles?.map(t => ({ id: t.tmdbId, title: t.title, backdrop: t.backdrop })) || [],
      });
    }
  }, [data.continue, data.top10, heroTitles]);

  // "Because you watched" rows: the first after Trending now, the second and
  // third after the first and second language blocks. Built into ONE ordered
  // list with the fixed rows so dedupe and render walk the same order.
  const display = useMemo(() => {
    const anchors = ['trending', ...rows.filter(r => r.kind.startsWith('series-')).map(r => r.kind)];
    const out = [];
    for (const row of rows) {
      out.push(row);
      const at = anchors.indexOf(row.kind);
      if (at >= 0 && recs[at]) out.push({ kind: recs[at].key, label: recs[at].label, thin: 4, rec: true });
    }
    return out;
  }, [rows, recs]);
  const shown = useMemo(() => dedupeRows(display, {
    ...data, ...Object.fromEntries(recs.map(r => [r.key, r.titles])),
  }), [display, data, recs]);

  return (
    <div className="home-page">
      <Hero titles={heroTitles || []} loading={heroTitles === undefined} />

      {display.map(({ kind, label, href, thin, ranked, rec }) => {
        const titles = shown[kind];
        // Hide a row that is empty, or thin once earlier rows have claimed
        // their titles, rather than showing a near-empty rail.
        if (thin && titles && titles.length < thin) return null;
        // Local rows are instant; hide them when empty rather than showing
        // an empty rail or a skeleton that never fills.
        if ((kind === 'continue' || kind === 'list') && (!titles || titles.length === 0)) return null;
        return (
          <Row
            key={kind}
            label={label}
            href={href}
            titles={titles || []}
            loading={titles === undefined}
            error={rec ? null : rowErrors[kind]}
            onRetry={rec ? undefined : () => retryRow(kind)}
            ranked={ranked}
            homeSection
          />
        );
      })}
    </div>
  );
}
