import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import useStartupSwitch, { STARTUP_SWITCH_MS } from '../../lib/player/useStartupSwitch';
import { SWITCH_FLOW_GAP_MS, SWITCH_FLOWING_MAX_MS } from '../../lib/player/switchFlow';

// The 15 s startup switch must give a same-row direct->proxy fallback its own
// full window (review I3): a direct timeout at 10 s used to leave the proxy 5 s.
function harness() {
  const switchTo = vi.fn();
  const video = document.createElement('video');
  const refs = {
    videoRef: { current: video },
    usedRef: { current: false },
    startedRef: { current: false },
    sourceListRef: { current: [{ masterUrl: 'https://vm/a', provider: 'A' }, { masterUrl: 'https://vm/b', provider: 'B' }] },
    currentSourceRef: { current: 'A' },
    recoverBySwitchingRef: { current: switchTo },
  };
  const stream = { masterUrl: 'https://vm/a' };
  function Probe({ restartKey }) { useStartupSwitch({ stream, restartKey, ...refs }); return null; }
  const r = render(<Probe restartKey={0} />);
  return { switchTo, video, rerender: (k) => r.rerender(<Probe restartKey={k} />) };
}

afterEach(() => vi.useRealTimers());

describe('useStartupSwitch', () => {
  it('switches server after 15 s with no playable picture', () => {
    vi.useFakeTimers();
    const { switchTo } = harness();
    act(() => { vi.advanceTimersByTime(STARTUP_SWITCH_MS + 1); });
    expect(switchTo).toHaveBeenCalledWith('startup timeout');
  });

  it('a route fallback at 10 s re-arms the clock: no switch at 15 s, switch at 25 s', () => {
    vi.useFakeTimers();
    const { switchTo, rerender } = harness();
    act(() => { vi.advanceTimersByTime(10000); });
    rerender(1);
    act(() => { vi.advanceTimersByTime(5001); });
    expect(switchTo).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(10000); });
    expect(switchTo).toHaveBeenCalledTimes(1);
  });
});

// 2026-11-24: a NetMirror mp4 (bcdnxw) has a 7,323,216-byte moov at the front.
// On 4g the first play gets no metadata until all of it is in, so a fixed 15 s
// cut switched away while bytes were still arriving. Same rule as the in-player
// switch (switchFlow bytesFlowing): wait while `progress` fires, cap 45 s.
describe('useStartupSwitch waits while bytes arrive', () => {
  const progressEvery = (video, ms, until) => {
    for (let t = 0; t < until; t += ms) {
      act(() => { vi.advanceTimersByTime(ms); video.dispatchEvent(new Event('progress')); });
    }
  };

  it('progress every 1 s: no switch at 15 s or 30 s, switch at the 45 s cap', () => {
    vi.useFakeTimers();
    const { switchTo, video } = harness();
    progressEvery(video, 1000, 30000);
    expect(switchTo).not.toHaveBeenCalled();
    progressEvery(video, 1000, SWITCH_FLOWING_MAX_MS - 30000 - 1000);
    expect(switchTo).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1500); video.dispatchEvent(new Event('progress')); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(switchTo).toHaveBeenCalledWith('startup timeout');
  });

  it('bytes stop at 14 s: wait at 15 s, switch once the gap passes', () => {
    vi.useFakeTimers();
    const { switchTo, video } = harness();
    act(() => { vi.advanceTimersByTime(14000); video.dispatchEvent(new Event('progress')); });
    act(() => { vi.advanceTimersByTime(1001); });
    expect(switchTo).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(SWITCH_FLOW_GAP_MS); });
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  it('progress from before a re-arm never counts', () => {
    vi.useFakeTimers();
    const { switchTo, video, rerender } = harness();
    act(() => { vi.advanceTimersByTime(9999); video.dispatchEvent(new Event('progress')); });
    act(() => { vi.advanceTimersByTime(1); });
    rerender(1);
    act(() => { vi.advanceTimersByTime(STARTUP_SWITCH_MS + 1); });
    expect(switchTo).toHaveBeenCalledTimes(1);
  });
});
