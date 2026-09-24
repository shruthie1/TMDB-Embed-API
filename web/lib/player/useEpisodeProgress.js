'use client';
import { useEffect, useState } from 'react';
import { saveProgress } from '../progress';

/**
 * Owns watch position and the next-episode lookup.
 *
 * Position is saved every 10s, on unmount and on `pagehide`, because a phone
 * backgrounding the tab never fires unload.
 */
export function useEpisodeProgress({ videoRef, title, season = 0, episode = 0,
                                     epTitle = null, enabled = true }) {
  const [nextEp, setNextEp] = useState(null);   // {season, episode, title} | null
  const [ended, setEnded] = useState(false);

  const isTv = title?.mediaType === 'tv' && episode > 0;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !title) return;
    const save = () => {
      if (!video.duration || Number.isNaN(video.duration)) return;
      saveProgress({
        mediaType: title.mediaType, tmdbId: title.tmdbId, season, episode,
        positionSec: Math.floor(video.currentTime),
        durationSec: Math.floor(video.duration),
        title: title.title, poster: title.poster, epTitle,
      });
    };
    const id = setInterval(save, 10000);
    window.addEventListener('pagehide', save);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [videoRef, title, season, episode, epTitle]);

  /**
   * Is there a next episode? Ask the season list rather than assuming
   * episode+1 exists - a season end must roll over, and a series end must not
   * offer a phantom episode.
   */
  useEffect(() => {
    setNextEp(null);
    setEnded(false);
    if (!isTv || !enabled || !title?.tmdbId) return;
    let alive = true;
    (async () => {
      try {
        const cur = await fetch(`/api/season/${title.tmdbId}/${season}`).then(r => r.json());
        const inSeason = (cur.episodes || []).find(e => e.episode === episode + 1);
        if (inSeason) {
          if (alive) setNextEp({ season, episode: episode + 1, title: inSeason.title });
          return;
        }
        const nxt = await fetch(`/api/season/${title.tmdbId}/${season + 1}`).then(r => r.json());
        const first = (nxt.episodes || []).find(e => e.episode === 1);
        if (first && alive) setNextEp({ season: season + 1, episode: 1, title: first.title });
      } catch { /* a dead end is better than a wrong one */ }
    })();
    return () => { alive = false; };
  }, [isTv, enabled, title?.tmdbId, season, episode]);

  /**
   * End of episode. Fires on `ended`, and near the end too, since some HLS
   * streams never emit it cleanly. `readyState` guards against a stale
   * duration left over from the previous episode, which made the end card
   * reappear instantly on the next one.
   */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !nextEp) return;
    const check = () => {
      if (!v.duration || Number.isNaN(v.duration) || v.readyState < 2) return;
      if (v.currentTime >= v.duration - 1) setEnded(true);
    };
    const onEnded = () => setEnded(true);
    v.addEventListener('ended', onEnded);
    v.addEventListener('timeupdate', check);
    return () => {
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('timeupdate', check);
    };
  }, [videoRef, nextEp]);

  return { nextEp, ended, setEnded, isTv };
}
