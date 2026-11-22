'use client';
import { useEffect, useMemo, useState } from 'react';
import { Row } from '../components/Row';
import Hero from '../components/Hero';
import { fetchRow, fetchTitleFull, fetchSimilar } from '../lib/api';
import { getContinueWatching, getSeeds } from '../lib/progress';
import { getList } from '../lib/list';
import { warmContinueWatching } from '../lib/prefetch';
import { getPrefs, prefsQuery, effectiveLangs, PREFS_EVENT } from '../lib/prefs';
import { homeRows, dedupeRows } from '../lib/homeRows';
import { readHome, patchHome, clearHome } from '../lib/homeCache';
import { EARLY_ROWS_SCRIPT } from '../lib/earlyRows';

// True once a Home has mounted in this tab. The first Home render is a
// hydration of server HTML, and the server has no localStorage, so that render
// must not read storage: a stored language choice changed the row hrefs and
// labels, React threw #418/#423/#425 and re-rendered the whole document on the
// client, dropping taps on poster cards. Later mounts (Back to home) are plain
// client renders and read storage at once, so the in-tab cache still seeds the
// first paint.
let mountedOnce = false;

// Remote rows requested before the rest (top 10, new, trending and the first
// language pair): what a phone, desktop or TV shows above the fold.
const FIRST_ROWS = 5;

export default function Home() {
  // null on the server and during hydration; the stored prefs on a client
  // re-mount. The mount effect below fills it in either way.
  const [prefs, setPrefs] = useState(() => {
    if (!mountedOnce || typeof window === 'undefined') return null;
    try { return getPrefs(); } catch { return null; }
  });
  const query = prefs ? prefsQuery(prefs) : '';
  // Seed from the in-tab cache so Back to home shows the last rows at once
  // instead of skeletons + a full re-fetch (the carousel used to reload).
  const cached = prefs && typeof window !== 'undefined' ? readHome(query) : null;
  // Each row owns its loading state, so rows appear as they arrive
  // instead of the page blocking on the slowest one.
  const [data, setData] = useState(() => cached?.data ?? {});
  const [rowErrors, setRowErrors] = useState(() => cached?.rowErrors ?? {});
  // Personalised rows, derived from what has actually been watched. Kept
  // separate from the discovery rows because their labels and count depend on history.
  const [recs, setRecs] = useState(() => cached?.recs ?? []);
  const rows = useMemo(() => (prefs ? homeRows(effectiveLangs(prefs)) : []), [prefs]);

  useEffect(() => {
    mountedOnce = true;
    // Read storage once mounted: the hydration render used null (see above).
    setPrefs(getPrefs());
    // A save in the header modal refreshes the rails in place. The cached rows
    // no longer match the new languages, so drop the cache too.
    const onSave = () => {
      clearHome();
      setData(d => ({ continue: d.continue, list: d.list }));
      setRecs([]);
      setRowErrors({});
      setPrefs(getPrefs());
    };
    window.addEventListener(PREFS_EVENT, onSave);
    return () => window.removeEventListener(PREFS_EVENT, onSave);
  }, []);

  useEffect(() => {
    if (!prefs) return undefined;
    let alive = true;
    // Local rows (continue/list) are cheap and must stay current (a title just
    // watched), so always refresh them from local storage. Remote rows already
    // in the in-tab cache for this query are reused, so Back does not re-fetch.
    const fresh = readHome(query);
    const cw = getContinueWatching(3);
    setData(d => ({ ...d, continue: cw, list: getList() }));
    patchHome(query, { data: { ...(fresh?.data || {}), continue: cw, list: getList() } });

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
        fetchSimilar(sd.mediaType, sd.tmdbId)
          .then(r => (r.ok ? r.body : null))
          .then(d => (d?.titles?.length
            ? { key: `rec-${sd.mediaType}-${sd.tmdbId}`,
                label: `Because you watched ${sd.title}`, titles: d.titles }
            : null))
          .catch(() => null)))
        .then(rows => { if (alive) { const r = rows.filter(Boolean); setRecs(r); patchHome(query, { recs: r }); } });
    }

    // The rows on the first screen are requested at once; the rest wait for
    // those to answer. All 19 at once shared a phone's link with the hero art
    // and first posters (about 150kB of JSON on Slow 4G), and nobody can
    // scroll to row 7 in that time.
    const remote = rows.map(r => r.kind).filter(kind => kind !== 'continue' && kind !== 'list'
      // Already fetched for this query and still fresh: keep it, don't re-fetch.
      && !(fresh?.data && Array.isArray(fresh.data[kind])));
    const load = (kind) => fetchRow(kind, { query }).then(res => {
        if (!alive) return;
        const titles = res.ok ? (res.body?.titles || []) : [];
        setRowErrors(errors => {
          const next = { ...errors, [kind]: res.ok ? null : (res.error || `Request failed${res.status ? ` (${res.status})` : ''}`) };
          patchHome(query, { rowErrors: next });
          return next;
        });
        if (process.env.NODE_ENV !== 'production') {
          console.info('[chitram home] row', kind, {
            ok: res.ok,
            status: res.status,
            count: titles.length,
            error: res.error || res.body?.error || null,
          });
        }
        setData(d => {
          const next = { ...d, [kind]: titles };
          patchHome(query, { data: next });
          return next;
        });
      });
    const first = remote.slice(0, FIRST_ROWS);
    Promise.allSettled(first.map(load))
      .then(() => { if (alive) remote.slice(FIRST_ROWS).forEach(load); });
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
      {/* Starts the first rows' requests while the HTML parses, not after
          hydration (lib/earlyRows.js). Inert on a client re-mount. */}
      <script dangerouslySetInnerHTML={{ __html: EARLY_ROWS_SCRIPT }} suppressHydrationWarning />
      <Hero titles={heroTitles || []} loading={heroTitles === undefined} />

      {/* Before mount (server render, and the seconds a TV spends loading
          JS) prefs is null and `display` is empty, so the hero skeleton stood
          alone above a blank screen. The first two discovery rows have fixed
          labels whatever the languages, so they show as skeletons in the same
          place the real rows land. TV only (nav.css); phone and desktop keep
          their current first paint. */}
      {!prefs && (
        <div className="home-boot-rows">
          {homeRows([]).filter(r => r.kind !== 'continue' && r.kind !== 'list').slice(0, 2)
            .map(({ kind, label, ranked }) => (
              <Row key={kind} label={label} titles={[]} loading ranked={ranked} homeSection />
            ))}
        </div>
      )}

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
