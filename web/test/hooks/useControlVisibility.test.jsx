import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useControlVisibility, HIDE_MS } from '../../lib/player/useControlVisibility';

/** Renders the hook and exposes its value for assertions. */
function harness(props = {}) {
  const api = {};
  function Probe(p) { Object.assign(api, useControlVisibility(p)); return null; }
  const view = render(<Probe {...props} />);
  return { api, rerender: (next) => view.rerender(<Probe {...next} />) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useControlVisibility', () => {
  it('starts visible and hides after the timeout', () => {
    const { api } = harness();
    expect(api.visible).toBe(true);
    act(() => { vi.advanceTimersByTime(HIDE_MS + 50); });
    expect(api.visible).toBe(false);
  });

  it('reveal() shows and restarts the clock', () => {
    const { api } = harness();
    act(() => { vi.advanceTimersByTime(HIDE_MS + 50); });
    expect(api.visible).toBe(false);
    act(() => api.reveal());
    expect(api.visible).toBe(true);
    // Most of a cycle later it is still up, because reveal restarted it.
    act(() => { vi.advanceTimersByTime(HIDE_MS - 500); });
    expect(api.visible).toBe(true);
    act(() => { vi.advanceTimersByTime(600); });
    expect(api.visible).toBe(false);
  });

  it('reveal() is one-way: calling it twice never hides', () => {
    // The regression this guards: a toggle could be raced by the wake-up
    // listener, so a tap resolved to "hide" no matter what.
    const { api } = harness();
    act(() => api.reveal());
    act(() => api.reveal());
    act(() => api.reveal());
    expect(api.visible).toBe(true);
  });

  it('holdOpen keeps the controls up past the timeout', () => {
    const { api } = harness({ holdOpen: true });
    act(() => { vi.advanceTimersByTime(HIDE_MS * 3); });
    expect(api.visible).toBe(true);
  });

  it('releasing holdOpen restarts the clock rather than hiding at once', () => {
    const { api, rerender } = harness({ holdOpen: true });
    act(() => { vi.advanceTimersByTime(HIDE_MS * 2); });
    expect(api.visible).toBe(true);
    act(() => rerender({ holdOpen: false }));
    expect(api.visible).toBe(true);          // not yanked away
    act(() => { vi.advanceTimersByTime(HIDE_MS + 50); });
    expect(api.visible).toBe(false);
  });

  it('a key press reveals them, so a TV remote is never stranded', () => {
    const { api } = harness();
    act(() => { vi.advanceTimersByTime(HIDE_MS + 50); });
    expect(api.visible).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })); });
    expect(api.visible).toBe(true);
  });

  it('does NOT wake on mousemove', () => {
    // Touch devices synthesise a mousemove alongside every tap; listening for
    // it is what raced the tap handler in three separate regressions.
    const el = document.createElement('div');
    document.body.appendChild(el);
    const { api } = harness({ surface: el });
    act(() => { vi.advanceTimersByTime(HIDE_MS + 50); });
    expect(api.visible).toBe(false);
    act(() => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); });
    expect(api.visible).toBe(false);
  });

  it('hide() takes them away immediately', () => {
    const { api } = harness();
    act(() => api.hide());
    expect(api.visible).toBe(false);
  });
});
