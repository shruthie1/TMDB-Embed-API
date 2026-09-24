/**
 * Abort with a REASON, always.
 *
 * `controller.abort()` with no argument makes the browser synthesise
 * `AbortError: signal is aborted without reason`. Next's dev overlay reports
 * that at the throw site as an Unhandled Runtime Error even when the promise
 * chain catches it correctly - which every one of ours does. The result was
 * three separate red overlays (lib/api.js, lib/backend.js,
 * lib/player/useSubtitles.js) for cancels the app performs ON PURPOSE:
 * a request timing out, an effect cleaning up, a source switch superseding an
 * in-flight resolve.
 *
 * Passing a reason fixes the message and, more usefully, makes the three cases
 * tellable apart in a log. Deliberately a DOMException named 'AbortError' and
 * not a plain Error, because callers already branch on
 * `err.name === 'AbortError'` (lib/api.js:70) and `signal.aborted`; changing
 * the type would silently turn a handled cancel into a reported failure.
 */

/** @param {string} why - short, specific: 'timeout after 15000ms', 'unmounted'. */
export function abortReason(why) {
  return new DOMException(String(why || 'cancelled'), 'AbortError');
}

/** True for any abort, however it was signalled. */
export function isAbort(err) {
  return err?.name === 'AbortError';
}
