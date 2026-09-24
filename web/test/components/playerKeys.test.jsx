import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The player's key handler runs in CAPTURE phase on window, so it sees keys
 * before any focused control does. That is deliberate (arrows must seek, not
 * move focus) but it made Space steal activation from every focused button -
 * on a TV, where OK sends Enter or Space, the settings and picture-fit buttons
 * did nothing at all.
 *
 * The logic is asserted directly rather than through a full Player render,
 * which would need hls.js and a live stream.
 */
function shouldDeferToControl(activeEl, key) {
  const onControl = activeEl && activeEl !== document.body
    && activeEl.matches?.('button, a, [role="button"], [role="menuitemradio"], input');
  return Boolean(onControl && (key === 'Enter' || key === ' ' || key === 'Spacebar'));
}

let button, body;
beforeEach(() => {
  document.body.innerHTML = '<button aria-label="Settings">S</button>';
  button = document.querySelector('button');
  body = document.body;
});

describe('player keys vs a focused control', () => {
  it('lets a focused button keep Enter and Space, which is how OK presses it', () => {
    for (const key of ['Enter', ' ', 'Spacebar']) {
      expect(shouldDeferToControl(button, key), key).toBe(true);
    }
  });

  it('still owns play/pause when nothing is focused', () => {
    // Space over the picture must toggle playback - that is the shortcut the
    // help overlay advertises.
    for (const key of ['Enter', ' ']) {
      expect(shouldDeferToControl(body, key), key).toBe(false);
    }
  });

  it('keeps the media keys regardless of focus', () => {
    // Seek and volume are the player's, focused button or not - otherwise a
    // remote could never seek while the controls are up.
    for (const key of ['ArrowRight', 'k', 'f', 'm', 'MediaPlayPause']) {
      expect(shouldDeferToControl(button, key), key).toBe(false);
    }
  });

  it('defers on a menu row, so a caption can be chosen with OK', () => {
    document.body.innerHTML = '<div role="menuitemradio">English</div>';
    expect(shouldDeferToControl(document.querySelector('[role]'), 'Enter')).toBe(true);
  });
});

/**
 * Whether an arrow is NAVIGATION (move the D-pad between buttons) rather than
 * a seek. Mirrors the `navigating` expression in Player.jsx.
 */
function isNavigating(activeEl, { onTvDevice, controlsVisible }) {
  const onControl = activeEl && activeEl !== document.body
    && activeEl.matches?.('button, a, [role="button"], [role="menuitemradio"], input');
  return Boolean(onTvDevice && (controlsVisible || onControl));
}

/**
 * Whether a focused control keeps Enter/Space, mirroring the guards in
 * Player.jsx. Space defers on a TV only; Enter defers everywhere.
 */
function defersActivation(activeEl, key, onTvDevice) {
  const onControl = activeEl && activeEl !== document.body
    && activeEl.matches?.('button, a, [role="button"], [role="menuitemradio"], input');
  if (onControl && key === 'Enter') return true;
  return Boolean(onControl && onTvDevice && (key === ' ' || key === 'Spacebar'));
}

describe('space toggles playback on a laptop', () => {
  it('keeps play/pause after the viewer has clicked a control', () => {
    // The bug: focus stays on whatever button was clicked, so Space was handed
    // to it for the rest of the film and play/pause looked dead until the
    // viewer clicked the picture to move focus away.
    for (const key of [' ', 'Spacebar']) {
      expect(defersActivation(button, key, false), key).toBe(false);
    }
  });

  it('still lets a remote press the focused button with OK', () => {
    // On a TV, focus is the only way to point at anything.
    for (const key of [' ', 'Spacebar']) {
      expect(defersActivation(button, key, true), key).toBe(true);
    }
  });

  it('always defers Enter, which unambiguously means "activate this"', () => {
    expect(defersActivation(button, 'Enter', false)).toBe(true);
    expect(defersActivation(button, 'Enter', true)).toBe(true);
  });

  it('owns space over the picture on any device', () => {
    for (const tv of [true, false]) {
      expect(defersActivation(body, ' ', tv), String(tv)).toBe(false);
    }
  });
});

describe('arrow keys seek on a laptop', () => {
  it('seeks even while the controls are showing', () => {
    // The bug: `navigating` was just `controls.visible`. On a laptop ANY mouse
    // move or key press reveals the controls, so left/right were swallowed
    // almost all of the time and the seek keys looked dead.
    expect(isNavigating(document.body,
      { onTvDevice: false, controlsVisible: true })).toBe(false);
  });

  it('seeks with the controls hidden too', () => {
    expect(isNavigating(document.body,
      { onTvDevice: false, controlsVisible: false })).toBe(false);
  });

  it('does not scrub while a button has focus, so Tab still works', () => {
    // A keyboard user tabbing across the control row must be able to move
    // along it; the arrows belong to the focused control there.
    expect(isNavigating(button,
      { onTvDevice: false, controlsVisible: true })).toBe(false);
  });

  it('still lets a TV remote navigate its button row', () => {
    // The behaviour the original guard existed to protect.
    expect(isNavigating(button,
      { onTvDevice: true, controlsVisible: true })).toBe(true);
    expect(isNavigating(document.body,
      { onTvDevice: true, controlsVisible: true })).toBe(true);
  });

  it('lets a TV seek when the controls are down and nothing is focused', () => {
    expect(isNavigating(document.body,
      { onTvDevice: true, controlsVisible: false })).toBe(false);
  });
});
