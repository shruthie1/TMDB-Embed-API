/**
 * Can this browser decode a source's VIDEO codec?
 *
 * Prod 2026-11-19, The Paradise (movie/1376856): the player auto-picked a
 * mapple row whose fMP4 segments are HEVC (hev1). Chrome on a Pixel 7 reports
 * MediaSource.isTypeSupported false for hvc1 and hev1, so the audio played
 * over a black screen: currentTime advanced, videoWidth stayed 0, and no error
 * fired. The backend now states `videoCodec` on the row, so the player can
 * rank such a row last and mark it in the server menu.
 *
 * Returns true (decodes), false (cannot) or null (unknown: no codec stated,
 * or no way to ask). Only `false` changes anything: an unknown row keeps its
 * normal place, and the black-picture guard covers it at playback time.
 */

// A representative string per family, for when the row gives only the family.
// Main profile at a common level: the question is "any HEVC at all?".
const PROBE = {
  hevc: ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0'],
  av1: ['av01.0.08M.08'],
  vp9: ['vp09.00.10.08'],
};

/** The video entries of an RFC 6381 CODECS string ("hvc1....,mp4a.40.2"). */
function videoEntries(codecString) {
  return String(codecString || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^(hvc1|hev1|avc1|avc3|av01|vp09)\b/i.test(c));
}

function defaultEnv() {
  if (typeof window === 'undefined') return {};
  const sources = [window.ManagedMediaSource, window.MediaSource]
    .filter((m) => m && typeof m.isTypeSupported === 'function');
  // useHls plays through hls.js, which feeds MediaSource, whenever MediaSource
  // exists. So MediaSource is the only honest judge there: <video>.canPlayType
  // can say "probably" for HEVC on a phone whose MediaSource refuses it.
  if (sources.length) {
    return { isTypeSupported: (t) => sources.some((m) => m.isTypeSupported(t)), canPlayType: null };
  }
  // No MediaSource (older iOS): the <video> element plays HLS natively and
  // answers for itself.
  let video = null;
  try { video = typeof document !== 'undefined' ? document.createElement('video') : null; } catch { video = null; }
  return {
    isTypeSupported: null,
    canPlayType: video && typeof video.canPlayType === 'function'
      ? (t) => video.canPlayType(t) : null,
  };
}

const memo = new Map();

/**
 * @param {{videoCodec?: string|null, codecString?: string|null}} s
 * @param {{isTypeSupported?: Function|null, canPlayType?: Function|null}} [env]
 */
export function videoCodecSupported(s, env) {
  const family = String(s?.videoCodec || '').toLowerCase();
  // H.264 plays in every browser this site supports; unknown says nothing.
  if (!family || family === 'avc') return family ? true : null;
  const stated = videoEntries(s?.codecString);
  const candidates = stated.length ? stated : (PROBE[family] || []);
  if (!candidates.length) return null;
  const e = env || defaultEnv();
  if (!e.isTypeSupported && !e.canPlayType) return null;
  const useMemo = !env;
  const key = `${family}|${candidates.join('|')}`;
  if (useMemo && memo.has(key)) return memo.get(key);
  let ok = false;
  for (const c of candidates) {
    const type = `video/mp4; codecs="${c}"`;
    try {
      ok = e.isTypeSupported ? Boolean(e.isTypeSupported(type)) : Boolean(e.canPlayType(type));
    } catch { ok = false; }
    if (ok) break;
  }
  if (useMemo) memo.set(key, ok);
  return ok;
}

/** True only when the browser is known NOT to decode this row's video. */
export function isUnsupported(s, env) {
  return videoCodecSupported(s, env) === false;
}
