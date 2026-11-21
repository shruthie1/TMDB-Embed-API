import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import useStartupSwitch, { STARTUP_SWITCH_MS } from '../../lib/player/useStartupSwitch';

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
  return { switchTo, rerender: (k) => r.rerender(<Probe restartKey={k} />) };
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
