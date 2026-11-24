/**
 * What to do with a FATAL hls.js error.
 *
 * Every dead-source case fails over to the next validated source first. That
 * source is already in memory, so switching costs no network round trip. Only
 * when nothing is left does the player show an error (or re-resolve, for a
 * stale signed url). Before this, an unreachable manifest, an undecodable
 * codec or any other fatal error went straight to the error screen while
 * working sources sat unused in the list.
 *
 * Pure so it can be tested without mounting the player.
 */
export function fatalAction(data) {
  const code = data?.response?.code;
  if (code === 403 || code === 410) return { kind: 'stale', failover: true };
  const d = data?.details;
  if (d === 'manifestIncompatibleCodecsError') {
    return { kind: 'codecs', failover: true, reason: 'incompatible codecs',
      message: 'This browser cannot decode this stream.' };
  }
  // Raised by useNoPictureGuard, not hls.js: audio plays, no frame decodes.
  if (d === 'noVideoFrames') {
    return { kind: 'novideo', failover: true, reason: 'no video frames',
      message: 'This device cannot show the picture for this stream.' };
  }
  if (d === 'badSegments') {
    return { kind: 'badsegments', failover: true, reason: data.reason || 'bad segments',
      message: 'This server sent no video.' };
  }
  if (d === 'manifestLoadError' || d === 'manifestLoadTimeOut' || d === 'manifestParsingError') {
    return { kind: 'unreachable', failover: true, reason: d };
  }
  if (data?.message) return { kind: 'error', failover: true, reason: data.message, message: data.message };
  return { kind: 'nudge', failover: false };
}

/**
 * Bad segment guard (APK 1.2.55, PlayPolicy.BadSegments). 2026-11-24 ShowsSt
 * movie/1359490: every fragment is a 70 B 1x1 PNG, HTTP 200, so hls.js never
 * raises a fatal error and loads them forever. Three fragments under 1 KB in a
 * row before the first frame fail the row. Subtitle fragments and unknown
 * sizes do not count; a real fragment ends the run. Fires once.
 */
export const BAD_SEGMENT_BYTES = 1024;
export const BAD_SEGMENT_COUNT = 3;

export function badSegmentCounter(count = BAD_SEGMENT_COUNT) {
  let run = 0;
  let largest = 0;
  let fired = false;
  return {
    onFragment(bytes, type) {
      if (fired || type === 'subtitle' || !Number.isFinite(bytes) || bytes < 0) return null;
      if (bytes >= BAD_SEGMENT_BYTES) { run = 0; largest = 0; return null; }
      run += 1;
      largest = Math.max(largest, bytes);
      if (run < count) return null;
      fired = true;
      return `${run}x${largest}B`;
    },
  };
}
