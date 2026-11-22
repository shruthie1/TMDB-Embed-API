'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
// Points at lib/backend.js, the adapter for this repo's API. Same
// signature as Chitram's resolveStreamLive, so this file is otherwise
// unchanged from the original.
import { resolveLive as resolveStreamLive } from '../backend';
import { getLastProvider } from '../lastProvider';
import { oneTouchRowsCached } from '../clientPrewarm';
import { keepPlayingRow } from './refreshModel';

// The VM failed or found nothing: OneTouchTV resolved in this browser. Rows a
// details-page prewarm already kept (30 min) cost no request; a prewarm still
// running is joined.
const browserFallback = (type, tmdbId, { season, episode, signal }) =>
  oneTouchRowsCached({ type, tmdbId, season, episode, signal });

/** Real server events -> human sentences. Reports fact, not a timed guess. */
export function describe(e) {
  switch (e.type) {
    case 'cache-check':   return `Validating saved source (${e.provider}) · checking manifest and first segment`;
    case 'cache-hit':     return `Using saved source (${e.provider})`;
    case 'wave-start':    return `Trying ${(e.providers || []).join(', ')}`;
    // "Opening" was a lie whenever the gate was busy: the message appeared the
    // moment a provider was QUEUED and then sat unchanged for as long as 12
    // seconds while nothing happened. A viewer reads that as the player being
    // stuck. Say which it is.
    case 'extract-start':
      return e.queued > 0
        ? `Waiting for a slot — ${e.queued} ahead (${e.provider})`
        : `Opening ${e.provider}`;
    case 'extract-ok':    return `Stream found on ${e.provider} · validating playback (${(e.ms / 1000).toFixed(1)}s)`;
    case 'extract-fail':  return `${e.provider} had nothing — moving on`;
    case 'validate-ok':   return `Verified ${e.provider}${e.quality ? ` · ${e.quality}` : ''}`;
    case 'validate-fail': return `${e.provider} failed the check — moving on`;
    case 'fast-start':    return `Opening fast API (${e.provider})`;
    case 'fast-miss':     return `${e.provider} had no match · trying browser sources`;
    case 'fast-fail':     return `${e.provider} unavailable · trying browser sources`;
    case 'fast-hit':      return `Fast API ready (${e.provider})`;
    case 'fast-lost':     return `${e.provider} answered but a faster source won`;
    default:              return null;
  }
}

/**
 * Fold one server event into the per-provider track.
 *
 * Pure, and exported, so the state machine can be tested without mounting a
 * player. Returns the SAME array reference when nothing changed, so React
 * skips the re-render on the many events that say nothing about a provider.
 *
 * Ordering is the roster order from `wave-start`, not arrival order: rows must
 * not jump around under the viewer's eye as results come back out of order.
 */
export function trackReducer(rows, e) {
  // A wave announces its whole roster before any of it runs. Seeding every
  // provider as `queued` here is what makes the wait legible from the first
  // frame - otherwise rows pop in one at a time and the viewer cannot tell
  // how much is still to come.
  if (e.type === 'wave-start') {
    const names = e.providers || [];
    if (!names.length) return rows;
    const add = names
      .filter(n => !rows.some(r => r.name === n))
      .map(n => ({ name: n, state: 'queued', queued: 0, ms: 0 }));
    return add.length ? [...rows, ...add] : rows;
  }

  const patch = {
    // `queued` on extract-start is the gate depth AT THE MOMENT this provider
    // was submitted. It is why a row can sit at "opening" for ten seconds and
    // still be healthy - it never started.
    'extract-start': () => (e.queued > 0
      ? { state: 'queued', queued: e.queued }
      : { state: 'opening', queued: 0 }),
    'extract-ok':    () => ({ state: 'validating', queued: 0, ms: e.ms || 0 }),
    'extract-fail':  () => ({ state: 'failed', queued: 0, ms: e.ms || 0 }),
    // A source that extracts but fails validation is not a source. Showing it
    // as `found` would promise the viewer a stream that will never play.
    'validate-fail': () => ({ state: 'failed', queued: 0 }),
    'validate-ok':   () => ({ state: 'ok', queued: 0 }),
    // The fast tier and the cache never go near the gate, so they emit no
    // extract events at all. Without these two the track stays empty on the
    // ~80% of resolves that never open a browser.
    'fast-hit':      () => ({ state: 'ok', queued: 0, ms: e.ms || 0 }),
    'fast-start':    () => ({ state: 'opening', queued: 0 }),
    'fast-miss':     () => ({ state: 'failed', queued: 0, ms: e.ms || 0 }),
    'fast-fail':     () => ({ state: 'failed', queued: 0, ms: e.ms || 0 }),
    // A fast source that answered but did not win the race - not a miss, not
    // a failure, it simply arrived second. Without this its row sat at
    // "opening" forever: it never received ANY terminal event, since
    // Promise.any only reports the winner. Measured live, tmdb 617405:
    // showsst and mappleapi both hit in 1.5-6.2s but the UI showed them
    // opening at 11s+ because vidzee won the overall race first.
    'fast-lost':     () => ({ state: 'failed', queued: 0 }),
    'cache-hit':     () => ({ state: 'ok', queued: 0 }),
    // Cache validation is a real network check, not a lookup. Keep it visible
    // while the resolver fetches the manifest, variant and first segment.
    'cache-check':   () => ({ state: 'validating', queued: 0 }),
  }[e.type];
  if (!patch || !e.provider) return rows;

  const at = rows.findIndex(r => r.name === e.provider);
  const next = { name: e.provider, state: 'queued', queued: 0, ms: 0, ...(rows[at] || {}), ...patch() };
  if (at === -1) return [...rows, next];
  const prev = rows[at];
  if (prev.state === next.state && prev.queued === next.queued && prev.ms === next.ms) return rows;
  const out = rows.slice();
  out[at] = next;
  return out;
}

