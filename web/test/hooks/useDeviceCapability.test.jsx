import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

const { useDeviceCapability, learnedMaxHeight, forgetMaxHeight } =
  await import('../../lib/player/useDeviceCapability');

const LEVELS = [
  { height: 2160 }, { height: 1080 }, { height: 720 }, { height: 480 },
];

function harness({ quality, videoHeight = 2160, levels = LEVELS }) {
  const hls = { levels, autoLevelCapping: -1 };
  const video = {
    paused: false, readyState: 4, videoHeight,
    getVideoPlaybackQuality: () => quality(),
  };
  const caps = [];
  function Probe() {
    useDeviceCapability({
      videoRef: { current: video }, hlsRef: { current: hls },
      stream: { id: 1 }, onCap: (h) => caps.push(h),
    });
    return null;
  }
  render(<Probe />);
  return { hls, caps, video };
}

beforeEach(() => { vi.useFakeTimers(); forgetMaxHeight(); });
afterEach(() => { vi.useRealTimers(); forgetMaxHeight(); });

const tick = async (ms) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

describe('useDeviceCapability', () => {
  it('caps a rung the decoder cannot keep up with', async () => {
    // 10% dropped is visible judder: film is 24fps, so this is ~2 frames a
    // second going missing.
    let dropped = 0, total = 0;
    const { hls, caps } = harness({
      quality: () => { dropped += 10; total += 100; return { droppedVideoFrames: dropped, totalVideoFrames: total }; },
    });
    await tick(4000);          // first sample, nothing to compare yet
    await tick(4000);          // one bad window
    expect(hls.autoLevelCapping).toBe(-1);   // not on one window alone
    await tick(4000);          // two bad windows
    expect(hls.autoLevelCapping).toBe(1);    // the 1080p rung
    expect(caps).toEqual([1080]);
  });

  it('leaves a healthy device alone', async () => {
    let dropped = 0, total = 0;
    const { hls, caps } = harness({
      quality: () => { total += 100; return { droppedVideoFrames: dropped, totalVideoFrames: total }; },
    });
    for (let i = 0; i < 6; i++) await tick(4000);
    expect(hls.autoLevelCapping).toBe(-1);
    expect(caps).toEqual([]);
  });

  it('does NOT blame the decoder for a network stall', async () => {
    // A stall decodes NO frames. Dropped/total would be 0/0 - the ratio is
    // meaningless, and capping quality would be the wrong remedy entirely.
    const { hls, caps } = harness({
      quality: () => ({ droppedVideoFrames: 50, totalVideoFrames: 100 }),
    });
    for (let i = 0; i < 6; i++) await tick(4000);
    expect(hls.autoLevelCapping).toBe(-1);
    expect(caps).toEqual([]);
  });

  it('forgives one bad window, which is usually a seek', async () => {
    let dropped = 0, total = 0, window = 0;
    const { hls } = harness({
      quality: () => {
        window++;
        dropped += window === 2 ? 20 : 0;   // one bad window, then healthy
        total += 100;
        return { droppedVideoFrames: dropped, totalVideoFrames: total };
      },
    });
    for (let i = 0; i < 6; i++) await tick(4000);
    expect(hls.autoLevelCapping).toBe(-1);
  });

  it('remembers the cap, so the next film starts capped', async () => {
    let dropped = 0, total = 0;
    harness({
      quality: () => { dropped += 10; total += 100; return { droppedVideoFrames: dropped, totalVideoFrames: total }; },
    });
    await tick(4000); await tick(4000); await tick(4000);
    expect(learnedMaxHeight()).toBe(1080);

    // A fresh player on the same device applies it before dropping anything.
    const next = harness({
      quality: () => ({ droppedVideoFrames: 0, totalVideoFrames: 100 }),
    });
    expect(next.hls.autoLevelCapping).toBe(1);
  });

  it('does not step below the bottom rung', async () => {
    let dropped = 0, total = 0;
    const { hls } = harness({
      quality: () => { dropped += 10; total += 100; return { droppedVideoFrames: dropped, totalVideoFrames: total }; },
      videoHeight: 480, levels: [{ height: 480 }],
    });
    for (let i = 0; i < 6; i++) await tick(4000);
    expect(hls.autoLevelCapping).toBe(-1);   // nothing lower to pick
  });
});
