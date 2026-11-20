import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('next/navigation', () => ({ usePathname: () => '/title/movie/1' }));
const { default: Dpad } = await import('../../components/Dpad');

/**
 * The viewer asked for it on a TV: a title page opens with focus on Play, so
 * the remote's first OK plays. The button renders after the data, so Dpad
 * waits for it.
 */
describe('TV: the page opens with focus on its main button', () => {
  afterEach(() => { localStorage.clear(); vi.useRealTimers(); document.body.innerHTML = ''; });

  it('focuses Play once it renders', () => {
    vi.useFakeTimers();
    localStorage.setItem('chitram.tv', JSON.stringify({ v: '1', until: Date.now() + 60000 }));
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
    window.scrollTo = () => {};
    const { unmount } = render(<><Dpad /><main id="m" /></>);
    act(() => { vi.advanceTimersByTime(300); });
    const play = document.createElement('button');
    play.className = 'btn primary';
    play.setAttribute('data-focus', '');
    play.getBoundingClientRect = () => ({ top: 700, bottom: 760, width: 130, height: 60 });
    document.getElementById('m').appendChild(play);
    act(() => { vi.advanceTimersByTime(200); });
    expect(document.activeElement).toBe(play);
    unmount();
  });

  it('does nothing off a TV', () => {
    vi.useFakeTimers();
    window.scrollTo = () => {};
    const { unmount } = render(<><Dpad /><main><button className="btn primary" data-focus="">Play</button></main></>);
    document.querySelector('button').getBoundingClientRect = () => ({ top: 700, bottom: 760, width: 130, height: 60 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.activeElement).toBe(document.body);
    unmount();
  });
});
