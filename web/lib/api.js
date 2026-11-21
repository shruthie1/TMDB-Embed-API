// Chitram API client.
//
// Metadata is served by Next.js route handlers; streams come from the local
// Express backend on API_ORIGIN (see lib/backend.js). There is no VM resolver
// any more - it was removed 2026-09-22 once useResolve was already importing
// resolveLive from lib/backend.js and nothing called the VM relay's
// resolveStreamLive. Anything still spelled `/api/vm` below is a leftover
// endpoint with no local equivalent, and the caller treats a failure as
// "no data", never as an error.

import { abortReason, isAbort } from './abortReason';

// Endpoints that only ever existed on the VM: /api/stats, /api/validate,
// /api/sources and /api/embed. The local backend has none of them, so these
// calls now fail fast and their callers fall back to empty - measured
// 2026-09-22: /api/stats, /api/validate, /api/sources, /api/embed all 404 on
// :8790, while /api/providers is present and is served locally instead.
// REMOVED: `export const VM = '/api/vm'`.
//
// Nothing behind that prefix exists. Measured 2026-09-22 against :8790 - all of
// /api/resolve, /api/sources, /api/stats, /api/validate, /api/embed,
// /api/health/providers and /api/playback-report answer 404; only
// /api/providers is served, and it is reached directly. Every remaining caller
// has been repointed or retired, so the constant is gone to stop a new one
// being written against a prefix that cannot work.

/**
 * REMOVED: isResolverInsecure().
 *
 * It answered "would the browser's own mixed-content policy block this fetch?"
 * — true when an https page held an http resolver base. Both halves of that
 * question are now gone from the browser: resolve, progress and the stream go
 * to same-origin `/api/...`, so the scheme always matches the page by
 * construction and the browser never learns the resolver's address.
 *
 * It is NOT rewritten to check the server's configured origin instead, because
 * that is a different fact with a different answer. Node's fetch has no
 * mixed-content rule, so a server-side http:// hop to the VM is not an error at
 * all — it is the normal deployment (the tunnel is https, the bare VM is
 * `http://187.127.137.85:7801`). A guard reused under the new meaning would
 * refuse to play on a configuration that works, which is worse than the opaque
 * "failed to fetch" it was written to explain.
 *
 * A genuinely unreachable resolver still surfaces: the relay answers 502 with
 * `{error: 'resolver unreachable'}` and the stream's `!res.ok` path reports it
 * as "resolver responded 502" rather than a blank failure.
 */

export const IMG = 'https://image.tmdb.org/t/p';

/**
 * TMDB image url sized for the surface. The old rule was "never `original`".
 * Owner, 2026-11-21: the desktop/TV hero uses `original` (TMDB has no 1920
 * size; w1280 upscaled 1.5x on a 1920 screen). The browser scales it to the
 * element box. Keep `original` to that one hero element; cards use srcset.
 */
export function poster(path, size = 'w342') {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `${IMG}/${size}${path}`;
}

/** Card poster widths. The browser picks one from `sizes` and the screen DPR. */
export const POSTER_WIDTHS = [342, 500, 780];

/**
 * Card `sizes`, from globals.css: phones (<=559px) show a 3-column grid or a
 * 132px rail card (both about 33vw); TV rails are 290px; desktop rails are
 * 176px and grid cells up to about 200px.
 */
export const CARD_SIZES = '(max-width:559px) 34vw, (min-width:1700px) 290px, 200px';

/** srcset for a TMDB poster path; null for a full url (no other sizes exist). */
export function posterSrcSet(path) {
  if (!path || path.startsWith('http')) return null;
  return POSTER_WIDTHS.map(w => `${IMG}/w${w}${path} ${w}w`).join(', ');
}

/** Hero backdrop: phones w1280 (400 CSS px x3), wider screens `original`. */
export function heroBackdrop(path, narrow) {
  return poster(path, narrow ? 'w1280' : 'original');
}

/** Title logo (transparent png), w500. */
export function logoUrl(path) {
  return poster(path, 'w500');
}

