/**
 * Web direct-vs-proxy decision for one row (owner rule 2026-11-21: proxy only
 * when required; the provider config on the server says when).
 *
 * The API row keeps its proxied `url` (masterUrl here) and, when the server's
 * lib/routing/providerRoutes.js marks the provider web-direct, also carries
 * `directUrl` (webDirectUrl here). A browser cannot set Referer, so only rows
 * the config marks web-direct ever get one.
 *
 * Direct is tried first. If it fails before the first frame, the SAME row is
 * retried once through the proxy before the player fails over to another
 * server. A row that failed direct stays on the proxy for this page session.
 */

export const DIRECT_FIRST_FRAME_MS = 10000;
// P6 (2026-11-22): before the first frame, a direct row that has received NO
// bytes for this long goes to the proxy now instead of waiting out the 10 s
// cap (Krack on 1.2.48: multimovies direct sat 10 s, total 15.9 s). A slow row
// that IS receiving bytes keeps the 10 s cap.
export const DIRECT_NO_BYTES_MS = 4000;

const failed = new Set();
const rowKey = (s) => `${s?.id ?? ''}|${s?.webDirectUrl ?? ''}`;

export function markDirectFailed(src) { failed.add(rowKey(src)); }
export function _resetDirectFailures() { failed.clear(); }

/** @returns {{url: string, mode: 'direct'|'proxy', reason: string}} */
export function planPlayUrl(src) {
  const direct = src?.webDirectUrl || null;
  const proxy = src?.masterUrl || null;
  if (!direct) return { url: proxy, mode: 'proxy', reason: 'config-proxy' };
  if (!proxy) return { url: direct, mode: 'direct', reason: 'config-direct' };
  if (failed.has(rowKey(src))) return { url: proxy, mode: 'proxy', reason: 'direct-failed-before' };
  return { url: direct, mode: 'direct', reason: 'config-direct' };
}

// Only a FATAL error (hls.js gave up, or useHls escalated repeated manifest
// failures to fatal) counts. hls.js retries non-fatal load errors itself, and
// one transient fragment error must not pin the row to the proxy.
export function isEarlyFailure(data, firstFrame) {
  if (firstFrame) return false;
  return Boolean(data?.fatal);
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return '?'; }
}

/** One greppable line per routing decision. */
export function logRoute(event, src, extra = '') {
  try {
    console.info(`[route] web ${event} provider=${src?.provider ?? '?'} host=${hostOf(src?.webDirectUrl || src?.masterUrl)}${extra ? ` ${extra}` : ''}`);
  } catch { /* logging must never break playback */ }
}
