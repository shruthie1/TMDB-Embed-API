import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The D-pad can only reach elements matching [data-focus] (lib/dpad.js). A
// control with `focusable` styling but no attribute is invisible to a remote -
// that is how the whole player became unreachable on TV, in three files.
function sources(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.next')) continue;
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.jsx$/.test(e)) out.push(p);
  }
  return out;
}

describe('D-pad reachability', () => {
  it('every element styled as focusable is also reachable by the remote', () => {
    const misses = [];
    for (const f of [...sources('components'), ...sources('app')]) {
      const src = readFileSync(f, 'utf8');
      // Each JSX tag that mentions the focusable class.
      // Only interactive elements: an <svg> that inherits a focusable class
      // through its className prop is not a control.
      const interactive = /^<(button|a|input|select|textarea|Link|Button|Chip|IconButton)\b/;
      for (const tag of src.match(/<[A-Za-z][^>]*?focusable[^>]*?>/gs) || []) {
        if (tag.includes('data-focus')) continue;
        if (!interactive.test(tag)) continue;
        // Rail arrows are deliberately pointer-only (tabIndex -1).
        if (/tabIndex=\{-1\}/.test(tag)) continue;
        misses.push(`${f}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    expect(misses, `\n${misses.join('\n')}`).toEqual([]);
  });

  it('the D-pad yields left/right to the player when it is not a TV', () => {
    // The reported bug: "arrows are changing button focus". initDpad() runs on
    // EVERY device, and the player is a role=dialog aria-modal, so the D-pad
    // scoped to it and walked focus along the control row - while Player.jsx
    // stood down because focus was on a control. Neither handler seeked.
    const src = readFileSync('lib/dpad.js', 'utf8');
    // The guard must test all three: the direction, that this is not a TV, and
    // that a modal is open. Dropping any one of them breaks either laptop
    // seeking or remote navigation.
    // Anchor on the isTv branch specifically: a second guard (the focused
    // slider, below) now shares the same `(dir === 'left' || ...)` opening, so
    // a loose match picked the wrong one.
    const guard = src.match(/if \(\(dir === 'left' \|\| dir === 'right'\)\s*\n?\s*&& !isTv\(\)[\s\S]{0,200}?return;/);
    expect(guard, 'lib/dpad.js must yield left/right to an open dialog off-TV').toBeTruthy();
    expect(guard[0]).toMatch(/!isTv\(\)/);
    expect(guard[0]).toMatch(/role="dialog"\]\[aria-modal="true"/);
    // Up/down must NOT be surrendered, or the control row becomes unreachable.
    expect(guard[0]).not.toMatch(/'up'|'down'/);
  });

  it('a focused seek bar keeps left/right, so a remote can scrub', () => {
    // The seek bar is role=slider with its own ArrowLeft/ArrowRight handler,
    // but lib/dpad.js only walks [data-focus] - so without BOTH the attribute
    // and this exemption a remote could never scrub, only nudge with the
    // +-10s buttons.
    const dpad = readFileSync('lib/dpad.js', 'utf8');
    const slider = dpad.match(/if \(\(dir === 'left' \|\| dir === 'right'\)[\s\S]{0,160}?role[\s\S]{0,40}?slider'\) return;/);
    expect(slider, 'lib/dpad.js must let a focused slider keep left/right').toBeTruthy();
    // Up/down must still navigate, or the bar becomes a trap.
    expect(slider[0]).not.toMatch(/'up'|'down'/);

    // And the bar must actually be reachable in the first place.
    const ctrls = readFileSync('components/PlayerControls.jsx', 'utf8');
    // Attributes span several lines, so match up to the closing bracket of the
    // opening tag rather than assuming a short window.
    const bar = ctrls.match(/<div className="pctl-scrub"[^>]*>/);
    expect(bar, 'the scrubber element must exist').toBeTruthy();
    expect(bar[0], 'the seek bar must be a D-pad stop').toMatch(/data-focus/);
    expect(bar[0]).toMatch(/role="slider"/);
  });

  it("the player's own arrow gate only stands down on a TV", () => {
    // Its partner half: `navigating` was plain `controls.visible`, which is
    // true on a laptop almost always because any mouse move reveals the
    // controls. It must be qualified by the device.
    const src = readFileSync('components/Player.jsx', 'utf8');
    const line = src.match(/const navigating = .*/);
    expect(line, 'Player.jsx must define `navigating`').toBeTruthy();
    expect(line[0]).toMatch(/onTvDevice/);
  });

  it('dpad and Shortcuts agree on which elements own their arrow keys', () => {
    // A native select uses arrows to change option; stealing them made the
    // sort control unusable from a remote. These two files disagreed.
    const dpad = readFileSync('lib/dpad.js', 'utf8');
    expect(dpad).toMatch(/INPUT\|TEXTAREA\|SELECT/);
  });

  it('focus reaching a page-top hero scrolls the page fully to the top on TV', () => {
    // 'nearest' only brought the hero button to the viewport edge, so coming
    // up from the first rail left the header and backdrop top cut off. The
    // home carousel (.home-hero) and the title hero both take window top.
    const src = readFileSync('lib/dpad.js', 'utf8');
    const branch = src.match(/if \(isTv\(\) && next\.closest\('([^']+)'\)\) \{\s*window\.scrollTo\(\{ top: 0/);
    expect(branch, 'lib/dpad.js must scroll to top when focus lands in a hero').toBeTruthy();
    const sel = branch[1].split(',').map((s) => s.trim());
    expect(sel).toContain('.home-hero');
    expect(sel).toContain('.detail .hero');
    // The class the selector names must be the one Hero.jsx renders.
    expect(readFileSync('components/Hero.jsx', 'utf8')).toMatch(/className="home-hero"/);
  });
});
