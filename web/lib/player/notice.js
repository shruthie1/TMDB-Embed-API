/**
 * The transient message over the picture (Player.jsx `notice`).
 *
 * NOTICE_MS: long enough to read a short sentence, short enough not to sit on
 * the film. A notice may ask to be held longer: the add-audio "Checking …"
 * line stays up for the whole donor check (ADD_AUDIO_TRY_MS), as on the APK.
 */
export const NOTICE_MS = 4000;

/** { text, id, ms } for setNotice, or null to clear. */
export function makeNotice(text, id, opts) {
  if (!text) return null;
  const hold = opts && typeof opts === 'object' ? Number(opts.holdMs) : 0;
  return { text, id, ms: hold > 0 ? hold : NOTICE_MS };
}
