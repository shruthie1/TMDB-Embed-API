import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

// P13 + P14 (2026-11-22): the details page warms the VM answer AND the
// browser-side providers (OneTouchTV) only after ~1.5 s, or at once on
// hover/focus of Play. Leaving sooner starts nothing.

const prewarm = vi.hoisted(() => ({ vm: vi.fn(), client: vi.fn() }));
vi.mock('../../lib/backend', async (orig) => ({ ...(await orig()), prewarmStreams: prewarm.vm }));
vi.mock('../../lib/clientPrewarm', async (orig) => ({ ...(await orig()), prewarmClientProviders: prewarm.client }));
const TITLE = { tmdbId: 42, mediaType: 'movie', title: 'Kubera', year: 2025, poster: '/p.jpg', backdrop: '/b.jpg' };
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig()),
  fetchTitle: vi.fn(async () => ({ ok: true, body: TITLE })),
  fetchTitleFull: vi.fn(async () => ({ ok: true, body: TITLE })),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ type: 'movie', id: '42' }), useRouter: () => ({ back() {}, push() {}, prefetch() {} }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _p, ...p }) => <a {...p}>{children}</a> }));
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
window.scrollTo = () => {};

const { createDwell, PREWARM_DWELL_MS } = await import('../../lib/prewarmDwell');
const { default: TitlePage } = await import('../../app/title/[type]/[id]/page');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  prewarm.vm.mockClear(); prewarm.client.mockClear();
  globalThis.fetch = vi.fn(() => new Promise(() => {}));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

describe('createDwell', () => {
  it('starts once after the dwell, counted from page open', () => {
    let t = 1000;
    const start = vi.fn();
    const d = createDwell({ start, openedAt: 1000, now: () => t });
    t = 1600;              // 600 ms already spent loading the record
    d.arm();
    vi.advanceTimersByTime(PREWARM_DWELL_MS - 600 - 1);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    d.now();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('play intent starts at once; leaving first starts nothing', () => {
    const a = vi.fn(); const b = vi.fn();
    const da = createDwell({ start: a }); da.arm(); da.now();
    expect(a).toHaveBeenCalledWith('play-intent');
    const db = createDwell({ start: b }); db.arm(); db.cancel();
    vi.advanceTimersByTime(5000);
    expect(b).not.toHaveBeenCalled();
  });
});

describe('details page prewarm', () => {
  it('nothing before 1.5 s; VM and OneTouchTV prewarm at 1.5 s', async () => {
    render(<TitlePage />);
    await settle();
    act(() => { vi.advanceTimersByTime(PREWARM_DWELL_MS - 50); });
    expect(prewarm.vm).not.toHaveBeenCalled();
    expect(prewarm.client).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60); });
    expect(prewarm.vm).toHaveBeenCalledWith('movie', 42, {});
    expect(prewarm.client).toHaveBeenCalledWith('movie', 42, {});
  });

  it('leaving before 1.5 s starts no prewarm', async () => {
    const { unmount } = render(<TitlePage />);
    await settle();
    act(() => { vi.advanceTimersByTime(1000); });
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(prewarm.vm).not.toHaveBeenCalled();
    expect(prewarm.client).not.toHaveBeenCalled();
  });

  it('hover on Play starts it at once, and only once', async () => {
    const { container } = render(<TitlePage />);
    await settle();
    const play = [...container.querySelectorAll('button')].find((b) => /Play|Resume/.test(b.textContent));
    fireEvent.pointerEnter(play);
    expect(prewarm.vm).toHaveBeenCalledTimes(1);
    expect(prewarm.client).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(prewarm.vm).toHaveBeenCalledTimes(1);
  });
});
