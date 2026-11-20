// TV remote keys that are not arrows: Back, media keys, and closing the app.
//
// Pure helpers, so the rules are testable without a DOM. lib/dpad.js wires the
// Back rule into the page and Player.jsx uses the media-key map.
//
// Hisense VIDAA runs a Chromium build called Odin. Its remote sends Back as
// Backspace (keyCode 8), and the media keys as bare keyCodes: Play 415,
// Pause 19, Stop 413, FastForward 417, Rewind 412. A keyboard or a newer
// browser sends the standard `key` names instead, so both are accepted.

/** Is this user agent a Hisense VIDAA TV? */
export function isVidaa(ua) {
  return /\b(vidaa|hisense)\b|\bodin\//i.test(ua || '');
}

/** Is focus in a field that owns Backspace and the arrows? */
export function isTyping(el) {
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.isContentEditable);
}

const MEDIA_BY_KEY = {
  MediaPlayPause: 'toggle',
  MediaPlay: 'play',
  MediaPause: 'pause',
  Pause: 'pause',
  MediaStop: 'stop',
  MediaFastForward: 'forward',
  MediaRewind: 'rewind',
};
const MEDIA_BY_CODE = { 179: 'toggle', 415: 'play', 19: 'pause', 413: 'stop', 417: 'forward', 412: 'rewind' };

/**
 * The playback action a media key asks for, or null when it is not one.
 *
 * The keyCode is checked as well as `key`, because an older TV browser
 * reports `key` as "Unidentified" for its vendor codes.
 */
export function mediaKeyAction(e) {
  if (!e) return null;
  return MEDIA_BY_KEY[e.key] || MEDIA_BY_CODE[e.keyCode] || null;
}

/** Seconds a FastForward or Rewind press moves playback. */
export const MEDIA_SEEK_SECS = 10;

/**
 * What a TV Back press (Backspace) should do outside the player.
 *
 * - 'escape': an overlay is open, so close it the way Escape does.
 * - 'back':   go back one page.
 * - 'exit':   on the home page of a VIDAA TV, close the app.
 * - null:     not ours; leave the key alone.
 *
 * Exit is VIDAA only. Another TV's browser would close the tab, which is not
 * what Back means there.
 */
export function backAction({ key, keyCode, tv, typing, playerOpen, dialogOpen, pathname, vidaa }) {
  if (!tv) return null;
  if (key !== 'Backspace' && keyCode !== 8) return null;
  // A text field needs Backspace to delete; the player handles its own Back.
  if (typing || playerOpen) return null;
  if (dialogOpen) return 'escape';
  if (pathname === '/') return vidaa ? 'exit' : null;
  return 'back';
}

/** Close the app: the VIDAA call when it exists, else close the window. */
export function exitApp(w = typeof window === 'undefined' ? null : window) {
  if (!w) return;
  if (typeof w.Hisense_Exit === 'function') { w.Hisense_Exit(); return; }
  w.close();
}

/**
 * What a remote key does in the player when the D-pad is in charge (TV mode,
 * our own control bar).
 *
 * The model is the one every TV app uses:
 * - Focus in the visible bar: the key belongs to the bar. Arrows move between
 *   controls (lib/dpad.js) and OK presses the focused one. Returns null.
 * - Otherwise (bar hidden, or nothing in it focused): Left/Right seek 10s,
 *   OK toggles play/pause, Up/Down bring the bar up with focus on Play.
 *
 * `focusInBar` only counts while the bar is showing. Focus left on a control
 * that has faded out is not a place the viewer can see, so treating it as
 * "in the bar" made Left/Right walk invisible buttons instead of seeking.
 *
 * @returns {'rewind'|'forward'|'toggle'|'enter-bar'|null}
 */
export function tvPlayerKey({ key, controlsVisible, focusInBar }) {
  if (focusInBar && controlsVisible) return null;
  switch (key) {
    case 'ArrowLeft': return 'rewind';
    case 'ArrowRight': return 'forward';
    case 'ArrowUp': case 'ArrowDown': return 'enter-bar';
    case 'Enter': case ' ': case 'Spacebar': return 'toggle';
    default: return null;
  }
}
