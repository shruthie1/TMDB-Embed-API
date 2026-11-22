'use client';
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchTitle, fetchTitleFull, poster } from '../../../../lib/api';
import { posterSources } from '../../../../lib/posterSources';
import TitleLogo from '../../../../components/TitleLogo';
import dynamic from 'next/dynamic';
import ErrorBoundary from '../../../../components/ErrorBoundary';
import CastRow, { CastRowSkeleton } from '../../../../components/CastRow';
import EpisodeList, { EpisodeListSkeleton } from '../../../../components/EpisodeList';
import { Row } from '../../../../components/Row';
import { Button, Badge, Skeleton, Toast } from '../../../../components/ui';
import { getProgress, getNextUp } from '../../../../lib/progress';
import { inList, toggleList } from '../../../../lib/list';
import { prewarmStreams } from '../../../../lib/backend';
import { languageName } from '../../../../lib/subtitles';
import Icon from '../../../../components/Icon';
import { HeroInnerSkeleton, FactsSkeleton, useTitleSeed } from '../../../../components/TitleSkeleton';
import HeroBackdrop from '../../../../components/HeroBackdrop';
import ErrorScreen from '../../../../components/ErrorScreen';
import { EARLY_TITLE_SCRIPT } from '../../../../lib/earlyRows';

// The player is about 55kB of this route's JS and only mounts after Play. As a
// static import it rode the first load, so on a phone the page hydrated (and
// the title data request started) about a second later. It loads during the
// reading dwell instead (see the warm-up effect below).
const loadPlayer = () => import('../../../../components/Player');
const Player = dynamic(loadPlayer, {
  ssr: false,
  // Play pressed before the chunk arrived: the player's own dark frame and
  // spinner, not a page that seems to ignore the press.
  loading: () => (
    <div className="player" role="dialog" aria-modal="true" aria-label="Loading player">
      <div className="pbuffering" role="status"><div className="pspinner" /><span className="sr-only">Loading</span></div>
    </div>
  ),
});

// Measures before paint in the browser; useLayoutEffect warns during SSR.

const useBrowserLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

