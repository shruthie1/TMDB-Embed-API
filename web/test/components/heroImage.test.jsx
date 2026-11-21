import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import Hero from '../../components/Hero';

afterEach(cleanup);

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
    expect(style).toContain('w1280/b1.jpg');
    expect(style).toContain('w780/b1.jpg');
    expect(style).not.toContain('p1.jpg');
    expect(container.querySelectorAll('.hero-dot').length).toBe(0); // B has no backdrop
    expect(container.textContent).toContain('Telugu');
  });
});
