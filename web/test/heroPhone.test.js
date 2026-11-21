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

  it('shows the wide backdrop band, not a 4:5 crop', () => {
    const art = rule(block, '.home-hero-art');
    expect(art).toContain('height:calc(var(--backdrop-reach,var(--header-h))+var(--detail-band))');
    // 390px wide, 48px header: the art box stays a wide landscape frame.
    const band = 390 * parseFloat(tok('detail-band')) / 100;
    expect(390 / (48 + band)).toBeGreaterThanOrEqual(1.25);
  });

  it('uses the shared hero scrim, not a phone-only one', () => {
    expect(rule(block, '.home-hero-art::after')).toBe('background:var(--hero-scrim)');
  });
});

describe('home hero: one treatment on phone, desktop and TV', () => {
  const all = globals.replace(/\s+/g, '');

  it('has one top fade and one bottom fade for every form factor', () => {
    expect(all).toContain('--hero-scrim:linear-gradient(tobottom,rgb(var(--rgb-bg)/.85)0%,rgb(var(--rgb-bg)/0)21%)');
    expect(all).toContain('linear-gradient(totop,var(--color-bg)0%,var(--color-overlay-5)12%,var(--color-overlay-3)30%,var(--color-overlay-1)55%,transparent78%)');
    expect(all).toContain('@media(min-width:640px){.home-hero-art::after{background:var(--hero-wash),var(--hero-scrim)}}');
    expect(all).toContain('body:has(.home-hero).topbar::before{opacity:0}');
  });

  it('crops the backdrop to the same focal point everywhere', () => {
    expect(all).toContain('.home-hero-art.page-backdrop{background-size:cover;background-position:center18%}');
    expect(all).not.toMatch(/\.home-hero-art\{background-position:center20%\}/);
  });

  it('insets the copy by the page gutter and the same bottom room', () => {
    expect(all).toContain('--hero-pad-bottom:calc(var(--hero-dots-bottom)+3px+var(--space-4))');
    expect(all).toContain('@media(max-width:559px){.home-hero{--hero-gutter:var(--space-4)}}');
    expect(all).toContain('html[data-tv="true"].home-hero{--hero-gutter:var(--tv-gap)');
    expect(all).toContain('html[data-tv="true"].home-hero-in{padding-bottom:var(--hero-pad-bottom)}');
  });
});
