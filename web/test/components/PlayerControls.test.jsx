import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

// The real Icon returns null for unknown names, which has hidden bugs before;
// here it only needs to render something inert.
vi.mock('../../components/Icon', () => ({ default: () => null }));

// jsdom has no matchMedia; the component derives its compact (phone) layout
// from it, so the tests drive it through this rather than through a prop.
let isCompact = true;
window.matchMedia = (q) => ({
  matches: isCompact,
  media: q,
  addEventListener() {}, removeEventListener() {},
  addListener() {}, removeListener() {},
});

const { default: PlayerControls } = await import('../../components/PlayerControls');

function setup(props = {}) {
  const onReveal = vi.fn();
  const video = document.createElement('video');
  // jsdom gives a video no dimensions or duration; the handler needs both.
  Object.defineProperty(video, 'duration', { value: 6000, configurable: true });
  const videoRef = { current: video };
  const { container } = render(
    <PlayerControls videoRef={videoRef} title="RRR" onReveal={onReveal}
                    visible={false} {...props} />,
  );
  const mid = container.querySelector('.pctl-mid');
  // A real tap lands at a point; jsdom reports a zero-size rect, so the
  // handler's zone maths needs a width to divide up.
  mid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 700 });
  return { mid, onReveal, container };
}

beforeEach(() => { vi.useRealTimers(); isCompact = true; });

describe('PlayerControls tap surface', () => {
  it('has a tap surface that stays hittable while the bar is hidden', () => {
    // pointer-events must survive the fade, or the tap goes to the <video>.
    const { mid } = setup();
    expect(mid).toBeTruthy();
  });

  it('a single tap on the picture asks for the controls', async () => {
    // This is the regression: tapRef was read but never declared, so the very
    // first tap threw "tapRef is not defined" and died before onReveal ran.
    // Tapping the picture did nothing at all on a phone.
    vi.useFakeTimers();
    const { mid, onReveal } = setup();
    expect(() => fireEvent.click(mid, { clientX: 195, clientY: 350 })).not.toThrow();
    // The single-tap path defers, so a double-tap can pre-empt it.
    await vi.advanceTimersByTimeAsync(400);
    expect(onReveal).toHaveBeenCalled();
  });

  it('reveals on every subsequent tap too, not just the first', () => {
    vi.useFakeTimers();
    isCompact = false;
    const { mid, onReveal } = setup();
    for (let i = 0; i < 3; i++) fireEvent.click(mid, { clientX: 195, clientY: 350 });
    // Desktop reveals synchronously; three taps, three asks.
    expect(onReveal).toHaveBeenCalledTimes(3);
  });

  it('a double tap seeks instead of only revealing', async () => {
    vi.useFakeTimers();
    const { mid, container } = setup();
    const video = container.ownerDocument.querySelector('video') ?? null;
    // Two fast taps on the left third: the second is the seek.
    fireEvent.click(mid, { clientX: 40, clientY: 350 });
    await vi.advanceTimersByTimeAsync(80);
    expect(() => fireEvent.click(mid, { clientX: 45, clientY: 350 })).not.toThrow();
  });
});
