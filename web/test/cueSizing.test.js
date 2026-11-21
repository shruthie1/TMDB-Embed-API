import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SIZES } from '../lib/subtitles.js';

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
// Spacing comes from design tokens; resolve them so the maths below sees px.
const space = Object.fromEntries(
  [...read('../app/tokens.css').matchAll(/(--space-[\w-]+):(\d+px);/g)].map(m => [m[1], m[2]]));
const css = read('../app/globals.css').replace(/var\((--space-[\w-]+)\)/g, (m, k) => space[k] || m);

/** The declarations of one rule, by exact selector. */
function rule(selector) {
  const at = css.indexOf(selector + '{');
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(at + selector.length + 1, css.indexOf('}', at));
}

/** Evaluate the css min()/clamp() forms we actually use, against a picture. */
function px(expr, { picW, picH }) {
  // cqw resolves against the container's CONTENT box, not its border box, so
  // the layer's 6% side padding is excluded. Measured in Chromium: a 390px
  // layer gives a 343.2px content box, and 4.2cqw = 14.4px - not the 16.4px a
  // border-box reading predicts. Getting this wrong made these tests agree
  // with each other and disagree with the browser.
  const cqw = (n) => (n / 100) * (picW * 0.88);
  const pct = (n) => (n / 100) * picH;
  // The shipped form: the floor and ceiling wrap the SCALED value, so a small
  // preset cannot fall under the floor. `scale` defaults to 1 (Medium).
  let m = expr.match(
    /^clamp\(([\d.]+)px,\s*calc\(([\d.]+)cqw \* var\(--cue-scale\)\),\s*calc\(([\d.]+)px \* var\(--cue-scale\)\)\)$/);
  if (m) {
    const scale = arguments[1].scale ?? 1;
    return Math.max(+m[1], Math.min(cqw(+m[2]) * scale, +m[3] * scale));
  }
  m = expr.match(/^clamp\(([\d.]+)px,\s*([\d.]+)cqw,\s*([\d.]+)px\)$/);
  if (m) return Math.max(+m[1], Math.min(cqw(+m[2]), +m[3]));
  m = expr.match(/^min\(([\d.]+)px,\s*([\d.]+)%\)$/);
  if (m) return Math.min(+m[1], pct(+m[2]));
  throw new Error(`unhandled expr ${expr}`);
}

const fontExpr = () => rule('.cue-text > span').match(/font-size:(clamp\(.+?\)\));/)[1];
const padExpr  = () => rule('.cue-layer').match(/padding:0 6% (min\([^)]*\))/)[1];

// A 16:9 film letterboxed into a window of this width: the picture is as wide
// as the window, and 9/16 as tall.
const picture = (w) => ({ picW: w, picH: (w * 9) / 16 });

describe('caption sizing follows the picture', () => {
  it('resolves cqw against the picture, not the viewport', () => {
    // Without container-type the cqw unit silently falls back to the viewport,
    // which is the whole bug wearing a different unit.
    expect(rule('.cue-layer')).toMatch(/container-type:\s*inline-size/);
  });

  it('holds a near-constant line length as the window narrows', () => {
    // The reported bug: text kept its size while the picture shrank, so a cue
    // that fit on one line at full width wrapped and swelled to fill a small
    // frame. Characters per line is what the viewer actually perceives.
    const chars = (w) => {
      const p = picture(w);
      return p.picW / (px(fontExpr(), p) * 0.5); // ~0.5em average advance
    };
    const wide = chars(1512), narrow = chars(380);
    expect(narrow).toBeGreaterThan(wide * 0.35);

    // And it never collapses the way the viewport formula did: clamp(19px,
    // 2.4vw+0.7vh, 26px) bottomed out at its 19px floor while the picture kept
    // shrinking, giving ~40 chars at 380px against ~53 at 500px.
    expect(chars(380)).toBeGreaterThan(44);
  });

  it('never renders larger on a smaller picture', () => {
    const sizes = [1512, 1000, 700, 500, 380, 300]
      .map(w => px(fontExpr(), picture(w)));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
  });

  it('keeps the sizes signed off at desktop widths', () => {
    // 26px until 2026-11-20, raised to 32px on the viewer's report that the
    // default was too small on a laptop and a TV.
    expect(px(fontExpr(), picture(1512))).toBe(32);
    expect(px(fontExpr(), picture(1000))).toBe(32);
  });

  it('stays legible at the smallest picture', () => {
    // 11px is the floor. It exists so text never vanishes, but it must sit
    // BELOW what a small picture asks for - a 15px floor pinned a 390px phone
    // portrait at 88% of frame width, edge to edge, which was the reported bug.
    expect(px(fontExpr(), picture(300))).toBeGreaterThanOrEqual(11);
    expect(px(fontExpr(), picture(390))).toBeGreaterThan(11);
  });

  it('caps the text block so a long cue never reaches the frame edge', () => {
    // `text-wrap: balance` prefers fewer, wider lines, so side padding alone
    // did not bound it. Measured in Chromium at 390x844 before this cap: a
    // long cue ran 343px inside a 390px picture.
    const cap = rule('.cue-text').match(/max-width:\s*(\d+)%/);
    expect(cap).not.toBeNull();
    expect(Number(cap[1])).toBeLessThanOrEqual(90);
  });
});

