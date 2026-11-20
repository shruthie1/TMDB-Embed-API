import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

vi.mock('../../components/Icon', () => ({ default: () => null }));
window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const { default: PlayerControls, scrubStep, SCRUB_SETTLE_MS } = await import('../../components/PlayerControls');

function setup(props = {}) {
  const video = document.createElement('video');
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  let t = 100;
  Object.defineProperty(video, 'currentTime', { get: () => t, set: (x) => { t = x; }, configurable: true });
  video.play = vi.fn(() => Promise.resolve());
  const onHide = vi.fn();
  const utils = render(<PlayerControls videoRef={{ current: video }} title="RRR" visible tv onHide={onHide} {...props} />);
  const scrub = utils.container.querySelector('.pctl-scrub');
  return { ...utils, video, scrub, onHide, time: () => t };
}

afterEach(() => vi.useRealTimers());

describe('scrubStep', () => {
  it('starts at 10s and speeds up while held', () => {
    expect([1, 3, 4, 8, 9, 16, 17, 40].map(scrubStep)).toEqual([10, 10, 30, 30, 60, 60, 120, 120]);
  });
});

describe('TV remote scrub on the seek bar', () => {
  it('moves a preview, then seeks once and plays after release', () => {
    vi.useFakeTimers();
    const { scrub, video, time } = setup();
    fireEvent.keyDown(scrub, { key: 'ArrowRight' });
    fireEvent.keyDown(scrub, { key: 'ArrowRight', repeat: true });
    expect(time()).toBe(100);                       // preview only
    expect(scrub.getAttribute('aria-valuetext')).toBe('2:00');
    fireEvent.keyUp(scrub, { key: 'ArrowRight' });
    act(() => { vi.advanceTimersByTime(SCRUB_SETTLE_MS); });
    expect(time()).toBe(120);
    expect(video.play).toHaveBeenCalled();
  });

  it('OK confirms at once and resumes', () => {
    const { scrub, video, time } = setup();
    fireEvent.keyDown(scrub, { key: 'ArrowLeft' });
    fireEvent.keyDown(scrub, { key: 'Enter' });
    expect(time()).toBe(90);
    expect(video.play).toHaveBeenCalled();
  });

  it('Down focuses Play', () => {
    const { scrub, container } = setup();
    scrub.focus();
    fireEvent.keyDown(scrub, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(container.querySelector('[data-primary]'));
  });

  it('first Up hides the bar; Up after coming back is left to the D-pad', () => {
    const { scrub, onHide } = setup();
    scrub.focus();
    fireEvent.keyDown(scrub, { key: 'ArrowUp' });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(scrub);
    scrub.focus();
    const ev = fireEvent.keyDown(scrub, { key: 'ArrowUp' });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(ev).toBe(true);                          // not prevented: dpad moves on
  });
});
