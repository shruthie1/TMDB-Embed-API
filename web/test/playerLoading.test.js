import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../components/Player.jsx', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

// Loading-ux spec, web wiring in Player.jsx. The model and the overlay have
// their own behaviour tests (loadingModel.test.js, loadingOverlay.test.jsx);
// these pin how the player feeds them.
describe('Player loading wiring', () => {
  it('renders the model-driven Loading overlay, not the 8s-timer Resolving one', () => {
    expect(src).toMatch(/<Loading\b/);
    expect(src).not.toMatch(/<Resolving\b/);
    expect(src).toMatch(/loadingView\(/);
  });

  it('search-phase Try again re-asks without the refresh path', () => {
    const at = src.indexOf('<Loading');
    const block = src.slice(at, src.indexOf('/>', at));
    expect(block).toMatch(/onRetry=\{[^}]*retrySearch/);
    const fn = src.slice(src.indexOf('const retrySearch'), src.indexOf('const retrySearch') + 400);
    expect(fn).toMatch(/resolve\.load\(false\)/);
    expect(fn).not.toMatch(/load\(true\)/);
  });

  it('one label source: rowLabel reads the stable labelRows map, not the menu list', () => {
    const fn = src.slice(src.indexOf('const rowLabel'), src.indexOf('const rowLabel') + 300);
    expect(fn).toMatch(/rowLabels/);
    expect(fn).not.toMatch(/menuSources/);
    expect(src).toMatch(/labelRows\(/);
    // The advance toast must not re-number over a filtered list.
    expect(src).not.toMatch(/menuSources\.filter\(\(s\) => s\.masterUrl !== failed\.masterUrl\)/);
  });

  it('the buffering count is attempts tried, not the list index', () => {
    expect(src).not.toMatch(/Source \{sources\.findIndex/);
  });

  it('the loading screen covers the control bar until the first frame (z-index and inert)', () => {
    expect(css).toMatch(/\.overlay\.ov-screen\.ov-resolving\{z-index:6\}/);
    expect(src).toMatch(/covered=\{!framedOnce\}/);
    const pc = readFileSync(fileURLToPath(new URL('../components/PlayerControls.jsx', import.meta.url)), 'utf8');
    expect(pc).toMatch(/inert=\{covered \? '' : undefined\}/);
  });

  it('the toast is centred without a transform the fade-in animation overwrites', () => {
    const rule = css.match(/\.toast\{[^}]*\}/)[0];
    expect(rule).not.toMatch(/translateX/);
    expect(rule).toMatch(/max-width:calc\(100% - 32px\)/);
  });
});
