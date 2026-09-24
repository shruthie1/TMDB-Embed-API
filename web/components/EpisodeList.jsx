'use client';
import { useEffect, useState } from 'react';
import { poster } from '../lib/api';
import { Skeleton, Chip } from './ui';
import Icon from './Icon';
import { getProgress } from '../lib/progress';

function fmt(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function Episode({ ep, tmdbId, onPlay, isNext }) {
  const p = getProgress('tv', tmdbId, ep.season, ep.episode);
  const still = ep.still ? poster(ep.still, 'w300') : null;
  const left = p && !p.finished ? Math.max(0, p.durationSec - p.positionSec) : null;

  return (
    <button className={`ep focusable${isNext ? ' ep-next' : ''}`} data-focus=""
            onClick={() => onPlay(ep)}
            aria-current={isNext ? 'true' : undefined}>
      <div className="ep-still">
        {still
          ? <img src={still} alt="" loading="lazy" decoding="async" width="300" height="169" />
          : <span className="ep-noimg"><Icon name="play" size={16} /></span>}
        <span className="ep-num">E{ep.episode}</span>
        {p?.pct > 2 && <span className="ep-prog"><i style={{ width: `${p.pct}%` }} /></span>}
      </div>
      <div className="ep-body">
        <b>{ep.title}</b>
        {isNext && <span className="ep-badge">Next up</span>}
        <div className="ep-meta">
          {ep.runtimeMin && <span>{ep.runtimeMin} min</span>}
          {p?.finished && <span>Watched</span>}
          {left != null && left > 60 && <span>{fmt(left)} left</span>}
          {ep.airDate && !p && <span>{ep.airDate.slice(0, 4)}</span>}
        </div>
        {ep.overview && <p>{ep.overview}</p>}
      </div>
    </button>
  );
}

export default function EpisodeList({ tmdbId, seasons = [], onPlay,
                                      initialSeason, nextUp }) {
  // Open on the season you were last watching, not always season 1.
  const [season, setSeason] = useState(
    initialSeason ?? seasons[0]?.number ?? 1);
  const [touched, setTouched] = useState(false);

  // initialSeason can arrive after mount. Follow it until the user picks a
  // tab themselves, after which their choice wins.
  useEffect(() => {
    if (!touched && initialSeason != null) setSeason(initialSeason);
  }, [initialSeason, touched]);
  const [episodes, setEpisodes] = useState(null);

  useEffect(() => {
    let alive = true;
    setEpisodes(null);
    fetch(`/api/season/${tmdbId}/${season}`)
      .then(r => r.json())
      .then(d => { if (alive) setEpisodes(d.episodes || []); })
      .catch(() => { if (alive) setEpisodes([]); });
    return () => { alive = false; };
  }, [tmdbId, season]);

  return (
    <section className="row-sec">
      <div className="row-head">
        <h2 className="row-label">Episodes</h2>
      </div>

      {seasons.length > 1 && (
        <div className="season-tabs" data-focus-group="" role="tablist" aria-label="Seasons">
          {seasons.map(s => (
            <Chip key={s.number} active={s.number === season}
                  onClick={() => { setTouched(true); setSeason(s.number); }}
                  role="tab" aria-selected={s.number === season}>
              {s.name || `Season ${s.number}`}
            </Chip>
          ))}
        </div>
      )}

      <div className="ep-list" data-focus-group="">
        {episodes === null
          ? Array.from({ length: 4 }, (_, i) => (
              <div className="ep" key={i} aria-hidden="true">
                <Skeleton className="ep-still" />
                <div className="ep-body">
                  <Skeleton variant="text" width="42%" />
                  <Skeleton variant="text" width="24%" style={{ marginTop: 8, height: '.62em' }} />
                  <Skeleton variant="text" width="92%" style={{ marginTop: 10, height: '.62em' }} />
                </div>
              </div>
            ))
          : episodes.map(ep => (
              <Episode key={`${ep.season}-${ep.episode}`} ep={ep} tmdbId={tmdbId}
                       onPlay={onPlay}
                       isNext={nextUp?.season === ep.season &&
                               nextUp?.episode === ep.episode} />
            ))}
      </div>
    </section>
  );
}
