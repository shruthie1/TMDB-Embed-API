import { describe, it, expect } from 'vitest';

/**
 * How far captions rise when the control bar appears.
 *
 * This cannot be a CSS length: the bar is a strip at the foot of the WINDOW
 * while the picture is a letterboxed box floating inside it, so whether they
 * overlap at all is a relationship between two boxes CSS cannot read. A flat
 * 96px - and the 26% that replaced it - lifted the caption even when the bar
 * was nowhere near the picture.
 */

/** The rule in Player.jsx, isolated so it can be checked directly. */
function lift({ layer, bar, visible = true }) {
  if (!visible) return 0;
  const overlap = Math.max(0, layer.bottom - bar.top);
  return Math.min(overlap, layer.height * 0.4);
}

describe('caption lift over the control bar', () => {
  it('does not lift at all when the bar is nowhere near the picture', () => {
    // The reported bug, with the numbers read off the live DOM: a CinemaScope
    // picture ending at y499 in a 1142-tall window, bar top at y1054. They are
    // 555px apart, yet the caption used to rise 36px inside a 138px picture -
    // 26% of the way up the frame.
    expect(lift({ layer: { bottom: 499.5, height: 137.9 }, bar: { top: 1054 } })).toBe(0);
  });

  it('lifts by exactly the overlap when the bar covers the lower picture', () => {
    // Laptop windowed: picture bottom y876, bar top y812 -> 64px covered.
    expect(lift({ layer: { bottom: 876, height: 850 }, bar: { top: 812 } })).toBe(64);
  });

  it('never lifts past the picture on a very short frame', () => {
    // A full-height bar over a tiny picture would push the caption out of the
    // frame entirely. Capped at 40% of the picture.
    const got = lift({ layer: { bottom: 300, height: 100 }, bar: { top: 100 } });
    expect(got).toBe(40);
  });

  it('is zero while the controls are hidden', () => {
    expect(lift({ layer: { bottom: 900, height: 400 }, bar: { top: 800 }, visible: false })).toBe(0);
  });

  it('handles a bar that exactly meets the picture edge', () => {
    expect(lift({ layer: { bottom: 700, height: 300 }, bar: { top: 700 } })).toBe(0);
  });

  it('grows as the window shrinks and the bar creeps over the picture', () => {
    // Monotonic: a bar covering more picture never lifts less.
    const a = lift({ layer: { bottom: 800, height: 400 }, bar: { top: 790 } });
    const b = lift({ layer: { bottom: 800, height: 400 }, bar: { top: 760 } });
    expect(b).toBeGreaterThan(a);
  });
});

describe('the css rule this replaced', () => {
  it('would have lifted a caption that needed no lift', () => {
    // Guards the regression: min(96px, 26%) on a 137.9px picture.
    const old = Math.min(96, 0.26 * 137.9);
    expect(old).toBeGreaterThan(30);
    expect(lift({ layer: { bottom: 499.5, height: 137.9 }, bar: { top: 1054 } })).toBe(0);
  });
});
