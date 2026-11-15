'use client';
import { useEffect, useState } from 'react';
import Icon from '../Icon';

/**
 * The player's overlays: the resolving progress, the end-of-episode card and
 * the error state. Presentational only - they hold no playback state.
 */
/**
 * What each provider is doing, right now.
 *
 * The log is a scrolling history; this is the current state at a glance. It
 * exists because "Opening vidking" could sit unchanged for twelve seconds
 * while that provider was merely QUEUED behind other work - a viewer reads
 * that as a stuck player. Showing queued / opening / found / failed per
 * provider makes the wait legible instead of mysterious.
 */
function ProviderTrack({ providers }) {
  if (!providers.length) return null;
  const LABEL = { queued: 'queued', opening: 'opening', validating: 'validating', ok: 'ready', failed: 'no stream' };
  return (
    <ul className="ov-track" aria-label="Provider progress">
      {providers.map(p => (
        <li key={p.name} className={`ov-track-row is-${p.state}`}>
          <span className="ov-track-dot" aria-hidden="true" />
          <span className="ov-track-name">{p.name}</span>
          <span className="ov-track-state">
            {LABEL[p.state]}
            {/* Position in the queue is the one number that explains a wait.
                Without it "queued" is just another word for "stuck".
                Held in its own span because the state word is uppercased and
                the figures must not be - "1.5S" and "2 AHEAD" read badly. */}
            {p.state === 'queued' && p.queued > 0 && (
              <span className="ov-track-num"> · {p.queued} ahead</span>
            )}
            {p.state === 'ok' && p.ms > 0 && (
              <span className="ov-track-num"> · {(p.ms / 1000).toFixed(1)}s</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One short, friendly status line. Internal words stay in Details. */
function statusLine(stage, providers) {
  if (stage === 1) return 'Checking playback…';
  if (stage === 2) return 'Starting…';
  return providers.some(p => p.state === 'failed') ? 'Trying another source…' : 'Getting your stream ready';
}

/**
 * Loading screen while a stream is resolved: blurred backdrop (Player.jsx),
 * one ring spinner, the title, one status line, and a source counter when the
 * provider count is known. Back is always there; Try again appears after 8s.
 * The provider track and log stay available under Details for debugging.
 */
export function Resolving({ stage, title, meta, elapsed = 0, log = [], providers = [], onArt = false,
                            onClose, onRetry }) {
  const secs = Math.floor(elapsed / 1000);
  const total = providers.length;
  const started = providers.filter(p => p.state !== 'queued').length;
  const status = statusLine(stage, providers);
  return (
    <div className={`overlay ov-screen${onArt ? ' on-art' : ''}`}>
      {onClose && (
        <button type="button" className="ov-back focusable" data-focus="" onClick={onClose} aria-label="Back">
          <Icon name="back" size={18} /><span>Back</span>
        </button>
      )}
      <div className="ov-card" role="status" aria-live="polite">
        <div className="ov-spinner" role="progressbar" aria-label={status} aria-valuetext={status} />
        <p className="ov-name">{title}</p>
        {meta && <p className="ov-meta">{meta}</p>}
        <p className="ov-status">{status}</p>
        {total > 1 && stage === 0 && (
          <p className="ov-count">Source {Math.max(1, started)} of {total}</p>
        )}
        {secs >= 8 && onRetry && (
          <div className="ov-actions" data-focus-group="">
            <button type="button" className="btn focusable" data-focus="" onClick={onRetry}>Try again</button>
          </div>
        )}
        {(total > 0 || log.length > 0) && (
          <details className="ov-details">
            <summary className="focusable" data-focus="">Details</summary>
            <ProviderTrack providers={providers} />
            {/* Older lines dim toward the top, via --age (see globals.css). */}
            <ul className="ov-log">
              {log.map((l, i) => (
                <li key={l.id} className="ov-log-line" style={{ '--age': log.length - 1 - i }}>{l.line}</li>
              ))}
            </ul>
            <p className="ov-hint dim ov-elapsed">{secs}s elapsed</p>
          </details>
        )}
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

export function PlayerError({ error, embeds, onClose, onRetry }) {
  const more = error.detail || error.tried?.length > 0;
  return (
    <div className="overlay ov-screen">
      <button type="button" className="ov-back focusable" data-focus="" onClick={onClose} aria-label="Back">
        <Icon name="back" size={18} /><span>Back</span>
      </button>
      <div className="ov-card ov-card-error" role="alert">
        <span className="ov-error-icon" aria-hidden="true">!</span>
        <p className="ov-name">Couldn’t start playback</p>
        <p className="ov-status">{error.message}</p>
        <div className="ov-actions" data-focus-group="">
          <button className="btn primary focusable" data-focus="" onClick={onRetry}>Retry</button>
          <button className="btn focusable" data-focus="" onClick={onClose}>Back</button>
        </div>
        {/* A configuration fault needs the specifics, or it reads as "the
            film is unavailable" when the deployment is simply misconfigured. */}
        {more && (
          <details className="ov-details">
            <summary className="focusable" data-focus="">Details</summary>
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
