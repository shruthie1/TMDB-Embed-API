import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Card } from '../../components/Card';

afterEach(cleanup);

describe('Card poster', () => {
  it('offers w342/w500/w780 with the card sizes', () => {
    const { container } = render(<Card title={{ tmdbId: 1, mediaType: 'movie', title: 'A', poster: '/p.jpg' }} />);
    const img = container.querySelector('.poster img');
    expect(img.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
    expect(img.getAttribute('srcset')).toBe('https://image.tmdb.org/t/p/w342/p.jpg 342w, https://image.tmdb.org/t/p/w500/p.jpg 500w, https://image.tmdb.org/t/p/w780/p.jpg 780w');
    expect(img.getAttribute('sizes')).toBe('(max-width:559px) 34vw, (min-width:1700px) 290px, 200px');
  });
  it('a full poster url gets no srcset', () => {
    const { container } = render(<Card title={{ tmdbId: 1, mediaType: 'movie', title: 'A', poster: 'https://images.metahub.space/poster/small/tt1/img' }} />);
    const img = container.querySelector('.poster img');
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.hasAttribute('sizes')).toBe(false);
  });
});