/** Best rung a source offers, as a short label — the reason to switch to it. */
export function bestLabel(variants, quality) {
  const res = variants?.[0]?.resolution || quality;
  if (!res) return '';
  const h = Number(String(res).split('x')[1]);
  return Number.isFinite(h) ? `${h}p` : String(res);
}

/**
 * Owns the resolve: the SSE stream and everything it produces.
 *
 * Nothing outside this hook writes `stream`, `log`, `sources` or `error`.
 * That single-owner rule is why the progress log stopped rendering before —
 * an unrelated effect was clearing it mid-flight.
 */
/**
 * Identity of a source row.
 *
 * This used to be the provider NAME alone, which was right for the backend
 * Chitram shipped against: that one returned at most one entry per provider.
 * This backend does not. Measured on movie/1440735: 7 streams arrive as
 * NetMirror x3, CastleTV x2, VaPlayer, OneTouchTV - so keying on the name
 * collapsed 7 rows into 4, and the survivor was whichever arrived FIRST, not
 * the best one. The NetMirror master carrying the Kannada and Telugu audio
 * renditions lost to a plain single-rung NetMirror variant, so those tracks
 * were unreachable and the audio menu never appeared at all.
 *
 * The URL is the real identity, so two rows from one provider stay distinct.
 * But a row can arrive WITHOUT a url: `done` carries bare {provider} entries
 * meant to merge into the richer entry an earlier validate-ok already added.
 * So matching is two-way - identical urls are the same row, and when EITHER
 * side has no url the provider name is all we have to go on, which restores
 * the original merge behaviour for those.
 */
const srcUrl = (s) => s.url || s.masterUrl || '';
const sameSource = (a, b) => {
  if (a.provider !== b.provider) return false;
  const ua = srcUrl(a), ub = srcUrl(b);
  if (!ua || !ub) return true;          // one side is a bare stub: merge it
  return ua === ub && (a.quality || '') === (b.quality || '');
};

