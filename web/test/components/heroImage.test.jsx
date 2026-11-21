import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

// The hero reads the title logo from the full record (/api/title/.../full).
const full = vi.hoisted(() => ({ logo: null, calls: [] }));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig()),
  fetchTitleFull: vi.fn(async (type, id) => { full.calls.push(`${type}/${id}`); return { logo: full.logo }; }),
}));
const { default: Hero } = await import('../../components/Hero');

afterEach(() => { cleanup(); full.logo = null; full.calls = []; });

// The hero is the wide backdrop on every form factor; the 2:3 poster belongs to
// row cards only. A title with no backdrop never enters the hero.
describe('Hero image', () => {
  it('paints the backdrop, never the poster', () => {
    const titles = [
      { tmdbId: 1, mediaType: 'movie', title: 'A', poster: '/p1.jpg', backdrop: '/b1.jpg', originalLang: 'te' },
      { tmdbId: 2, mediaType: 'movie', title: 'B', poster: '/p2.jpg', backdrop: null },
    ];
    const { container } = render(<Hero titles={titles} />);
    const art = container.querySelector('.home-hero-art');
    const style = art.getAttribute('style');
    // Desktop/TV --bg-lg is original; phones --bg-sm is w1280.
    expect(style).toContain('original/b1.jpg');
    expect(style).toContain('w1280/b1.jpg');
    expect(style).not.toContain('w780');
    expect(style).not.toContain('p1.jpg');
    expect(container.querySelectorAll('.hero-dot').length).toBe(0); // B has no backdrop
    expect(container.textContent).toContain('Telugu');
  });
});

describe('Hero title logo', () => {
  const titles = [{ tmdbId: 579974, mediaType: 'movie', title: 'RRR', backdrop: '/b.jpg' }];

  it('shows the TMDB logo (w500) with the title as alt text', async () => {
    full.logo = '/logo.png';
    const { container } = render(<Hero titles={titles} />);
    await act(async () => { await Promise.resolve(); });
    expect(full.calls).toEqual(['movie/579974']);
    const img = container.querySelector('.home-hero-title img.title-logo');
    expect(img.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w500/logo.png');
    expect(img.getAttribute('alt')).toBe('RRR');
  });

  it('falls back to the text title when the title has no logo', async () => {
    const { container } = render(<Hero titles={titles} />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('.title-logo')).toBe(null);
    expect(container.querySelector('.home-hero-title').textContent).toBe('RRR');
  });

  it('uses a logo the title already carries without a fetch', async () => {
    const { container } = render(<Hero titles={[{ ...titles[0], logo: '/own.png' }]} />);
    await act(async () => { await Promise.resolve(); });
    expect(full.calls).toEqual([]);
    expect(container.querySelector('.title-logo').getAttribute('src')).toContain('/w500/own.png');
  });
});
