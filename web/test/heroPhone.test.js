import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Phone home hero: the text stack must leave the art visible. jsdom cannot lay
 * out CSS, so this parses the real stylesheets: the rules that pin and shrink
 * the stack must exist under 640px, and the stack's height, summed from the
 * same tokens, must stay within 35% of the hero at 390x844.
 * (Measured in headless Chrome at 390x844 as well; see the commit message.)
 */
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const tokens = read('../app/tokens.css');
const globals = read('../app/globals.css');

const rootBlock = tokens.slice(tokens.indexOf(':root{'), tokens.indexOf('\n}', tokens.indexOf(':root{')));
const tok = (name) => {
  const m = rootBlock.match(new RegExp(`--${name}:([^;]+);`));
  if (!m) throw new Error(`token --${name} missing`);
  return m[1].trim();
};
const px = (v) => {
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  if (ref) return px(tok(ref[1]));
  const n = v.match(/^([\d.]+)px$/);
  if (!n) throw new Error(`not px: ${v}`);
  return +n[1];
};

function phoneBlock() {
  const at = globals.indexOf('@media (max-width:639px){');
  expect(at).toBeGreaterThan(-1);
  let depth = 0, i = globals.indexOf('{', at);
  for (let j = i; j < globals.length; j++) {
    if (globals[j] === '{') depth++;
    if (globals[j] === '}' && --depth === 0) return globals.slice(i + 1, j);
  }
  throw new Error('unclosed block');
}
const rule = (block, sel) => {
  const m = block.match(new RegExp(`(?:^|[};\\s])${sel.replace(/[.()]/g, '\\$&')}\\{([^}]*)\\}`));
  return m ? m[1].replace(/\s+/g, '') : null;
};

describe('phone home hero (< 640px)', () => {
  const block = phoneBlock();

  it('hides the synopsis and pins a one-line title to the bottom', () => {
    expect(rule(block, '.home-hero-overview')).toContain('display:none');
    const inner = rule(block, '.home-hero-in');
    expect(inner).toContain('position:absolute');
    expect(inner).toContain('bottom:0');
    expect(rule(block, '.home-hero-title')).toContain('white-space:nowrap');
    expect(rule(block, '.home-hero-title')).toContain('text-overflow:ellipsis');
  });

  it('keeps the text stack within 35% of the hero at 390x844', () => {
    const [vw, vh] = [390, 844];
    const m = tok('hero-height-phone').match(/min\(([\d.]+)svh,\s*([\d.]+)vw\)/);
    const hero = Math.min(vh * m[1] / 100, vw * m[2] / 100);
    const stack =
      2 * px(tok('space-4')) +                                    // block padding
      px(tok('hero-title-phone')) * +tok('hero-title-phone-lh') + // one title line
      px(tok('space-1')) + px(tok('hero-meta-phone')) * 1.5 +     // meta
      px(tok('space-3')) + px(tok('btn-h-phone')) +               // buttons
      px(tok('space-2')) + 3;                                     // indicator
    expect(stack / hero).toBeLessThanOrEqual(0.35);
  });

  it('fades the art into the page colour from halfway down', () => {
    expect(tok('hero-scrim-phone')).toMatch(/transparent 50%.*var\(--color-bg\) 100%/);
  });
});
