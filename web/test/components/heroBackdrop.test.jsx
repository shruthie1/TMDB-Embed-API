import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import HeroBackdrop from '../../components/HeroBackdrop';

// The detail backdrop stays one element from skeleton to loaded page and only
// swaps its image once the new one has loaded, so the hero never goes dark
// between the fast (Cinemeta) and full (TMDB) records.
let images;
class FakeImage {
  constructor() { images.push(this); }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
}

beforeEach(() => { images = []; globalThis.Image = FakeImage; });
afterEach(cleanup);

const art = c => c.querySelector('.page-backdrop');
async function load(img) { await act(async () => { img.onload(); await Promise.resolve(); }); }

describe('HeroBackdrop', () => {
  it('shimmers until the first image loads, then shows it', async () => {
    const { container, rerender } = render(<HeroBackdrop path={null} />);
    expect(art(container).classList.contains('skel')).toBe(true);
    rerender(<HeroBackdrop path="https://images.metahub.space/background/medium/tt1/img" />);
    expect(art(container).classList.contains('skel')).toBe(true);
    await load(images[0]);
    expect(art(container).classList.contains('skel')).toBe(false);
    expect(art(container).getAttribute('data-src')).toBe('https://images.metahub.space/background/medium/tt1/img');
  });

  it('keeps the same element and the old image until the new one loads', async () => {
    const { container, rerender } = render(<HeroBackdrop path="https://a.example/fast.jpg" />);
    const first = art(container);
    await load(images[0]);
    rerender(<HeroBackdrop path="/full.jpg" />);
    expect(art(container)).toBe(first);
    expect(first.getAttribute('data-src')).toBe('https://a.example/fast.jpg');
    await load(images[1]);
    expect(art(container)).toBe(first);
    expect(first.getAttribute('data-src')).toBe('https://image.tmdb.org/t/p/w1280/full.jpg');
  });

  it('keeps the shown image when a later one fails, and stops shimmering when the first fails', async () => {
    const { container, rerender } = render(<HeroBackdrop path="/bad.jpg" />);
    act(() => images[0].onerror());
    expect(art(container).classList.contains('skel')).toBe(false);
    expect(art(container).getAttribute('data-src')).toBe(null);
    rerender(<HeroBackdrop path="/good.jpg" />);
    await load(images[1]);
    rerender(<HeroBackdrop path="/bad2.jpg" />);
    act(() => images[2].onerror());
    expect(art(container).getAttribute('data-src')).toBe('https://image.tmdb.org/t/p/w1280/good.jpg');
  });
});
