/**
 * What the player does when the browser's connection state changes.
 *
 * An outage is not a dead source. Failing over while offline marked every
 * source dead (each switched-in manifest fails offline too), and the viewer
 * ended on "no other server is left" with nothing retried when the
 * connection came back. Pure so it can be tested without mounting the player.
 */

/**
 * @returns 'retryAll' when the connection is back and the error on screen came
 *   from the outage, 'nudge' when it is back with no error, else null.
 */
export function offlineAction({ online, error, errorWhileOffline } = {}) {
  if (!online) return null;
  if (!error) return 'nudge';
  return errorWhileOffline ? 'retryAll' : null;
}

/** Never blame a source (mark it dead, advance) while the browser is offline. */
export function canFailOver(navigatorOnline) {
  return navigatorOnline !== false;
}

/**
 * Where a Retry from the error card resumes: the element's position, else the
 * last position that played, else 0 (the player then uses startAt). Retry used
 * to restart from startAt, so a film that died mid-way jumped back.
 */
export function retryResumeAt(currentTime, lastPlayedAt) {
  if (currentTime > 0) return currentTime;
  if (lastPlayedAt > 0) return lastPlayedAt;
  return 0;
}
