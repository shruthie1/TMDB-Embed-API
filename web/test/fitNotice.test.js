import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');

/**
 * Changing the picture fit must not raise a toast.
 *
 * The reframe is its own feedback - the picture visibly changes shape - so a
 * card naming the new mode lands over the very frame the viewer is looking at
 * to judge it. The settings sheet already shows which mode is selected.
 */
describe('picture fit is silent', () => {
  it('neither fit path announces itself', () => {
    // Both cycleFit (the bar button) and applyFit (the settings sheet) used to
    // fire the same three-way string; the duplication is how one of them would
    // quietly come back.
    expect(src).not.toMatch(/Fit — whole frame/);
    expect(src).not.toMatch(/Fill — crops the edges/);
    expect(src).not.toMatch(/Stretch — ignores the aspect ratio/);
  });

  it('still persists the choice', () => {
    // Silencing the toast must not stop the mode being remembered.
    expect((src.match(/localStorage\.setItem\('chitram\.fit'/g) || []).length).toBe(2);
  });

  it('keeps the notices that are NOT self-evident', () => {
    // A quality cap, a subtitle failure and a blocked autoplay are invisible
    // on screen, so those must survive.
    expect(src).toMatch(/setNotice\(`Playing at \$\{h\}p/);
    expect(src).toMatch(/onError: setNotice/);
    expect(src).toMatch(/blocked autoplay/);
  });

  it('does not render a rotation/fullscreen notification chip', () => {
    expect(src).not.toMatch(/rotate\.needsTap/);
    expect(src).not.toMatch(/Tap for fullscreen/);
  });
});
