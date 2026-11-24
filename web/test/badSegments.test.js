import { describe, expect, it } from 'vitest';
import { badSegmentCounter, fatalAction } from '../lib/player/fatalPolicy';

// 2026-11-24 ShowsSt movie/1359490: every fragment on p16-sg.tiktokcdn.com is a
// 70 B 1x1 PNG. hls.js kept loading them and never raised a fatal error.
describe('bad segment guard', () => {
  it('three tiny fragments in a row before the first frame trip it', () => {
    const c = badSegmentCounter();
    expect(c.onFragment(70)).toBe(null);
    expect(c.onFragment(70)).toBe(null);
    expect(c.onFragment(70)).toBe('3x70B');
    expect(c.onFragment(70)).toBe(null);
  });

  it('a real fragment resets the run; subtitles and unknown sizes do not count', () => {
    const c = badSegmentCounter();
    c.onFragment(70); c.onFragment(70);
    expect(c.onFragment(900000)).toBe(null);
    expect(c.onFragment(300, 'subtitle')).toBe(null);
    expect(c.onFragment(undefined)).toBe(null);
    c.onFragment(70);
    expect(c.onFragment(512)).toBe(null);
    expect(c.onFragment(0)).toBe('3x512B');
  });

  it('fails over with a plain message', () => {
    const a = fatalAction({ details: 'badSegments', reason: 'bad segments 3x70B' });
    expect(a).toMatchObject({ kind: 'badsegments', failover: true, reason: 'bad segments 3x70B' });
    expect(a.message).toMatch(/no video/i);
  });
});
