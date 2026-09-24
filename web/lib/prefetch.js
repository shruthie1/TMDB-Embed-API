'use client';

/**
 * Pre-resolve on intent.
 *
 * A cold resolve is 6-37s (measured: Irumudi 36.6s), which is unacceptable
 * after a click. But browsing gives us seconds of warning: a hover, or D-pad
 * focus dwelling on a card. We spend that time resolving in the background so
 * the click usually lands on a warm cache (~2s).
 *
 * The dwell timer below is kept because it is the half that still works and
 * costs nothing: it is the resolve itself that has no endpoint. The inflight
 * cap, the asked-set and the key helper went with it - reinstate them together
 * with a real speculative resolve, not before.
 */
const DWELL_MS = 600;

/**
 * Fire-and-forget resolve. Resolves nothing to the caller by design.
 *
 * CURRENTLY A NO-OP. Prewarming needs an endpoint that resolves WITHOUT
 * claiming a viewer slot, and the local backend has none: the VM's
 * `/api/resolve?background=1` went away with the resolver on 2026-09-22 and
 * every call 404'd from then on - measured, all 8 VM paths 404 on :8790 while
 * only /api/providers answers. So this cost one failed request per hovered
 * card and warmed nothing.
 *
 * Deliberately NOT repointed at `/api/streams/:type/:id`. That is the real
 * playback resolve with no background flag, so hovering a row of cards would
 * start full extractions for titles nobody clicked - the exact thing the
 * `background=1` vantage existed to prevent. Restore this once the backend
 * offers a speculative resolve.
 */
export function preresolve() { /* no speculative resolve endpoint */ }

/**
 * Attach dwell-based intent handlers to an element.
 * Returns props to spread — hover for pointers, focus for D-pad.
 */
export function intentProps(type, tmdbId, opts) {
  let timer = null;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(() => preresolve(type, tmdbId, opts), DWELL_MS);
  };
  const stop = () => clearTimeout(timer);
  return {
    onMouseEnter: start,
    onMouseLeave: stop,
    onFocus: start,
    onBlur: stop,
    onTouchStart: start,
  };
}

/** Warm the most likely next plays on app launch (top of Continue Watching). */
export function warmContinueWatching(items = [], limit = 2) {
  items.slice(0, limit).forEach(p =>
    preresolve(p.mediaType, p.tmdbId, { season: p.season, episode: p.episode })
  );
}
