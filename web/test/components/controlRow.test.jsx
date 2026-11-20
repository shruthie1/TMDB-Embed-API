import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

// One control row at every width: on phones at most five buttons sit directly
// in it (quality, server and audio move into the settings sheet), and each
// picker renders exactly once whatever the width.
let isCompact = false;
window.matchMedia = (q) => ({
  matches: isCompact, media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
const { default: PlayerControls } = await import('../../components/PlayerControls');

const LEVELS = [{ index: 0, label: '1080p', height: 1080 }, { index: 1, label: '720p', height: 720 }];
const SOURCES = [
  { id: 'a', provider: 'demo', quality: '1080p', languages: ['te'], masterUrl: 'https://x/a.m3u8' },
  { id: 'b', provider: 'backup', quality: '720p', languages: ['hi'], masterUrl: 'https://x/b.m3u8' },
];
const AUDIO = [{ id: 0, name: 'Hindi', lang: 'hin' }, { id: 1, name: 'Telugu', lang: 'tel' }];

function mount() {
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  return render(
    <PlayerControls videoRef={{ current: video }} title="RRR" visible
                    sources={SOURCES} currentSource="demo" currentSourceId="a"
                    levels={LEVELS} currentLevel={-1} autoLevel="1080p"
                    audioTracks={AUDIO} currentAudio={1} />,
  );
}
const rowButtons = (c) => c.querySelectorAll('.pctl-row > button, .pctl-row > .pmenu-wrap > button');
const count = (c, sel) => c.querySelectorAll(sel).length;

afterEach(() => { cleanup(); isCompact = false; });

describe('player control row', () => {
  it('phone: Server and Audio sit in the row; Quality stays in the settings sheet (U9)', () => {
    isCompact = true;
    const { container } = mount();
    expect(count(container, '.pctl-row')).toBe(1);
    // play, mute, Server, Audio, Settings, fullscreen
    expect(rowButtons(container).length).toBeLessThanOrEqual(6);
    expect(container.querySelector('.pctl-row > .pmenu-wrap > [aria-label^="Server"]')).not.toBeNull();
    expect(container.querySelector('.pctl-row > .pmenu-wrap > [aria-label^="Audio"]')).not.toBeNull();
    expect(count(container, '[title="Video quality"]')).toBe(0);   // folded away
    expect(container.querySelector('[aria-label^="Picture fit"]')).toBeNull();
    fireEvent.click(container.querySelector('.pctl-row [aria-label="Settings"]'));
    const sheet = container.querySelector('.pmenu-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet.querySelectorAll('[title="Video quality"]').length).toBe(1);
    expect(sheet.querySelectorAll('[aria-label^="Server"]').length).toBe(0);
    expect(sheet.querySelectorAll('[aria-label^="Audio"]').length).toBe(0);
  });

  it('phone: Telugu audio is one tap away, the same depth as desktop, TV and the APK', () => {
    isCompact = true;
    const { container } = mount();
    fireEvent.click(container.querySelector('.pctl-row > .pmenu-wrap > [aria-label^="Audio"]'));
    const list = container.querySelector('.pmenu-pick');
    expect(list).not.toBeNull();
    expect(list.getAttribute('aria-label')).toBe('Audio');
    expect(list.textContent).toMatch('Telugu');
    expect(container.querySelector('.pmenu-sheet')).toBeNull();
  });

  it('phone: Server opens its own list in one tap, labelled Server', () => {
    isCompact = true;
    const { container } = mount();
    fireEvent.click(container.querySelector('.pctl-row > .pmenu-wrap > [aria-label^="Server"]'));
    expect(container.querySelector('.pmenu-pick').getAttribute('aria-label')).toBe('Server');
  });

  it('phone: opening Quality keeps the sheet open, and closing it returns to the sheet', () => {
    isCompact = true;
    const { container } = mount();
    fireEvent.click(container.querySelector('.pctl-row [aria-label="Settings"]'));
    fireEvent.click(container.querySelector('[title="Video quality"]'));
    expect(container.querySelector('.pmenu-sheet .pmenu-pick')).not.toBeNull();
    fireEvent.click(container.querySelector('[title="Video quality"]'));
    expect(container.querySelector('.pmenu-sheet')).not.toBeNull();
    expect(container.querySelector('.pmenu-sheet .pmenu-pick')).toBeNull();
  });

  it('phone: row buttons get a 44px hit area without changing the 38px look', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const phone = css.slice(css.indexOf('@media (max-width:559px){', css.indexOf('.pctl-pick-btn{')));
    expect(phone).toMatch(/\.pctl-row \.icon-btn\{ min-width:38px;min-height:38px \}/);
    expect(phone).toMatch(/\.pctl-row \.icon-btn::after\{[^}]*inset:-3px/);
  });

  it('phone under 400px: Mute steps aside so the row with Server and Audio fits 360px', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/@media \(max-width:399px\)\{\s*\.pctl-mute\{ display:none \}/);
    isCompact = true;
    const { container } = mount();
    expect(container.querySelector('.pctl-row > .pctl-mute')).not.toBeNull();
  });

  it('desktop: one row, every picker rendered once, quality and server use different glyphs', () => {
    const { container } = mount();
    expect(count(container, '.pctl-row')).toBe(1);
    expect(count(container, '[title="Video quality"]')).toBe(1);
    expect(count(container, '[aria-label^="Server"]')).toBe(1);
    expect(count(container, '[aria-label^="Audio"]')).toBe(1);
    // All of them are children of the one row, not a second line.
    for (const b of container.querySelectorAll('.pctl-bottom button:not(.pctl-scrub)')) {
      expect(b.closest('.pctl-row')).not.toBeNull();
    }
    const glyph = (sel) => container.querySelector(`${sel} svg`)?.innerHTML;
    expect(glyph('[title="Video quality"]')).toBeTruthy();
    expect(glyph('[title="Video quality"]')).not.toBe(glyph('[aria-label^="Server"]'));
  });
});

describe('picker buttons lay out as one line', () => {
  it('puts the value label inside the same button as the icon', () => {
    isCompact = false;
    const { container } = mount();
    for (const sel of ['[title="Video quality"]', '[aria-label^="Server"]', '[aria-label^="Audio"]']) {
      const b = container.querySelector(sel);
      expect(b.querySelector('svg')).not.toBeNull();
      const badge = b.querySelector('.pctl-pick-badge');
      expect(badge).not.toBeNull();
      expect(badge.parentElement).toBe(b);
      expect(b.querySelector('svg').parentElement).toBe(b);
    }
    cleanup();
  });

  it('styles them as a row: inline-flex, flex-direction row, never column', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(m => /pctl-pick-btn/.test(m[1]));
    expect(rules.some(m => /\.pctl-row > \.pmenu-wrap > \.pctl-pick-btn\s*$/.test(m[1].trim())
      && /display:inline-flex/.test(m[2]) && /flex-direction:row/.test(m[2]))).toBe(true);
    for (const m of rules) expect(m[2]).not.toMatch(/flex-direction:\s*column/);
  });
});
