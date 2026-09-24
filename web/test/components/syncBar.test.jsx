import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { act } from 'react';
import SyncBar, { fmtOffset, SYNC_MIN, SYNC_MAX } from '../../components/player/SyncBar';

// jsdom gives every element a zero-width rect, so a pointer drag cannot be
// converted to a value without one. 200px wide starting at x=0 keeps the
// arithmetic readable: x=100 is the centre, which is zero.
function mount(props = {}) {
  const utils = render(<SyncBar {...props} />);
  const bar = utils.container.querySelector('.sync-bar');
  // Stub both the hit area and the inner track with the same geometry, so the
  // test does not depend on which of the two valueAt() happens to measure.
  const track = utils.container.querySelector('.sync-bar-track');
  const rect = () => ({ left: 50, width: 200, top: 0, height: 20 });
  bar.getBoundingClientRect = rect;
  track.getBoundingClientRect = rect;
  bar.setPointerCapture = () => {};
  // jsdom has no real PointerEvent: fireEvent.pointerDown delivers clientX as
  // null, so a drag cannot be expressed through it at all (measured - the
  // handler saw `null` and every position collapsed to 0). A native Event with
  // the coordinate set by hand is the only way to exercise the geometry.
  const pointer = (type, clientX) => {
    const ev = new Event(type, { bubbles: true });
    ev.clientX = clientX;
    ev.pointerId = 1;
    act(() => { bar.dispatchEvent(ev); });
  };
  return { ...utils, bar, track, pointer };
}

describe('audio timing bar', () => {
  it('reads out the direction, not just the number', () => {
    // "-0.5s" does not say whether the audio moves earlier or later, and that
    // is the only thing the viewer is actually deciding.
    expect(fmtOffset(0)).toBe('In sync');
    expect(fmtOffset(0.5)).toBe('Audio later 0.50s');
    expect(fmtOffset(-0.5)).toBe('Audio earlier 0.50s');
  });

  it('treats a hair either side of centre as in sync', () => {
    expect(fmtOffset(0.01)).toBe('In sync');
    expect(fmtOffset(-0.01)).toBe('In sync');
  });

  it('centre of the bar is zero, not the left edge', () => {
    const onPreview = vi.fn();
    const { pointer } = mount({ value: 0, onPreview });
    pointer('pointerdown', 150);
    expect(onPreview).toHaveBeenCalledWith(0);
  });

  it('maps the ends of the bar to the full range', () => {
    const onPreview = vi.fn();
    const { pointer } = mount({ value: 0, onPreview });
    pointer('pointerdown', 50);
    expect(onPreview).toHaveBeenLastCalledWith(SYNC_MIN);
    pointer('pointermove', 250);
    expect(onPreview).toHaveBeenLastCalledWith(SYNC_MAX);
  });

  it('previews on every move but commits only once, on release', () => {
    // A commit can cost a server re-pair and a re-buffer, so firing one per
    // pointermove would reload the stream dozens of times in a single drag.
    const onPreview = vi.fn();
    const onCommit = vi.fn();
    const { pointer } = mount({ value: 0, onPreview, onCommit });
    pointer('pointerdown', 150);
    pointer('pointermove', 190);
    pointer('pointermove', 210);
    expect(onPreview.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onCommit).not.toHaveBeenCalled();
    pointer('pointerup', 210);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1.8);
  });

  it('ignores a move that never began with a press', () => {
    const onPreview = vi.fn();
    const { pointer } = mount({ value: 0, onPreview });
    pointer('pointermove', 230);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('steps by one 50ms frame with the arrow keys', () => {
    const onCommit = vi.fn();
    const { bar } = mount({ value: 0, onCommit });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledWith(0.05);
  });

  it('Home returns to in sync from anywhere', () => {
    const onCommit = vi.fn();
    const { bar } = mount({ value: 2.4, onCommit });
    fireEvent.keyDown(bar, { key: 'Home' });
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it('offers a reset only when it would do something', () => {
    const a = mount({ value: 0 });
    expect(a.container.querySelector('.sync-bar-reset')).toBeNull();
    const b = mount({ value: 0.8 });
    expect(b.container.querySelector('.sync-bar-reset')).toBeTruthy();
  });

  it('announces the offset to a screen reader', () => {
    const { bar } = mount({ value: 1.25 });
    expect(bar.getAttribute('role')).toBe('slider');
    expect(bar.getAttribute('aria-valuenow')).toBe('1.25');
    expect(bar.getAttribute('aria-valuetext')).toBe('Audio later 1.25s');
  });
});