export function useResolve({ mediaType, tmdbId, season = 0, episode = 0 }) {
  const [stream, setStream] = useState(null);
  const [sources, setSources] = useState([]);
  const [currentSource, setCurrentSource] = useState(null);
  // The provider NAME is ambiguous once a provider returns several streams, so
  // the id identifies the exact row that is playing. The name stays because
  // recovery and the dead-source set are keyed by provider.
  const [currentSourceId, setCurrentSourceId] = useState(null);
  // True while a forced re-resolve runs, so the loading screen can say so.
  const [refreshing, setRefreshing] = useState(false);
  const [sourcesPending, setSourcesPending] = useState(true);
  const [log, setLog] = useState([]);
  const [providers, setProviders] = useState([]);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState(null);
  const cancelRef = useRef(null);

  // A tv resolve needs to know WHICH episode. The effect below fires as soon as
  // the player mounts, and for a series `season`/`episode` are still 0 at that
  // moment - so a meaningless s0e0 resolve went out, queued three Chromium
  // extractions, and the real s1e1 request two seconds later queued behind
  // them. Measured on tmdb 60550: vidking extracted in 4.2s but the resolve
  // took 54.6s, almost all of it waiting for a slot.
  const ready = mediaType !== 'tv' || (season > 0 && episode > 0);

  // Set on every load(), including a refresh and a source switch, so each is
  // timed as its own fresh wait rather than against the original press.
  const requestedAt = useRef(null);

  const load = useCallback((refresh = false, { prefetched = null } = {}) => {
    if (!ready) return;
    // The moment the viewer is actually waiting from.
    //
    // startupMs used to be measured from the arrival of the stream URL, which
    // excludes the entire resolve - and the resolve is most of the wait:
    // measured over 7 days on the live VM, p50 was 1.3s on a cache hit but
    // 14.4s on a cold browser resolve (p90 59.7s). So every startup number we
    // had understated the real press-Play-to-picture time by 1.3-14s, and a
    // change that moved resolve time would not have shown up at all.
    requestedAt.current = Date.now();
    // The mixed-content pre-check that stood here is gone: the resolve now
    // goes to same-origin `/api/resolve/...`, so the browser can no longer be
    // blocked by scheme mismatch and a misconfigured resolver surfaces as the
    // relay's 502 through onFail instead. See the note in lib/api.js.
    setError(null); setStage(0); setLog([]); setProviders([]);
    setRefreshing(Boolean(refresh));
    setSourcesPending(true);
    // "Refresh sources" after a failure: its answer replaces the old rows.
    if (prefetched) setSources([]);
    cancelRef.current?.();

    cancelRef.current = resolveStreamLive(mediaType, tmdbId, {
      season, episode,
      provider: getLastProvider(mediaType, tmdbId, season, episode),
      refresh,
      prefetched,
      clientFallback: browserFallback,
      onEvent: (e) => {
        // Every validated provider is switchable: the event carries its own
        // masterUrl, so switching never costs a re-resolve.
        if (e.type === 'validate-ok' && e.masterUrl) {
          setSources(prev => {
            const entry = {
              provider: e.provider, masterUrl: e.masterUrl, referer: e.referer ?? null,
              variants: e.variants ?? [], best: bestLabel(e.variants, e.quality),
              audioTracks: e.audioTracks ?? [], codecs: e.codecs ?? null,
              // A plain mp4 rather than a playlist: useHls must attach it to
              // the video element directly, so the flag has to survive here.
              progressive: e.progressive ?? false,
            };
            const at = prev.findIndex(x => x.provider === e.provider);
            if (at === -1) return [...prev, entry];
            // A refresh can mint a new signed URL for a provider already in
            // the picker. Keep the picker in sync with the active resolve;
            // retaining the old row makes a later manual switch jump back to
            // an expired URL.
            const out = prev.slice();
            out[at] = { ...out[at], ...entry };
            return out;
          });
        }
        if (e.type === 'resolved') { setSourcesPending(false); return; }
        // Before describe()'s early return: the track cares about events
        // that produce no log line, and vice versa.
        setProviders(rows => trackReducer(rows, e));
        const line = describe(e);
        if (!line) return;
        setLog(l => [...l.slice(-3), { id: `${e.type}-${e.provider}-${e.t}`, line }]);
        if (e.type === 'extract-ok' || e.type === 'cache-check') setStage(1);
      },
      onDone: (d) => {
        setStage(2);
        setStream(d);
        setCurrentSource(d.provider ?? null);
        setCurrentSourceId(d.id ?? null);
        // `done` carries everything validated so far, including on a cache hit
        // where no per-provider events fire at all. Merge, do not replace.
        if (Array.isArray(d.sources) && d.sources.length) {
          setSources(prev => {
            const merged = [...prev];
            for (const src of d.sources) {
              const at = merged.findIndex(m => sameSource(m, src));
              const entry = { ...src, best: bestLabel(src.variants, null),
                audioTracks: src.audioTracks ?? [], codecs: src.codecs ?? null };
              if (at === -1) merged.push(entry);
              else merged[at] = { ...merged[at], ...entry };
            }
            return merged;
          });
        }
        if (d.cached) setSourcesPending(false);
      },
      // The rest of a partial answer, merged under the same identity rule as
      // onDone. Never touches `stream`: what is playing keeps playing.
      onMore: (more) => {
        setSources(prev => {
          const merged = [...prev];
          // toSource mints ids by index in EACH answer, so the full list
          // re-numbers rows we already hold. A known row keeps its id (it may
          // be playing: currentSourceId points at it), and a new row never
          // takes an id another row already has.
          const taken = new Set(merged.map(m => m.id));
          for (const src of more) {
            const at = merged.findIndex(m => sameSource(m, src));
            const entry = { ...src, best: bestLabel(src.variants, null),
              audioTracks: src.audioTracks ?? [], codecs: src.codecs ?? null };
            if (at === -1) {
              let id = entry.id;
              for (let n = 2; id != null && taken.has(id); n++) id = `${src.id}~${n}`;
              taken.add(id);
              merged.push({ ...entry, id });
            } else merged[at] = { ...merged[at], ...entry, id: merged[at].id ?? entry.id };
          }
          return merged;
        });
        setSourcesPending(false);
      },
      onFail: (d) => setError({
        message: d.reason || 'No source available right now.',
        tried: d.tried || [], providers: d.providers || [],
      }),
    });
  }, [mediaType, tmdbId, season, episode, ready]);

  // Depends on the INPUTS, not on `load`'s identity. `load` is a useCallback,
  // so any re-render produced a new one, re-running this effect - and its
  // cleanup then closed the EventSource the re-run had just opened, so no
  // message ever arrived and the progress log stayed empty.
  useEffect(() => {
    load();
    return () => { cancelRef.current?.(); cancelRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaType, tmdbId, season, episode, ready]);


  /** Switch to an already-validated source. No re-resolve: we hold the url. */
  const switchSource = useCallback((src) => {
    if (!src?.masterUrl) return null;
    // A switch carries an ALREADY-resolved url, so there is no resolve leg to
    // count - but it is still a fresh wait for the viewer. Stamping here keeps
    // a switch from being measured against the original press, which would
    // otherwise report a several-minute "startup" mid-film.
    requestedAt.current = Date.now();
    setCurrentSource(src.provider);
    setCurrentSourceId(src.id ?? null);
    setError(null);
    setStream({
      provider: src.provider, masterUrl: src.masterUrl,
      referer: src.referer ?? null, variants: src.variants ?? [],
      // Carry the SHAPE of the source, not just its url. Dropping this meant a
      // manual switch to netmirror handed useHls a stream with progressive
      // undefined, so a raw .mp4 went down the hls.js path and died parsing a
      // playlist that was never a playlist. The picker said netmirror; the
      // picture stayed on the old source.
      progressive: src.progressive ?? false,
      audioTracks: src.audioTracks ?? [],
      codecs: src.codecs ?? null,
    });
    return src;
  }, []);


  /**
   * Fold in sources fetched on demand, without disturbing what is playing.
   *
   * `sources` has one writer - this hook - so the settings sheet asks for a
   * refresh rather than setting state itself. Existing entries are updated in
   * place instead of replaced, so switching source does not reset the picker
   * under the viewer's finger.
   */
  const mergeSources = useCallback((found) => {
    if (!found?.length) return;
    setSources(prev => {
      const merged = [...prev];
      for (const src of found) {
        // Same identity rule as onDone (provider + url + quality). Matching on
        // the provider NAME alone kept one row per provider, but NetMirror
        // ships a film as several rows - one per audio language / platform -
        // so a later row overwrote the earlier one and its language vanished.
        const at = merged.findIndex(m => sameSource(m, src));
        const entry = { ...src, best: bestLabel(src.variants, src.bestResolution) };
        if (at === -1) merged.push(entry);
        else merged[at] = { ...merged[at], ...entry };
      }
      return merged;
    });
    setSourcesPending(false);
  }, []);

  /**
   * Put a fresh signed url on an EXISTING row, keeping its id and position.
   *
   * mergeSources matches rows by url, so a renewed url would land as a second
   * copy of the same server. See lib/player/staleRefresh.js.
   */
  const replaceSource = useCallback((id, fresh) => {
    if (id == null || !fresh?.masterUrl) return;
    setSources(prev => prev.map(s => (s.id === id ? { ...s, ...fresh, id: s.id } : s)));
  }, []);

  /**
   * "Refresh sources" while a source plays: the new rows replace the list in
   * one update, in their ranked (Telugu-first) order. The playing row is never
   * touched: when the new answer lacks it, it stays in the list so the menu
   * still ticks it. `stream` is not changed, so playback goes on.
   */
  const replaceSources = useCallback((fresh, keepId = null) => {
    if (!fresh?.length) return;
    setSources((prev) => {
      const next = fresh.map((src) => ({ ...src, best: bestLabel(src.variants, null),
        audioTracks: src.audioTracks ?? [], codecs: src.codecs ?? null }));
      return keepPlayingRow(prev, next, keepId);
    });
    setSourcesPending(false);
  }, []);

  return { stream, sources, currentSource, currentSourceId, sourcesPending, log, stage, error, providers, refreshing,
           mergeSources, replaceSource, replaceSources, requestedAt,
           load, switchSource, setError };
}