async function getJson(url, { timeoutMs = 15000, signal } = {}) {
  const ctrl = new AbortController();
  // Always abort WITH a reason: a bare abort() reports as "signal is aborted
  // without reason" in Next's dev overlay even though the catch below handles
  // it. See lib/abortReason.js.
  const timer = setTimeout(() => ctrl.abort(abortReason(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ctrl.abort(signal.reason ?? abortReason('caller cancelled'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, body: await res.json().catch(() => null) };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (err) {
    // Every abort used to report as 'timeout', including a caller cancel on
    // unmount - so a navigation away looked like a slow backend in the log.
    // The reason now says which it was.
    if (isAbort(err)) return { ok: false, status: 0, aborted: true, error: err.message || 'cancelled' };
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
    // The listener outlived the request otherwise: a long-lived caller signal
    // (a page-level controller) accumulated one per fetch.
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Fast record for cards: Cinemeta-first, ~0.02s warm. */
export const fetchTitle = (type, id, opts) =>
  getJson(`/api/title/${type}/${id}`, opts);

/** Full record for the detail page: adds runtime, genres, language. */
export const fetchTitleFull = (type, id, opts) =>
  getJson(`/api/title/${type}/${id}/full`, opts);

/** `opts.query` is a prepared query string, e.g. prefsQuery(getPrefs()). */
export const fetchRow = (kind, opts = {}) =>
  getJson(`/api/rows/${kind}${opts.query ? `?${opts.query}` : ''}`, opts);

/** `opts.langs` ranks those original languages first. */
export const searchTitles = (q, opts = {}) =>
  getJson(`/api/search?q=${encodeURIComponent(q)}${
    opts.langs?.length ? `&langs=${opts.langs.join(',')}` : ''}`, opts);


/**
 * Resolve with LIVE progress. Streams real resolver events over SSE so the UI
 * can report which provider is being tried and whether it worked — not a guess.
 * Falls back to the plain JSON endpoint if EventSource is unavailable.
 * @returns {() => void} cancel
 */
export function playableUrl(masterUrl, referer) {
  // Do not set direct=1 here. It is suitable for native clients, which can
  // fetch CDN media without browser CORS/Referer restrictions, but not for the
  // web player. The default rewrite sends init segments and media segments to
  // /api/seg, where the resolver can add the provider Referer.
  const q = new URLSearchParams({ u: masterUrl });
  if (referer) q.set('r', referer);
  // Same-origin, like every other call the browser makes. The relay adds the
  // VM origin server-side, so the tunnel hostname never reaches the client.
  return `/api/m3u8?${q}`;
}

/** Last-resort proxy for segments a CDN refuses to serve to a browser. */
export function proxiedSegment(url, referer) {
  const q = new URLSearchParams({ u: url });
  if (referer) q.set('r', referer);
  return `/api/seg?${q}`;
}

/**
 * Provider health, for explaining a failure honestly.
 * `healthy` is null until there is enough evidence (>=5 attempts) — render
 * "not enough data" rather than inventing a verdict from one lucky attempt.
 * It is true if ANY vantage works: a provider reachable from the device but
 * not the VM (or vice versa) is still usable.
 */
export const fetchProviderHealth = (opts) =>
  getJson('/api/providers', { timeoutMs: 8000, ...opts });


/**
 * Every source the resolver currently holds for a title.
 *
 * Read-only: it reports what has landed, and never starts a resolve. Opening
 * the settings sheet to check the quality should not spend a browser context.
 *
 * This replaces relying on the live progress feed to populate the source
 * picker. The background quality upgrade finishes seconds AFTER playback
 * starts, and a bounded poller could miss it three ways - its 45s window
 * expiring, the server's 60s progress retention lapsing, or a cursor
 * desyncing - each of them silently. Fetching when the sheet opens has one
 * failure mode, and reopening the sheet retries it.
 */
export async function listSources() {
  // The resolver that held a source inventory is gone, and the local backend
  // has no read-only equivalent - `/api/sources/...` 404s on :8790 (measured
  // 2026-09-22). Every call spent a request to learn nothing.
  //
  // Returns null, which this function has always used to mean "could not ask"
  // as distinct from "none exist", so the settings sheet keeps showing the
  // sources it already resolved instead of blanking to an empty list.
  return null;
}

/**
 * Tell the resolver what actually happened when we tried to play a source.
 *
 * The resolver's own `validated_at` only means a segment range request
 * returned bytes FROM THE VM. It says nothing about whether the stream plays
 * on a viewer's device: Karuppu's mapple row validated fine and then stalled,
 * while vidking played immediately. The browser is the only thing that knows,
 * and until now that knowledge died with the tab.
 *
 * Fire-and-forget by design. A report must never delay a frame, never surface
 * an error, and never block a source switch - the viewer's playback matters
 * and this does not. When a transport returns it needs `keepalive`, so a
 * report sent as the player tears down still leaves the browser.
 */
export function reportPlayback({ mediaType, tmdbId, season = 0, episode = 0,
                                 provider, ok, reason, startupMs = 0, waitMs = 0,
                                 stallCount = 0, stallMs = 0, recoveryCount = 0,
                                 device = null, connection = null,
                                 mediaIdentity = null, mediaUrl = null,
                                 audioLang = null, langOk = null }) {
  if (!provider || !tmdbId) return;
  // Sink: POST /api/playback-report on the Express backend (apiServer.js),
  // which writes source_stats (learned ranking) and, when langOk is a
  // boolean, audio_evidence. The server bounds every field.
  //
  // mediaUrl is the stream url the player was handed; the server reduces it to
  // a media identity (host + path, signature dropped) and never stores it.
  try {
    if (typeof fetch !== 'function') return;
    fetch('/api/playback-report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // keepalive: a report sent as the player tears down still leaves.
      keepalive: true,
      body: JSON.stringify({
        tmdbId, type: mediaType, season, episode, provider, mediaIdentity, mediaUrl,
        playedOk: ok === true, ok: ok === true, reason, startupMs, waitMs,
        stallCount, stallMs, recoveryCount, audioLang,
        langOk: typeof langOk === 'boolean' ? langOk : null,
        device, connection,
      }),
    }).catch(() => {});
  } catch {
    // Telemetry must never break playback.
  }
}