function runtime(min) {
  if (!min) return null;
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

// fetchpriority puts the poster ahead of the rows below the fold; the shimmer
// covers the wait so the box is never a flat dark tile.
function HeroPoster({ title, placeholder = null }) {
  // Chosen once per title: the cache check must not flip mid-load, and the
  // full record's poster url must not remount a poster that already shows.
  const [sources, setSources] = useState(() => posterSources(title));
  const [n, setN] = useState(0);
  const [loading, setLoading] = useState(true);
  const src = sources[n];
  // A cached image can finish before React attaches onLoad.
  const ref = useCallback(img => { if (img?.complete && img.naturalWidth) setLoading(false); }, []);
  // The fast record can carry Cinemeta's metahub URL, which on some networks
  // hangs with no error, so onError never fires. While nothing shows yet,
  // switch to the full record's TMDB poster as soon as it arrives.
  useEffect(() => {
    if (!loading) return;
    const next = posterSources(title).filter(u => !sources.includes(u));
    if (next.length) { setSources([...next, ...sources.slice(n)]); setN(0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, loading]);
  // Last source failed too: drop the img so no broken-image icon shows.
  // Every source failed: try any the full record added before giving up.
  const onError = () => {
    if (n + 1 >= sources.length) {
      const extra = posterSources(title).filter(u => !sources.includes(u));
      if (extra.length) setSources([...sources, ...extra]);
      else setLoading(false);
    }
    setN(n + 1);
  };
  // No .enter fade: the poster replaces a skeleton box, and a fade from 0
  // read as a flash on arrival.
  return (
    // The tapped card's poster (already cached) fills the box until the
    // detail-size image has loaded, so the poster never blinks to a shimmer.
    <div className={`hero-poster${loading && !placeholder ? ' loading' : ''}${loading && placeholder ? ' seeded' : ''}`}
         style={loading && placeholder ? { backgroundImage: `url(${placeholder})` } : undefined}>
      {src && (
        <img key={src} ref={ref} src={src} alt="" width="342" height="513" decoding="async"
             fetchpriority="high" onLoad={() => setLoading(false)} onError={onError} />
      )}
    </div>
  );
}

export default function TitlePage() {
  const { type, id } = useParams();
  const router = useRouter();
  const tmdbId = Number(id);
  // What the tapped card knew (name, poster, backdrop); null on a hard load.
  const seed = useTitleSeed(type, id);

  const [t, setT] = useState(null);
  const [full, setFull] = useState(false);
  const [similar, setSimilar] = useState(undefined);
  const [overviewOpen, setOverviewOpen] = useState(false);
  // Desktop/TV clamp the synopsis to its reserved three lines; Read more only
  // shows when that clamp actually hides text.
  const [overviewClamped, setOverviewClamped] = useState(false);
  const overviewRef = useRef(null);
  const [play, setPlay] = useState(null);      // {season, episode, startAt} | null
  const [resume, setResume] = useState(null);
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState(null);
  // Set only when BOTH title requests failed: without it a failed or timed-out
  // API left the skeleton up forever, which read as a click that did nothing.
  const [loadError, setLoadError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  // Opening a card from "More like this" swaps the route params but keeps this
  // page mounted, so the scroll position carried over and the new title opened
  // scrolled to the bottom. Reset to the top whenever the title id changes.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [type, id]);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    // Fast record first for an early paint, but it is only worth the extra
    // request while it actually arrives sooner; the full one overwrites it.
    const fast = fetchTitle(type, id).then(r => { if (alive && r.ok) setT(v => v ?? r.body); return r; });
    fetchTitleFull(type, id).then(async r => {
      if (!alive) return;
      if (!r.ok) {
        const f = await fast;
        if (alive && !f.ok && !r.aborted) {
          console.warn('[title] load failed', type, id, r.status || r.error, f.status || f.error);
          setLoadError({ message: r.error || `title request failed (${r.status})` });
        }
        return;
      }
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
  }, [type, id, tmdbId, attempt]);

  // The detail page is already a strong play intent: the viewer has opened a
  // title, then usually spends a few seconds reading before pressing Resume.
  // Warm the resolver during that natural dwell so the click does not pay a
  // cold fan-out (prod p50 6-14s). Play joins the request if it is still
  // running (lib/backend.js prewarmStreams).
  useEffect(() => {
    if (!t || !full) return;
    const target = type === 'tv'
      ? { season: resume?.season ?? 1, episode: resume?.episode ?? 1 }
      : {};
    // Same key the Player's resolve uses (title.mediaType/tmdbId), so Play
    // joins this request or reads its cached answer.
    const timer = setTimeout(() => prewarmStreams(t.mediaType, t.tmdbId, target), 700);
    // The player and hls.js (about 180kB) download during the same reading
    // dwell, so Play waits only for media. Not at once: fetched with the
    // record they took a phone's bandwidth from the backdrop and poster
    // (LCP 5.2s on Slow 4G). After the page load event plus a short wait.
    let code;
    const loadCode = () => {
      code = setTimeout(() => { loadPlayer().catch(() => {}); import('hls.js').catch(() => {}); }, 1500);
    };
    if (document.readyState === 'complete') loadCode();
    else window.addEventListener('load', loadCode, { once: true });
    return () => { clearTimeout(timer); clearTimeout(code); window.removeEventListener('load', loadCode); };
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

  useBrowserLayoutEffect(() => {
    const el = overviewRef.current;
    if (!el) return undefined;
    const check = () => {
      if (!el.classList.contains('expanded')) setOverviewClamped(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [t?.overview]);

  if (!t && loadError) return <ErrorScreen error={loadError} onRetry={() => setAttempt(n => n + 1)} />;

  // What the Play button does, and what it should say. For a series this is
  // an episode; for a film, a position. Falls back to S1E1 for a new show.
  const isTv = type === 'tv';
  // First child of both returns, so the slots below keep their positions.
  // On a hard load it requests the record before hydration (earlyRows.js);
  // inert after that.
  const early = <script dangerouslySetInnerHTML={{ __html: EARLY_TITLE_SCRIPT }} suppressHydrationWarning />;
  const backButton = (
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
  );

  // Loading: the same article, hero and backdrop element the loaded page
  // uses, so React keeps them mounted when the data lands. A separate
  // skeleton tree unmounted the backdrop and repainted it from black.
  // The children below sit in the SAME slots as the loaded return (Back, hero,
  // episodes, cast, More like this, facts): React matches by position, so a
  // slot that moved remounted its row and its fade replayed (measured: the
  // "More like this" section was replaced when the title landed).
  if (!t) {
    return (
      <article className="detail title-skeleton" aria-busy="true" aria-label="Loading title">
        {early}
        {backButton}
        <div className="hero">
          <HeroBackdrop path={seed?.backdrop || null} />
          <HeroInnerSkeleton seed={seed} />
        </div>
        {isTv && <EpisodeListSkeleton />}
        <CastRowSkeleton />
        <Row label="More like this" titles={[]} loading />
        <FactsSkeleton />
      </article>
    );
  }

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

  const pos = t.poster ? poster(t.poster, 'w342') : null;
  const meta = [
    t.year,
    runtime(t.runtimeMin),
    t.rating ? `★ ${Number(t.rating).toFixed(1)}` : null,
  ].filter(Boolean);

  return (
    <article className="detail">
      {early}
      {backButton}
      <div className="hero">
        <HeroBackdrop path={t.backdrop || null} />
        <div className="hero-inner">
          {pos && (
            <HeroPoster key={`${type}/${id}`} title={t} placeholder={seed?.posterSrc || null} />
          )}
          <div className="hero-text">
            <h1 className={`detail-title${t.logo ? ' has-logo' : ''}`}><TitleLogo title={t.title} logo={t.logo} /></h1>
            {/* Always rendered: the line is reserved on desktop/TV so the
                tagline, which only the full record carries, lands in place. */}
            <p className="tagline">
              {t.tagline || (!full && <span className="skel skel-line" style={{ width: '32%' }} />)}
            </p>

            <div className="detail-meta">
              {meta.map((m, i) => <span key={i}>{m}</span>)}
              {t.originalLang && <span><Badge>{languageName(t.originalLang)}</Badge></span>}
              {!full && <span><Skeleton variant="text" width={54} style={{ display: 'inline-block' }} /></span>}
            </div>

            {t.overview && (
              <>
                <p ref={overviewRef} className={`detail-overview${overviewOpen ? ' expanded' : ''}`}>
                  {t.overview}
                </p>
                <button
                  type="button"
                  className="detail-overview-toggle focusable"
                  data-focus=""
                  aria-expanded={overviewOpen}
                  data-clamped={overviewClamped || overviewOpen ? '' : undefined}
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

      {isTv && (full ? (
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
      ) : <EpisodeListSkeleton />)}

      {full ? <CastRow credits={t.credits} /> : <CastRowSkeleton />}

      {(similar === undefined || similar.length > 0) && (
        <Row label="More like this" titles={similar || []} loading={similar === undefined} />
      )}

      {full ? (
        <div className="facts">
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
      ) : <FactsSkeleton />}

      {play && (
        <ErrorBoundary label="the player" onClose={() => setPlay(null)}>
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
        </ErrorBoundary>
      )}
      <Toast message={toast} />
    </article>
  );
}
