'use strict';

// Signed CDN URLs often carry their own expiry in the query string. A cached
// stream served after that moment plays as a 403 (common after a resume). These
// helpers read the expiry so the caches can drop a dead URL and re-resolve.
//
// Forms read (from the sibling ott repo's resolver/urlexpiry.js, which measured
// 0 of 86 signed URLs alive past their stated expiry):
//   e=<epoch>            expire=<epoch>       internal_token=v<N>.<13-digit ms>
// <epoch> may be seconds (10 digits) or milliseconds (13 digits).
// Proxied URLs (/m3u8-proxy?url=<encoded upstream>) are decoded so the
// upstream's own expiry is found.

const DEFAULT_SKEW_MS = 30 * 1000;
// Sanity bounds. A value outside them is some other number that happens to sit
// in an `e=` param, not an expiry.
const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

const PARAM_RE = /(?:^|[?&#;])(?:e|exp|expire|expires)=(\d{9,13})(?=$|[&#;])/gi;
const TOKEN_RE = /internal_token=v\d+\.(\d{13})(?!\d)/g;

function toMs(digits) {
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return digits.length >= 12 ? n : n * 1000;
}

function decodedForms(url) {
  const forms = [url];
  let cur = url;
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(cur); } catch { break; }
    if (next === cur) break;
    forms.push(next);
    cur = next;
  }
  return forms;
}

// Epoch ms at which the URL stops working, or null when it states none. With
// several candidates (a proxy URL wrapping a signed one) the earliest wins.
function urlExpiresAt(url, now = Date.now()) {
  if (typeof url !== 'string' || !url) return null;
  let best = null;
  const consider = (digits) => {
    const ms = toMs(digits);
    if (ms == null || ms < now - MAX_PAST_MS || ms > now + MAX_FUTURE_MS) return;
    if (best == null || ms < best) best = ms;
  };
  for (const s of decodedForms(url)) {
    for (const m of s.matchAll(PARAM_RE)) consider(m[1]);
    for (const m of s.matchAll(TOKEN_RE)) consider(m[1]);
  }
  return best;
}

// True when the URL is past (or within skewMs of) its stated expiry. A URL
// with no stated expiry is never called expired.
function isUrlExpired(url, skewMs = DEFAULT_SKEW_MS, now = Date.now()) {
  const exp = urlExpiresAt(url, now);
  return exp != null && exp - skewMs <= now;
}

function streamUrl(s) {
  return s && typeof s === 'object' && typeof s.url === 'string' ? s.url : null;
}

// Earliest stated expiry across a list of stream rows, or null.
function earliestStreamExpiry(streams, now = Date.now()) {
  if (!Array.isArray(streams)) return null;
  let best = null;
  for (const s of streams) {
    const exp = urlExpiresAt(streamUrl(s), now);
    if (exp != null && (best == null || exp < best)) best = exp;
  }
  return best;
}

function anyStreamExpired(streams, skewMs = DEFAULT_SKEW_MS, now = Date.now()) {
  return Array.isArray(streams) && streams.some((s) => isUrlExpired(streamUrl(s), skewMs, now));
}

function dropExpiredStreams(streams, skewMs = DEFAULT_SKEW_MS, now = Date.now()) {
  if (!Array.isArray(streams)) return streams;
  return streams.filter((s) => !isUrlExpired(streamUrl(s), skewMs, now));
}

// Cache lifetime for a set of rows: the base TTL, cut short so the entry
// leaves the cache before its first row's URL dies. <= 0 means do not cache.
function cappedTtlMs(baseTtlMs, streams, skewMs = DEFAULT_SKEW_MS, now = Date.now()) {
  const exp = earliestStreamExpiry(streams, now);
  if (exp == null) return baseTtlMs;
  return Math.min(baseTtlMs, exp - skewMs - now);
}

module.exports = {
  DEFAULT_SKEW_MS,
  urlExpiresAt,
  isUrlExpired,
  earliestStreamExpiry,
  anyStreamExpired,
  dropExpiredStreams,
  cappedTtlMs,
};
