import { describe, it, expect } from 'vitest';
import { posterSrcSet, CARD_SIZES, heroBackdrop, logoUrl, poster } from '../lib/api';
import { pickLogo } from '../lib/catalog';

const IMG = 'https://image.tmdb.org/t/p';

describe('card poster srcset', () => {
  it('offers w342, w500 and w780 with their widths', () => {
    expect(posterSrcSet('/p.jpg')).toBe(`${IMG}/w342/p.jpg 342w, ${IMG}/w500/p.jpg 500w, ${IMG}/w780/p.jpg 780w`);
  });
  it('gives no srcset for a full url or no path', () => {
    expect(posterSrcSet('https://images.metahub.space/poster/small/tt1/img')).toBe(null);
    expect(posterSrcSet(null)).toBe(null);
  });
  it('sizes phones at 34vw, TV at 290px, desktop at 200px', () => {
    expect(CARD_SIZES).toBe('(max-width:559px) 34vw, (min-width:1700px) 290px, 200px');
  });
  // A 3x phone: 34vw of 400px = 136px x3 = 408 device px, so w500 is the pick.
  it('makes a 3x phone pick w500 (smallest width >= 408)', () => {
    const need = 0.34 * 400 * 3;
    expect([342, 500, 780].find(w => w >= need)).toBe(500);
  });
});

describe('hero sizes and logo', () => {
  it('hero is w1280 on phones and original elsewhere', () => {
    expect(heroBackdrop('/b.jpg', true)).toBe(`${IMG}/w1280/b.jpg`);
    expect(heroBackdrop('/b.jpg', false)).toBe(`${IMG}/original/b.jpg`);
  });
  it('logo is w500', () => {
    expect(logoUrl('/l.png')).toBe(`${IMG}/w500/l.png`);
    expect(logoUrl(null)).toBe(null);
  });
  it('poster default is still w342', () => {
    expect(poster('/p.jpg')).toBe(`${IMG}/w342/p.jpg`);
  });
});

describe('pickLogo', () => {
  const L = (iso, path, vote = 0, width = 500) => ({ iso_639_1: iso, file_path: path, vote_average: vote, width });

  it('prefers the original language', () => {
    expect(pickLogo([L('en', '/en.png', 10), L('te', '/te.png', 1)], 'te')).toBe('/te.png');
  });
  it('then English', () => {
    expect(pickLogo([L(null, '/null.png', 10), L('zh', '/zh.png', 9), L('en', '/en.png')], 'te')).toBe('/en.png');
  });
  it('then a logo with no language', () => {
    expect(pickLogo([L('zh', '/zh.png', 9), L(null, '/null.png')], 'te')).toBe('/null.png');
  });
  it('picks the best voted, then the widest, within a language', () => {
    expect(pickLogo([L('en', '/a.png', 1), L('en', '/b.png', 5)], 'en')).toBe('/b.png');
    expect(pickLogo([L('en', '/a.png', 5, 800), L('en', '/b.png', 5, 1900)], 'en')).toBe('/b.png');
  });
  it('is null when no logo fits or none exist', () => {
    expect(pickLogo([L('zh', '/zh.png')], 'te')).toBe(null);
    expect(pickLogo([], 'te')).toBe(null);
    expect(pickLogo(undefined, 'te')).toBe(null);
  });
});
