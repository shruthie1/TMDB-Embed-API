'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshStreams, sourcesFromResponse } from '../backend';
import {
  REFRESH_COOLDOWN_MS, claimRefresh, initialRefresh, refreshBlocked, refreshFinish, refreshKey,
  refreshLabel, refreshNote, refreshOutcome, refreshReadyAt, refreshStart, refreshState,
} from './refreshModel';

/**
 * "Refresh sources" for one title and episode (refreshModel.js has the
 * journey). One tap: the kept answer is dropped and the VM asked once with
 * refresh=1. `onRows(sources, answer)` gets the new ranked rows when there are
 * any; the caller decides what to do with them (replace the list, or start the
 * best row on the failure card). `before()` returns the urls on screen now, for
 * the "No new sources" line. Ticks every 500 ms while refreshing, cooling down
 * or showing a result, then stops.
 */
export function useRefreshSources({ mediaType, tmdbId, season = 0, episode = 0, preferred = 'Telugu', before, onRows, fetcher = refreshStreams }) {
  const key = refreshKey(mediaType, tmdbId, season, episode);
  const [model, setModel] = useState(() => ({ ...initialRefresh, readyAt: refreshReadyAt(key) }));
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Another title: its own cooldown.
  useEffect(() => { setModel({ ...initialRefresh, readyAt: refreshReadyAt(key) }); }, [key]);

  const active = model.running || model.readyAt > now || model.noteUntil > now;
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);

  const refresh = useCallback(async () => {
    if (busy.current || !tmdbId) return;
    const t0 = Date.now();
    setNow(t0);
    if (!claimRefresh(key, t0)) { setModel((m) => refreshBlocked(m, t0, refreshReadyAt(key))); return; }
    busy.current = true;
    const was = new Set(typeof before === 'function' ? before() : []);
    setModel(refreshStart(t0, t0 + REFRESH_COOLDOWN_MS));
    let rows = null;
    let answer = null;
    try {
      answer = await fetcher(mediaType, tmdbId, { season, episode });
      rows = sourcesFromResponse(answer);
    } catch { rows = null; }
    busy.current = false;
    if (!alive.current) return;
    const t1 = Date.now();
    setNow(t1);
    setModel((m) => refreshFinish(m, t1, refreshOutcome(was, rows || [], rows == null, preferred)));
    if (rows?.length) onRows?.(rows, answer);
  }, [key, mediaType, tmdbId, season, episode, preferred, before, onRows, fetcher]);

  return {
    refresh,
    model,
    state: refreshState(model, now),
    label: refreshLabel(model, now),
    note: refreshNote(model, now),
    running: model.running,
  };
}
