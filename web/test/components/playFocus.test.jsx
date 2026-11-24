import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

// Owner 2026-11-24: "focus on play and resume buttons on loading". Play/Resume
// holds focus from the first frame of the title page, through the skeleton,
// when the record lands, when Play turns into Resume, and when the player
// closes. Never on a touch phone (coarse pointer).

const progress = vi.hoisted(() => ({ value: null, nextUp: null }));
const params = vi.hoisted(() => ({ value: { type: 'movie', id: '42' } }));
const gates = vi.hoisted(() => ({ list: [] }));
vi.mock('../../lib/progress', async (orig) => ({
  ...(await orig()),
  getProgress: () => progress.value,
  getNextUp: (_id, seasons) => (seasons ? progress.nextUp : progress.value),
}));
const TITLE = { tmdbId: 42, mediaType: 'movie', title: 'Kubera', year: 2025, poster: '/p.jpg', backdrop: '/b.jpg' };
const SHOW = { tmdbId: 42, mediaType: 'tv', title: 'Show', year: 2024, poster: '/p.jpg', seasonList: [{ number: 1, name: 'Season 1', episodeCount: 8 }] };
// Each title request waits for the test to release it.
const gated = (body) => new Promise((resolve) => gates.list.push(() => resolve({ ok: true, body })));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig()),
  fetchTitle: vi.fn(() => gated(params.value.type === 'tv' ? SHOW : TITLE)),
  fetchTitleFull: vi.fn(() => gated(params.value.type === 'tv' ? SHOW : TITLE)),
  fetchSimilar: vi.fn(async () => ({ ok: true, body: { titles: [] } })),
}));
vi.mock('next/navigation', () => ({
  useParams: () => params.value, useRouter: () => ({ back() {}, push() {}, prefetch() {} }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _p, ...p }) => <a {...p}>{children}</a> }));
// The real player is 55 kB of hls.js wiring; a stub dialog with a close button stands in.
vi.mock('next/dynamic', () => ({
  default: () => function PlayerStub({ onClose }) {
    return <div role="dialog" aria-modal="true" className="player"><button type="button" className="pclose" onClick={onClose}>Close</button></div>;
  },
}));
vi.mock('../../components/EpisodeList', () => ({
  default: () => <div className="episodes" />, EpisodeListSkeleton: () => <div className="episodes skel" />,
}));
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.scrollTo = () => {};

const { default: TitlePage } = await import('../../app/title/[type]/[id]/page');
const { default: TitleSkeleton } = await import('../../components/TitleSkeleton');

const coarse = (on) => {
  window.matchMedia = (q) => ({ matches: on && q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} });
};

beforeEach(() => {
  progress.value = null; progress.nextUp = null;
  params.value = { type: 'movie', id: '42' };
  gates.list = [];
  coarse(false);
  globalThis.fetch = vi.fn(() => new Promise(() => {}));
});
afterEach(() => { cleanup(); document.body.focus?.(); });

const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const release = async () => { await act(async () => { gates.list.splice(0).forEach((go) => go()); }); await settle(); };
const play = (c) => c.querySelector('.hero-actions .btn.primary');
const active = () => document.activeElement;

describe('Play holds focus on the title page', () => {
  it('skeleton: a real Play button holds focus before the record lands', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    expect(container.querySelector('.title-skeleton')).not.toBeNull();
    const btn = play(container);
    expect(btn?.tagName).toBe('BUTTON');
    expect(btn.textContent.trim()).toBe('Play');
    expect(active()).toBe(btn);
  });

  it('the route loading boundary focuses Play too', async () => {
    const { container } = render(<TitleSkeleton />);
    const btn = play(container);
    expect(btn?.tagName).toBe('BUTTON');
    expect(active()).toBe(btn);
  });

  it('keeps focus on Play when the record lands (no jump to Back or body)', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    await release();
    expect(container.querySelector('.title-skeleton')).toBeNull();
    const btn = play(container);
    expect(btn.textContent.trim()).toBe('Play');
    expect(active()).toBe(btn);
  });

  it('keeps focus when Play turns into Resume (series next-up from the full record)', async () => {
    params.value = { type: 'tv', id: '42' };
    progress.nextUp = { season: 1, episode: 3, resume: true, positionSec: 300 };
    const { container } = render(<TitlePage />);
    await settle();
    await release();
    const btn = play(container);
    expect(btn.textContent).toContain('Resume');
    expect(active()).toBe(btn);
  });

  it('a movie with progress lands on Resume, focused', async () => {
    progress.value = { positionSec: 600, durationSec: 7200, resume: true };
    const { container } = render(<TitlePage />);
    await settle();
    await release();
    const btn = play(container);
    expect(btn.textContent.trim()).toBe('Resume');
    expect(active()).toBe(btn);
  });

  it('a viewer who moved to Back during loading stays there', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    const back = container.querySelector('.detail-back');
    back.focus();
    await release();
    expect(active()).toBe(back);
  });

  it('closing the player puts focus back on Play/Resume', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    await release();
    fireEvent.click(play(container));
    await settle();
    const close = container.querySelector('.player .pclose');
    expect(close).not.toBeNull();
    close.focus();
    fireEvent.click(close);
    await settle();
    expect(container.querySelector('.player')).toBeNull();
    expect(active()).toBe(play(container));
  });

  it('OK on the skeleton Play starts playback once the record lands', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    fireEvent.click(play(container));
    expect(container.querySelector('.player')).toBeNull();
    await release();
    expect(container.querySelector('.player')).not.toBeNull();
  });

  it('touch phone (coarse pointer): no programmatic focus', async () => {
    coarse(true);
    const { container } = render(<TitlePage />);
    await settle();
    expect(active()).not.toBe(play(container));
    await release();
    expect(active()).not.toBe(play(container));
  });
});
