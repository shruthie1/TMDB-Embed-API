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
  it('phone: one row of at most five buttons, pickers inside the settings sheet', () => {
    isCompact = true;
    const { container } = mount();
    expect(count(container, '.pctl-row')).toBe(1);
    expect(rowButtons(container).length).toBeLessThanOrEqual(5);
    expect(count(container, '[title="Video quality"]')).toBe(0);   // folded away
    expect(container.querySelector('[aria-label^="Picture fit"]')).toBeNull();
    fireEvent.click(container.querySelector('.pctl-row [aria-label="Settings"]'));
    const sheet = container.querySelector('.pmenu-sheet');
    expect(sheet).not.toBeNull();
    expect(count(container, '[title="Video quality"]')).toBe(1);
    expect(sheet.querySelectorAll('[title="Video quality"]').length).toBe(1);
    expect(sheet.querySelectorAll('[aria-label^="Server"]').length).toBe(1);
    expect(sheet.querySelectorAll('[aria-label^="Audio"]').length).toBe(1);
  });

  it('phone: opening a picker keeps the sheet open, and closing it returns to the sheet', () => {
    isCompact = true;
    const { container } = mount();
    fireEvent.click(container.querySelector('.pctl-row [aria-label="Settings"]'));
    fireEvent.click(container.querySelector('[title="Video quality"]'));
    expect(container.querySelector('.pmenu-sheet .pmenu-pick')).not.toBeNull();
    fireEvent.click(container.querySelector('[title="Video quality"]'));
    expect(container.querySelector('.pmenu-sheet')).not.toBeNull();
    expect(container.querySelector('.pmenu-sheet .pmenu-pick')).toBeNull();
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
