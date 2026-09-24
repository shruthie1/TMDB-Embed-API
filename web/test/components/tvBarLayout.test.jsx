import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

const { default: TvBar } = await import('../../components/player/TvBar');

const CSS = fs.readFileSync(
  path.join(process.cwd(), 'app/globals.css'), 'utf8');

const SOURCES = [
  { provider: 'vidsrc', best: '1080p' },
  { provider: 'embedsu', best: '720p' },
];
const LEVELS = [
  { index: 0, label: '1080p' },
  { index: 1, label: '720p' },
];
const SUBS = [
  { id: 'eng:0', name: 'English WEB-DL' },
  { id: 'eng:1', name: 'English SDH' },
];

const mount = (props = {}) => render(
  <TvBar sources={SOURCES} currentSource="vidsrc"
         levels={LEVELS} currentLevel={-1} autoLevel="1080p"
         subs={SUBS} currentSub={null}
         fit="contain" {...props} />,
);

/**
 * The bar is a two-column CSS grid whose rows are [label][buttons]. That shape
 * is what puts every row's first button on ONE left edge - measured before the
 * change at 1080p, the unlabelled Close row started at x=974 while the Picture
 * row above it started at x=1047, a 73px stagger, and the Captions row sat
 * 2.2px right of Source and Quality because "Captions" is wider than the
 * label column's old 62px min-width.
 *
 * jsdom does no layout, so these assert the STRUCTURE the layout depends on
 * rather than the pixels: if a row's buttons stop being wrapped in a
 * .tvbar-btns box, the grid silently degrades back to a ragged flex line.
 */
describe('TvBar grid structure', () => {
  it('wraps every row\'s buttons in a .tvbar-btns box', () => {
    const { container } = mount();
    const rows = [...container.querySelectorAll('.tvbar-row')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const box = row.querySelector(':scope > .tvbar-btns');
      expect(box, `row "${row.textContent.trim()}" has no .tvbar-btns`).toBeTruthy();
      // No button may sit as a direct child of the row: it would land in the
      // label column and break the shared left edge.
      expect(row.querySelectorAll(':scope > .tvbar-btn').length).toBe(0);
    }
  });

  it('gives the unlabelled Close row the same buttons box as every other', () => {
    const { container } = mount();
    const rows = [...container.querySelectorAll('.tvbar-row')];
    const closeRow = rows.find(r => r.textContent.trim() === 'Close');
    expect(closeRow).toBeTruthy();
    // No label, so its .tvbar-btns is the FIRST child - which is exactly the
    // case the `.tvbar-row > .tvbar-btns:first-child{grid-column:2}` rule
    // exists to push back into the buttons column.
    expect(closeRow.querySelector('.tvbar-k')).toBeNull();
    expect(closeRow.firstElementChild.className).toContain('tvbar-btns');
  });

  it('keeps every button reachable by the D-pad', () => {
    const { container } = mount();
    const btns = [...container.querySelectorAll('.tvbar-btn')];
    expect(btns.length).toBeGreaterThan(5);
    // lib/dpad.js walks [data-focus] only; a button without it is invisible to
    // a remote no matter how it is styled.
    for (const b of btns) expect(b.hasAttribute('data-focus')).toBe(true);
  });
});

/**
 * The sizing and alignment live in CSS, so they are asserted against the
 * stylesheet text. Crude, but it is the only place these values exist and each
 * one below was a measured defect.
 */
describe('TvBar CSS contract', () => {
  /**
   * Every block for `sel`. There is more than one `[data-tv="true"]{...}` in
   * the sheet - the 10-foot type scale opens with `--gap:24px` long before the
   * player section - so taking the first match asserted against the wrong
   * rule. Returning them all and matching across the set is the honest
   * question: "does ANY block for this selector declare it".
   */
  const rules = (sel) => {
    const out = [];
    for (let i = CSS.indexOf(sel + '{'); i >= 0; i = CSS.indexOf(sel + '{', i + 1)) {
      out.push(CSS.slice(i + sel.length + 1, CSS.indexOf('}', i)));
    }
    return out;
  };
  const rule = (sel) => rules(sel).join('\n');

  it('sizes the button from an explicit line-height, not the inherited 1.6', () => {
    const body = rule('.tvbar-btn');
    expect(body).toBeTruthy();
    // 14px text on the inherited 1.6 gave a 22.4px line box and a 40.4px
    // button - the line-height, not the padding, was what made it too big.
    expect(body).toMatch(/line-height:1\.15/);
    expect(body).toMatch(/font-size:13px/);
  });

  it('never scales a focused button, which would eat the gap to its neighbour', () => {
    // At 1.09 a focused button grew 12px wider and the 7px gap to the next one
    // fell to 1.0px (measured, "Off" -> "English WEB-DL"). A ring costs no
    // layout, so nothing moves and nothing can be pushed off a panel edge.
    expect(CSS).toMatch(/\.tvbar \.focusable:focus[\s\S]{0,80}transform:none/);
    const focus = rule('.tvbar-btn:focus,.tvbar-btn:focus-visible');
    expect(focus).toBeTruthy();
    expect(focus).toMatch(/box-shadow:[^;]*var\(--paper\)/);
    expect(focus).not.toMatch(/scale\(/);
  });

  it('insets the bar from the panel edges for overscan', () => {
    // It used to sit at x=0 / right=0 / bottom=0, so an overscanning TV cut
    // the bottom row off outright.
    const tvRoot = rule('[data-tv="true"]');
    expect(tvRoot).toMatch(/--tvbar-safe-x:\s*[\d.]+%/);
    // vh, not %: percentage padding resolves against WIDTH even for top and
    // bottom, which measured 67.2px of bottom padding on a 1920-wide panel.
    expect(tvRoot).toMatch(/--tvbar-safe-y:\s*[\d.]+vh/);
    expect(rule('.tvbar')).toMatch(/padding:[^;]*var\(--tvbar-safe-x\)[\s\S]*?var\(--tvbar-safe-y\)/);
  });

  it('pushes an unlabelled row\'s buttons into the buttons column', () => {
    // Targets .tvbar-btns, not .tvbar-btn: the buttons are wrapped, so the
    // wrapper is the first child. Written against .tvbar-btn the rule matched
    // nothing and Close measured x=67.2 against x=151.2 for every other row.
    expect(CSS).toMatch(/\.tvbar-row\s*>\s*\.tvbar-btns:first-child\{[^}]*grid-column:2/);
  });

  it('keeps the focus lift for .focusable OUTSIDE the bar', () => {
    // The transform:none override must be scoped to .tvbar descendants, or it
    // would flatten the focus cue on every card and rail in the app.
    const m = CSS.match(/([^\n{]*)\{\s*transform:none\s*\}/g) || [];
    for (const decl of m) {
      if (!/focusable:focus/.test(decl)) continue;
      expect(decl).toMatch(/\.tvbar\s/);
    }
  });
});
