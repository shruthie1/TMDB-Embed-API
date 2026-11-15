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
  if (d === 'manifestLoadError' || d === 'manifestLoadTimeOut' || d === 'manifestParsingError') {
    return { kind: 'unreachable', failover: true, reason: d };
  }
  if (data?.message) return { kind: 'error', failover: true, reason: data.message, message: data.message };
  return { kind: 'nudge', failover: false };
}
