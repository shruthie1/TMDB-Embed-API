'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listSources } from '../backend';
import { abortReason } from '../abortReason';

// One initial lookup after playback starts, plus explicit user continuation.
// Requests only merge rows; they never replace the current playing stream.
export default function useNetmirrorSources({ hasStream, mediaType, tmdbId, season, episode, mergeSources }) {
  const active = useRef(null);
  const [loading, setLoading] = useState(false);
  const check = useCallback(async () => {
    if (!hasStream || active.current) return;
    const ac = new AbortController();
    active.current = ac;
    setLoading(true);
    try {
      const found = await listSources(mediaType, tmdbId, { season, episode, provider: 'netmirror', signal: ac.signal });
      if (!ac.signal.aborted && found?.length) mergeSources(found);
    } catch { /* Existing rows and the playing stream remain available. */ }
    finally {
      if (active.current === ac) { active.current = null; setLoading(false); }
    }
  }, [hasStream, mediaType, tmdbId, season, episode, mergeSources]);
  useEffect(() => {
    setLoading(false);
    check();
    return () => {
      active.current?.abort(abortReason('netmirror lookup superseded or unmounted'));
      active.current = null;
    };
  }, [check]);
  return { check, loading };
}
