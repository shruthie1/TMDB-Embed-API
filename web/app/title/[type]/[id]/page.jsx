'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchTitle, fetchTitleFull, poster } from '../../../../lib/api';
import Player from '../../../../components/Player';
import CastRow, { CastRowSkeleton } from '../../../../components/CastRow';
import EpisodeList from '../../../../components/EpisodeList';
import { Row } from '../../../../components/Row';
import { Button, Badge, Skeleton, Toast } from '../../../../components/ui';
import { getProgress, getNextUp } from '../../../../lib/progress';
import { inList, toggleList } from '../../../../lib/list';
import { preresolve } from '../../../../lib/prefetch';
import { languageName } from '../../../../lib/subtitles';
import Icon from '../../../../components/Icon';

function runtime(min) {
  if (!min) return null;
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

export default function TitlePage() {
  const { type, id } = useParams();
  const router = useRouter();
  const tmdbId = Number(id);

  const [t, setT] = useState(null);
  const [full, setFull] = useState(false);
  const [similar, setSimilar] = useState(undefined);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [play, setPlay] = useState(null);      // {season, episode, startAt} | null
  const [resume, setResume] = useState(null);
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    // Fast record first for an early paint, but it is only worth the extra
    // request while it actually arrives sooner; the full one overwrites it.
    fetchTitle(type, id).then(r => { if (alive && r.ok) setT(v => v ?? r.body); });
    fetchTitleFull(type, id).then(r => {
      if (!alive || !r.ok) return;
      setT(r.body); setFull(true);
      if (type === 'tv') setResume(getNextUp(tmdbId, r.body.seasonList));
    });
    fetch(`/api/similar/${type}/${id}`).then(r => r.json())
      .then(d => { if (alive) setSimilar(d.titles || []); })
      .catch(() => { if (alive) setSimilar([]); });
    setResume(type === 'tv' ? getNextUp(tmdbId) : getProgress(type, tmdbId));
    // seasonList arrives with the full record; recompute so a season/series
    // boundary is respected (S1E7 -> S2E1, never S1E8).
    setSaved(inList(type, tmdbId));
    return () => { alive = false; };
  }, [type, id, tmdbId]);

  // The detail page is already a strong play intent: the viewer has opened a
  // title, then usually spends a few seconds reading before pressing Resume.
  // Warm the resolver during that natural dwell so the click does not pay a
  // cold browser extraction. This is background work, so the resolver keeps a
  // reserved viewer slot and a viewer arriving mid-prefetch is prioritized.
  useEffect(() => {
    if (!t || !full) return;
    const target = type === 'tv'
      ? { season: resume?.season ?? 1, episode: resume?.episode ?? 1 }
      : {};
    // hls.js is a dynamic player dependency. Download it during the same
    // reading dwell as the resolver warmup so the click only waits for media,
    // not for a JavaScript chunk to arrive first.
    import('hls.js').catch(() => {});
    const timer = setTimeout(() => preresolve(type, tmdbId, target), 700);
    return () => clearTimeout(timer);
  }, [t, full, type, tmdbId, resume?.season, resume?.episode]);

  // Stable so the Player's next-episode lookup does not refetch each render.
  const playNext = useCallback((next) => {
    setPlay({ season: next.season, episode: next.episode,
              startAt: 0, label: next.title });
  }, []);

  const onSave = useCallback(() => {
    const now = toggleList(t);
    setSaved(now);
    setToast(now ? 'Added to My List' : 'Removed from My List');
    setTimeout(() => setToast(null), 2200);
  }, [t]);

  if (!t) return <TitleSkeleton />;

  // What the Play button does, and what it should say. For a series this is
  // an episode; for a film, a position. Falls back to S1E1 for a new show.
  const isTv = type === 'tv';
  const playTarget = isTv
    ? { season: resume?.season ?? 1, episode: resume?.episode ?? 1,
        startAt: resume?.resume ? resume.positionSec : 0 }
    : { startAt: resume?.positionSec || 0 };

  const epTag = isTv ? `S${playTarget.season}E${playTarget.episode}` : null;
  const playLabel = isTv
    ? (resume?.resume ? `Resume · ${epTag}`
      : resume?.seriesEnded ? `Rewatch · ${epTag}`
      : resume ? `Play ${epTag}` : 'Play S1E1')
    // Just "Resume" - the elapsed time is already on the progress bar, and it
    // made the label wrap on a phone.
    : (resume ? 'Resume' : 'Play');

  const bg = t.backdrop ? poster(t.backdrop, 'w1280') : null;
  const pos = t.poster ? poster(t.poster, 'w342') : null;
  const meta = [
    t.year,
    runtime(t.runtimeMin),
    t.rating ? `★ ${Number(t.rating).toFixed(1)}` : null,
  ].filter(Boolean);

  return (
    <article className="detail">
      <button
        type="button"
        className="detail-back focusable"
        data-focus=""
        onClick={() => router.back()}
        aria-label="Go back"
      >
        <Icon name="back" size={16} />
        <span>Back</span>
      </button>
      <div className="hero">
        {bg && <div className="hero-art page-backdrop" aria-hidden="true"
                    style={{ '--bg-lg': `url(${bg})`, '--bg-sm': `url(${poster(t.backdrop, 'w780')})` }} />}
        <div className="hero-inner">
          {pos && (
            <div className="hero-poster enter">
              <img src={pos} alt="" width="342" height="513" />
            </div>
          )}
          <div className="hero-text">
            <h1 className="detail-title">{t.title}</h1>
            {t.tagline && <p className="tagline">{t.tagline}</p>}

            <div className="detail-meta">
              {meta.map((m, i) => <span key={i}>{m}</span>)}
              {t.originalLang && <span><Badge>{languageName(t.originalLang)}</Badge></span>}
              {!full && <span><Skeleton variant="text" width={54} style={{ display: 'inline-block' }} /></span>}
            </div>

            {t.overview && (
              <>
                <p className={`detail-overview${overviewOpen ? ' expanded' : ''}`}>
                  {t.overview}
                </p>
                <button
                  type="button"
                  className="detail-overview-toggle focusable"
                  data-focus=""
                  aria-expanded={overviewOpen}
                  onClick={() => setOverviewOpen(open => !open)}
                >
                  {overviewOpen ? 'Show less' : 'Read more'}
                </button>
              </>
            )}
          </div>

          {/* A sibling of .hero-text, not a child: on a phone the actions take
              their own full-width row beneath the poster, which a nested
              element could not do. */}
          <div className="hero-actions">
            <div className="actions" data-focus-group="">
              <Button variant="primary" icon="play" onClick={() => setPlay(playTarget)}>
                {playLabel}
              </Button>
              {resume?.resume && (
                <Button icon="restart"
                        onClick={() => setPlay({ ...playTarget, startAt: 0 })}>
                  Start over
                </Button>
              )}
              <Button icon={saved ? 'check' : 'plus'} onClick={onSave} aria-pressed={saved}>
                {saved ? 'In My List' : 'My List'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {type === 'tv' && full && (
        <EpisodeList
          tmdbId={tmdbId}
          initialSeason={resume?.season}
          nextUp={resume}
          seasons={t.seasonList?.length ? t.seasonList : [{ number: 1, name: 'Season 1' }]}
          onPlay={(ep) => {
            const p = getProgress('tv', tmdbId, ep.season, ep.episode);
            setPlay({ season: ep.season, episode: ep.episode, startAt: p?.positionSec || 0, label: ep.title });
          }}
        />
      )}

      {full ? <CastRow credits={t.credits} /> : <CastRowSkeleton />}

      {(similar === undefined || similar.length > 0) && (
        <Row label="More like this" titles={similar || []} loading={similar === undefined} />
      )}

      {full && (
        <div className="facts enter">
          {t.genres?.length > 0 && (
            <div className="fact"><span className="k">Genres</span><span className="v">{t.genres.join(' · ')}</span></div>
          )}
          {t.director?.length > 0 && (
            <div className="fact"><span className="k">Director</span><span className="v">{t.director.join(', ')}</span></div>
          )}
          {t.writers?.length > 0 && (
            <div className="fact"><span className="k">Writers</span><span className="v">{t.writers.join(', ')}</span></div>
          )}
          {t.country?.length > 0 && (
            <div className="fact"><span className="k">Country</span><span className="v">{t.country.join(', ')}</span></div>
          )}
        </div>
      )}

      {play && (
        <Player
          title={t}
          season={play.season || 0}
          episode={play.episode || 0}
          startAt={play.startAt || 0}
          epTitle={play.label || null}
          onClose={() => {
            setPlay(null);
            setResume(isTv ? getNextUp(tmdbId, t.seasonList)
                           : getProgress(type, tmdbId, play.season || 0, play.episode || 0));
          }}
          onNext={isTv ? playNext : undefined}
        />
      )}
      <Toast message={toast} />
    </article>
  );
}

function TitleSkeleton() {
  return (
    <div className="detail title-skeleton" aria-busy="true" aria-label="Loading title">
      <div className="hero">
        <div className="hero-inner">
          <Skeleton className="hero-poster" />
          <div className="hero-text">
            <Skeleton variant="text" width="56%" height="2.4em" />
            <Skeleton variant="text" width="30%" style={{ marginTop: 16 }} />
            <div className="detail-meta"><Skeleton variant="text" width={210} /></div>
            <div style={{ marginTop: 22, maxWidth: 560 }}>
              <Skeleton variant="text" width="100%" />
              <Skeleton variant="text" width="94%" style={{ marginTop: 9 }} />
              <Skeleton variant="text" width="62%" style={{ marginTop: 9 }} />
            </div>
          </div>
          <div className="hero-actions"><div className="actions"><Skeleton width={150} height={46} /><Skeleton width={110} height={46} /></div></div>
        </div>
      </div>
      <CastRowSkeleton />
      <Row label="More like this" titles={[]} loading skeletonCount={6} />
    </div>
  );
}
