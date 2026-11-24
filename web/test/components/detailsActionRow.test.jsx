import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Owner 2026-11-24: Start over, My List and Refresh sit in ONE row. Refresh is
// a small round icon-only button right of My List, not a separate text line.

const progress = vi.hoisted(() => ({ value: null }));
vi.mock('../../lib/progress', async (orig) => ({
  ...(await orig()),
  getProgress: () => progress.value,
  getNextUp: () => progress.value,
}));
const TITLE = { tmdbId: 42, mediaType: 'movie', title: 'Kubera', year: 2025, poster: '/p.jpg', backdrop: '/b.jpg' };
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig()),
  fetchTitle: vi.fn(async () => ({ ok: true, body: TITLE })),
  fetchTitleFull: vi.fn(async () => ({ ok: true, body: TITLE })),
  fetchSimilar: vi.fn(async () => ({ ok: true, body: { titles: [] } })),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ type: 'movie', id: '42' }), useRouter: () => ({ back() {}, push() {}, prefetch() {} }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _p, ...p }) => <a {...p}>{children}</a> }));
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.scrollTo = () => {};

const { default: TitlePage } = await import('../../app/title/[type]/[id]/page');

beforeEach(() => {
  progress.value = null;
  globalThis.fetch = vi.fn(() => new Promise(() => {}));
});
afterEach(() => { cleanup(); });

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const labels = (row) => [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim());

describe('details action row', () => {
  it('with a resume: Play, Start over, My List, then the refresh icon, in one row', async () => {
    progress.value = { positionSec: 600, durationSec: 7200, resume: true };
    const { container } = render(<TitlePage />);
    await settle();
    const row = container.querySelector('.hero-actions .actions');
    expect(row).not.toBeNull();
    const names = labels(row);
    expect(names.slice(1)).toEqual(['Start over', 'My List', 'Refresh sources']);
    const btn = row.querySelector('button[aria-label="Refresh sources"]');
    expect(btn.getAttribute('title')).toBe('Refresh sources');
    expect(btn.className).toContain('refresh-icon');
    expect(btn.className).toContain('btn');
    // Icon only: no visible label text inside the button.
    expect(btn.textContent.trim()).toBe('');
    expect(btn.querySelector('svg, .refresh-spin')).not.toBeNull();
  });

  it('without a resume: My List + the refresh icon', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    const row = container.querySelector('.hero-actions .actions');
    expect(labels(row).slice(1)).toEqual(['My List', 'Refresh sources']);
  });

  it('the old "Refresh sources" text line is gone', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    const visible = [...container.querySelectorAll('button, span')]
      .filter((e) => e.textContent.trim() === 'Refresh sources');
    expect(visible).toEqual([]);
  });

  it('a press shows the spinner and the result note in the row', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, count: 0, streams: [] }) }));
    const { container } = render(<TitlePage />);
    await settle();
    const btn = container.querySelector('button[aria-label="Refresh sources"]');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.querySelector('.refresh-spin')).not.toBeNull();
    await settle();
    const note = container.querySelector('.hero-actions .refresh-note');
    expect(note.getAttribute('aria-live')).toBe('polite');
  });
});

// jsdom does no layout, so the stylesheet carries these rules; screenshots
// at 390x844, 844x390 and 1920x1080 checked the result.
describe('details layout rules', () => {
  const css = readFileSync(path.join(__dirname, '..', '..', 'app', 'globals.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  it('the refresh icon is round with a visible focus ring', () => {
    expect(css).toMatch(/\.refresh-icon\{[^}]*border-radius:50%/);
    // Keyboard focus: the shared ring, and nothing turns it off for this button.
    expect(css).toMatch(/html :focus-visible,[^{]*\{outline:var\(--focus-ring\)/);
    expect(css).not.toMatch(/refresh-icon[^{]*:focus[^{]*\{[^}]*outline:none/);
  });
  it('landscape: the hero fills the viewport height', () => {
    const i = css.indexOf('@media (orientation:landscape) and (min-width:560px)');
    expect(i).toBeGreaterThan(-1);
    expect(css.slice(i, i + 1500)).toMatch(/\.hero\{[^}]*min-height:calc\(100svh/);
  });
});
