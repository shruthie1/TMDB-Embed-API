'use client';
import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';

/**
 * The player's overlays: the resolving progress, the end-of-episode card and
 * the error state. Presentational only - they hold no playback state.
 */
/**
 * The loading screen, from the first press of Play to the first frame
 * (loading-ux spec; the APK draws the same view from LoadingModel.kt).
 *
 * Drawn from `view` (lib/player/loadingModel.js), so it holds no timing rules
 * of its own: no Try again while anything is still loading, a calm "Choose a
 * server" from 30s with a list, Try again at 30s only when no list arrived.
 * Only the headline is in the polite live region, so a screen reader hears a
 * phase change, not every tick of the seconds.
 */
const ROW_MARK = { waiting: '○', checking: '◌', starting: '●', playing: '✓', skipped: '-', failed: '✕' };

export function Loading({ view, title, meta, onArt = false, onClose, onRetry, onPick, onChooseServer }) {
  const [open, setOpen] = useState(false);
  const [focusRow, setFocusRow] = useState(false);
  const rowsRef = useRef(null);
  const detailsRef = useRef(null);
  // TV: focus starts on Details (OK opens it) and never jumps later.
  useEffect(() => {
    if (document.documentElement.dataset.tv === 'true') detailsRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!open || !focusRow) return;
    setFocusRow(false);
    const btns = [...(rowsRef.current?.querySelectorAll('button[data-row]') || [])];
    const first = btns.find((b) => b.dataset.state === 'waiting' && b.getAttribute('aria-disabled') !== 'true')
      || btns.find((b) => b.getAttribute('aria-disabled') !== 'true');
    first?.focus();
  }, [open, focusRow]);
  if (!view) return null;
  return (
    <div className={`overlay ov-screen ov-resolving${onArt ? ' on-art' : ''}`} data-phase={view.phase}>
      {onClose && (
        <button type="button" className="ov-back focusable" data-focus="" onClick={onClose} aria-label="Back">
          <Icon name="back" size={18} /><span>Back</span>
        </button>
      )}
      <div className="ov-card">
        <div className="ov-spinner" aria-hidden="true" />
        <p className="ov-name">{title}</p>
        {meta && <p className="ov-meta">{meta}</p>}
        <p className="ov-status" role="status" aria-live="polite" aria-atomic="true">{view.headline}</p>
        {view.detail && <p className="ov-load-detail">{view.detail}</p>}
        <div className="ov-actions" data-focus-group="">
          {view.showTryAgain && onRetry && (
            <button type="button" className="ov-pill focusable" data-focus="" onClick={onRetry}>
              <Icon name="restart" size={18} /><span>Try again</span>
            </button>
          )}
          {view.showChooser && (
            <button type="button" className="ov-pill focusable" data-focus=""
                    data-action="choose-server" onClick={() => { if (onChooseServer) onChooseServer(); else { setOpen(true); setFocusRow(true); } }}>
              <span>Choose a server</span>
            </button>
          )}
          {onClose && (
            <button type="button" className="ov-pill ov-pill-tv focusable" data-focus="" onClick={onClose}>
              <Icon name="back" size={18} /><span>Back</span>
            </button>
          )}
          <button type="button" className="ov-pill ov-pill-quiet focusable" data-focus=""
                  ref={detailsRef} aria-expanded={open} aria-controls="load-rows"
                  onClick={() => setOpen((o) => !o)}>
            <span>Details</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
          </button>
        </div>
        <div className="ov-load-panel" id="load-rows" hidden={!open} ref={rowsRef}>
          <ul className="ov-load-rows">
            {view.rows.map((r) => (
              <li key={r.id}>
                <button type="button" data-row={r.id} data-state={r.state}
                        className={`ov-load-row is-${r.state}${r.clickable ? ' focusable' : ''}`}
                        data-focus={r.clickable ? '' : undefined}
                        aria-label={r.description}
                        aria-disabled={r.clickable ? undefined : 'true'}
                        onClick={r.clickable ? () => onPick?.(r.id) : undefined}>
                  <span className="ov-load-mark" aria-hidden="true">{ROW_MARK[r.state] || '○'}</span>
                  <span className="ov-load-title">{r.title}</span>
                  <span className="ov-load-state">{r.status}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="ov-load-footer">{view.footer}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * End-of-episode card with an autoplay countdown.
 *
 * Counts down rather than cutting straight to the next episode, so stopping is
 * always possible - the remote is across the room on a TV. Any key or a click
 * cancels; Enter plays immediately. Respects reduced-motion by not autoplaying
 * at all, since an unexpected transition is exactly what that setting is for.
 */
const AUTOPLAY_SECS = 10;

export function NextUp({ ep, onPlay, onDismiss }) {
  const reduced = typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [left, setLeft] = useState(AUTOPLAY_SECS);
  const [held, setHeld] = useState(reduced);

  useEffect(() => {
    if (held) return;
    if (left <= 0) { onPlay(); return; }
    const id = setTimeout(() => setLeft(n => n - 1), 1000);
    return () => clearTimeout(id);
  }, [left, held, onPlay]);

  // Any interaction stops the countdown - never yank control away.
  useEffect(() => {
    const stop = (e) => {
      if (e.key === 'Escape') { onDismiss(); return; }
      // Enter is deliberately NOT handled here. It used to be, globally, so
      // pressing OK on "Not now" fired onPlay() from this listener AND
      // onDismiss() from the button - declining the next episode could start
      // it anyway. The buttons carry their own activation; a countdown only
      // needs cancelling.
      setHeld(true);
    };
    window.addEventListener('keydown', stop);
    return () => window.removeEventListener('keydown', stop);
  }, [onPlay, onDismiss]);

  return (
    <div className="overlay nextup" role="dialog" aria-label="Next episode">
      <p className="ov-eyebrow">Next episode</p>
      <p className="ov-title">S{ep.season}E{ep.episode} · {ep.title}</p>
      <div className="actions nextup-actions">
        <button className="btn primary focusable" data-focus="" onClick={onPlay} autoFocus>
          {held ? 'Play next' : `Play next · ${left}s`}
        </button>
        <button className="btn focusable" data-focus="" onClick={onDismiss}>Not now</button>
      </div>
      {!held && (
        <div className="nextup-bar" aria-hidden="true">
          <i style={{ animationDuration: `${AUTOPLAY_SECS}s` }} />
        </div>
      )}
    </div>
  );
}

/** Never a dead end: retry, then a manual provider picker. */
/**
 * Last resort: play the title in the provider's own embedded player.
 *
 * Offered only after our own playback has failed, because the trade is real -
 * inside the frame THEIR player owns seeking, quality, audio and the language
 * switcher, and watch position is not recorded. It stays SANDBOXED: some
 * providers refuse to run that way (mapple shows "Sandbox Detected"), and the
 * right answer there is that they are not embeddable, not that we drop the
 * protection. Their pages inject popunders at runtime - the same hosts our
 * extractor blocks - which would then be free to navigate the viewer's tab.
 */
export function EmbedFallback({ embeds, onClose }) {
  const [active, setActive] = useState(null);
  if (!embeds?.length) return null;

  if (active) {
    return (
      <div className="embed-wrap">
        <div className="embed-bar">
          <span>Playing on {active.provider}. Their player, their controls —
            your place in the film is not saved.</span>
          <button className="btn focusable" data-focus="" onClick={() => setActive(null)}>Back</button>
          <button className="btn focusable" data-focus="" onClick={onClose}>Close</button>
        </div>
        <iframe className="embed-frame" src={active.url} title={`${active.provider} player`}
          allow="autoplay; fullscreen; encrypted-media" referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" />
      </div>
    );
  }
  return (
    <div className="actions ov-embeds">
      {embeds.map(e => (
        <button key={e.provider} className="btn focusable" data-focus=""
          onClick={() => setActive(e)}>Try {e.provider}’s player</button>
      ))}
    </div>
  );
}

export function PlayerError({ error, embeds, onClose, onRetry, headline = null, detail = null }) {
  // With sources tried, the card says how many (loading-ux end card); the
  // player's own message moves under Details.
  const more = error.detail || error.tried?.length > 0 || Boolean(detail);
  return (
    <div className="overlay ov-screen">
      <button type="button" className="ov-back focusable" data-focus="" onClick={onClose} aria-label="Back">
        <Icon name="back" size={18} /><span>Back</span>
      </button>
      <div className="ov-card ov-card-error" role="alert">
        <span className="ov-error-icon" aria-hidden="true">!</span>
        <p className="ov-name">{headline || 'Couldn’t start playback'}</p>
        <p className="ov-status">{detail || error.message}</p>
        <div className="ov-actions" data-focus-group="">
          <button className="btn primary focusable" data-focus="" onClick={onRetry}>Retry</button>
          <button className="btn focusable" data-focus="" onClick={onClose}>Back</button>
        </div>
        {/* A configuration fault needs the specifics, or it reads as "the
            film is unavailable" when the deployment is simply misconfigured. */}
        {more && (
          <details className="ov-details">
            <summary className="focusable" data-focus="">Details</summary>
            {detail && error.message && <p className="ov-hint dim">{error.message}</p>}
            {error.detail && <p className="ov-hint dim">{error.detail}</p>}
            {error.tried?.length > 0 && <p className="ov-hint dim">Tried: {error.tried.join(', ')}</p>}
          </details>
        )}
        {/* Only after our own player has failed. */}
        <EmbedFallback embeds={embeds} onClose={onClose} />
        {error.providers?.length > 0 && (
          <div className="providers">
            <p className="ov-hint dim">Or open a source directly:</p>
            <div className="provider-list">
              {error.providers.map(p => (
                <a key={p.name} className="chip focusable" data-focus="" href={p.url} target="_blank" rel="noreferrer">
                  {p.name}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
