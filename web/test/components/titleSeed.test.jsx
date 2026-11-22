import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

// The title requests never answer: the page stays in its loading state.
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig()),
  fetchTitle: vi.fn(() => new Promise(() => {})),
  fetchTitleFull: vi.fn(() => new Promise(() => {})),
}));
const params = vi.hoisted(() => ({ type: 'movie', id: '42' }));
vi.mock('next/navigation', () => ({
  useParams: () => params, useRouter: () => ({ back() {}, push() {}, prefetch() {} }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _p, ...p }) => <a {...p}>{children}</a> }));
globalThis.fetch = vi.fn(() => new Promise(() => {}));
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.scrollTo = () => {};

const { default: TitlePage } = await import('../../app/title/[type]/[id]/page');
const { default: TitleSkeleton } = await import('../../components/TitleSkeleton');
const { Card } = await import('../../components/Card');
const { clearSeeds, peekSeed } = await import('../../lib/titleSeed');

afterEach(() => { cleanup(); clearSeeds(); });

const card = { tmdbId: 42, mediaType: 'movie', title: 'Kubera', year: 2025,
               poster: '/p42.jpg', backdrop: '/b42.jpg' };

describe('title page first paint', () => {
  it('a hard load (no tapped card) shows the plain skeleton', () => {
    const { container } = render(<TitlePage />);
    expect(container.querySelector('.detail-title .skel')).not.toBeNull();
    expect(container.querySelector('.hero-poster img')).toBeNull();
  });

  it('after a card tap shows the card title, year and poster at once', () => {
    const c = render(<Card title={card} />);
    fireEvent.click(c.container.querySelector('a'));
    c.unmount();
    expect(peekSeed('movie', 42)).toMatchObject({ title: 'Kubera', backdrop: '/b42.jpg' });

    for (const El of [TitlePage, TitleSkeleton]) {
      const { container, unmount } = render(<El />);
      expect(container.querySelector('.detail-title').textContent).toBe('Kubera');
      expect(container.querySelector('.detail-meta').textContent).toContain('2025');
      expect(container.querySelector('.hero-poster img').getAttribute('src')).toContain('/p42.jpg');
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
      unmount();
    }
  });

  it('a different title id does not use the seed', () => {
    const c = render(<Card title={card} />);
    fireEvent.click(c.container.querySelector('a'));
    c.unmount();
    params.id = '43';
    const { container } = render(<TitlePage />);
    expect(container.querySelector('.detail-title .skel')).not.toBeNull();
    params.id = '42';
  });
});

describe('title warm on dwell', () => {
  it('parks one full-record request that the title page then takes', async () => {
    const { warmTitle } = await import('../../lib/titleSeed');
    const { fetchTitleFull } = await vi.importActual('../../lib/api');
    const calls = [];
    globalThis.fetch = vi.fn(async (u) => { calls.push(u); return { ok: true, status: 200, json: async () => ({ title: 'W' }) }; });
    warmTitle('movie', 7);
    warmTitle('movie', 7);
    expect(calls).toEqual(['/api/title/movie/7/full']);
    const r = await fetchTitleFull('movie', '7');
    expect(r.body.title).toBe('W');
    expect(calls).toHaveLength(1);
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
  });
});
