/**
 * Cast to a TV through Web Video Caster (WVC). docs/PENDING-WORK.md C3.
 *
 * The phone asks the API for a cast master (POST /cast): one Telugu audio
 * rendition, a video-only variant, alive for the runtime + 1h. WVC on the
 * phone then sends that one url to the TV. Link formats from
 * https://www.webvideocaster.com/integrations.
 *
 * Phone only: a TV is the receiver, and a desktop has no WVC app to hand to.
 */

export const WVC_PACKAGE = 'com.instantbits.cast.webvideo';
export const PLAY_STORE = `https://play.google.com/store/apps/details?id=${WVC_PACKAGE}`;
export const HLS_MIME = 'application/x-mpegURL';

const BASE = process.env.NEXT_PUBLIC_API_BASE || '';

/** wvc-x-callback://open?url=…&title=…&poster=…&mime_type=… */
export function wvcSchemeLink(mediaUrl, { title, poster, mime = HLS_MIME } = {}) {
  const q = new URLSearchParams();
  q.append('url', mediaUrl);
  if (title) q.append('title', title);
  if (poster) q.append('poster', poster);
  if (mime) q.append('mime_type', mime);
  // URLSearchParams writes spaces as '+'; WVC's own examples use %20.
  return `wvc-x-callback://open?${q.toString().replace(/\+/g, '%20')}`;
}

/**
 * Chrome Android intent: opens WVC directly, or the Play Store when WVC is not
 * installed. Only String extras fit an intent url, which is fine: the cast
 * master needs no request headers.
 */
export function wvcIntentLink(mediaUrl, { title, poster, mime = HLS_MIME } = {}) {
  const u = new URL(mediaUrl);
  const extras = [];
  if (title) extras.push(`S.title=${encodeURIComponent(title)}`);
  if (poster) extras.push(`S.poster=${encodeURIComponent(poster)}`);
  extras.push(`S.browser_fallback_url=${encodeURIComponent(PLAY_STORE)}`);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;`
    + `scheme=${u.protocol.replace(':', '')};action=android.intent.action.VIEW;`
    + `type=${mime};package=${WVC_PACKAGE};${extras.join(';')};end`;
}

/** Chrome on Android (not Firefox, Edge, Opera, Samsung or a WebView). */
export function isAndroidChrome(ua = '') {
  return /Android/i.test(ua) && /Chrome\/\d+/.test(ua)
    && !/(EdgA|OPR|SamsungBrowser|Firefox|; wv\))/.test(ua);
}

export function castLink(mediaUrl, meta = {}, ua = '') {
  return isAndroidChrome(ua) ? wvcIntentLink(mediaUrl, meta) : wvcSchemeLink(mediaUrl, meta);
}

/**
 * Phone only. Android phones say "Mobile" (tablets and Android TV boxes do
 * not); iPhones say iPhone. `tv` is the app's own TV detection (lib/dpad isTv),
 * which also catches TV boxes that send a phone UA.
 */
export function canCast({ ua = '', tv = false } = {}) {
  if (tv) return false;
  return (/Android/i.test(ua) && /Mobile/.test(ua)) || /iPhone|iPod/.test(ua);
}

const side = (s) => ({
  url: s.masterUrl, provider: s.provider, quality: s.quality,
  ...(s.codecString ? { codecs: s.codecString } : {}),
});

/**
 * What to POST to /cast for what is on screen. A paired stream casts the PAIR:
 * its /hybrid master lives 20 minutes, a film does not.
 */
export function castBody({ stream, pair, tmdbId, mediaType, title, nudge }) {
  const meta = {
    ...(tmdbId ? { tmdbId, type: mediaType === 'tv' || mediaType === 'series' ? 'series' : 'movie' } : {}),
    ...(title ? { title } : {}),
  };
  if (stream?.hybrid && pair?.video && pair?.audio) {
    return { pair: { video: side(pair.video), audio: side(pair.audio) }, ...meta,
      ...(Number(nudge) ? { nudge: Number(nudge) } : {}) };
  }
  return { url: stream?.masterUrl, ...meta };
}

/** POST /cast, then the WVC link for the served master. Throws with the server's reason. */
export async function prepareCast({ body, meta, ua, fetchImpl = fetch }) {
  const r = await fetchImpl(`${BASE}/cast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let d = null;
  try { d = await r.json(); } catch { /* non-JSON error page */ }
  if (!r.ok || !d?.url) throw new Error(d?.reason || d?.error || `cast failed (HTTP ${r.status})`);
  return { ...d, href: castLink(d.url, meta, ua) };
}