describe('the size presets', () => {
  // Values measured in Chromium against the shipped css, not derived on paper:
  // an earlier version of this file computed cqw from the BORDER box and so
  // agreed with itself while disagreeing with every browser.
  const at = (w, scale) => px(fontExpr(), { ...picture(w), scale });

  it('makes Small genuinely small on a phone', () => {
    // The report: "small looks like medium". It was 0.8, putting Small 3.3px
    // under Medium - a step you cannot see.
    const small = at(390, SIZES[0].key), medium = at(390, SIZES[1].key);
    expect(medium - small).toBeGreaterThan(3);
    expect(small).toBeLessThan(medium * 0.85);
  });

  it('never drops Small below what is readable', () => {
    // The floor wraps the SCALED value. Before that it wrapped only the base,
    // and Small reached 8.9px on a 390px picture.
    for (const w of [390, 360, 320, 280]) {
      expect(at(w, SIZES[0].key)).toBeGreaterThanOrEqual(10);
    }
  });

  it('keeps every preset distinguishable from its neighbour', () => {
    const sizes = SIZES.map(s => at(390, s.key));
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1] + 3);
    }
  });

  it('leaves the desktop default where it was signed off', () => {
    expect(at(1512, 1)).toBe(32);
  });

  it('still lets Extra large grow past the base ceiling', () => {
    // The ceiling is scaled too, so the largest preset is not pinned at 26px.
    const xl = SIZES[SIZES.length - 1].key;
    expect(at(1512, xl)).toBeGreaterThan(32);
  });
});

describe('caption padding against a short picture', () => {
  it('never spends more than a tenth of the frame on bottom padding', () => {
    // A flat 28px is a sixth of a 170px-tall picture.
    for (const w of [1512, 700, 380, 300]) {
      const p = picture(w);
      expect(px(padExpr(), p) / p.picH).toBeLessThan(0.1);
    }
  });

  it('is a plain 16px on a normal-sized picture', () => {
    // Was 28px, which sat captions higher than a TV or cinema places them.
    // The cap only binds on a short picture; at normal sizes this is flat.
    expect(px(padExpr(), picture(1512))).toBe(16);
  });

  it('takes the controls lift from JS, not a fixed css length', () => {
    // The lift used to be `min(96px, 26%)`. Both halves were wrong: the bar is
    // a strip at the foot of the WINDOW while the picture is a letterboxed box
    // floating inside it, so a length in picture-units cannot say whether they
    // even touch. Measured on the live DOM: picture bottom y499, bar top
    // y1054 - 555px apart - and the caption still rose 36px. Player.jsx now
    // measures the real overlap into --cue-lift. See cueLift.test.js.
    const decl = css.match(/\.player:has\(\.pctl\.show\) \.cue-layer\{([^}]*)\}/)[1];
    expect(decl).toMatch(/var\(--cue-lift/);
    // It must still carry the normal resting padding, or the caption would sit
    // flush against the picture edge whenever the lift is 0.
    expect(decl).toMatch(/min\(16px/);
    // And no bare pixel lift may survive alongside it.
    expect(decl).not.toMatch(/96px/);
  });
});
