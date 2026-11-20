// Compares a stream's duration with the title's runtime.
//
// 'unknown' : the check cannot run yet (runtime not loaded, or no duration).
//             A play must NOT be confirmed as good in this state: a truncated
//             file confirmed before runtimeMin arrived ranked first forever.
// 'mismatch': shorter than 82% of the runtime (wrong title or truncated file).
// 'ok'      : long enough.
export const RUNTIME_MIN_RATIO = 0.82;

export function runtimeVerdict(runtimeMin, durationSec) {
  const expected = Number(runtimeMin);
  const actual = Number(durationSec) / 60;
  if (!expected || !Number.isFinite(actual) || actual <= 0) return 'unknown';
  return actual >= expected * RUNTIME_MIN_RATIO ? 'ok' : 'mismatch';
}
