import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { useRecovery } from '../../lib/player/useRecovery';

const STREAM = { masterUrl: 'x' };   // stable identity, as in the component

function harness({ onReResolve } = {}) {
  const api = {};
  const video = document.createElement('video');
  Object.defineProperty(video, 'currentTime', { value: 30, writable: true });
  const videoRef = { current: video };
  const hlsRef = { current: { bandwidthEstimate: 8_000_000, startLoad: vi.fn() } };
  function Probe(){ Object.assign(api, useRecovery({ videoRef, hlsRef,
    stream: STREAM, onReResolve })); return null; }
  render(<Probe />);
  return { api, video, hlsRef };
}
const stall = (v) => act(() => { v.dispatchEvent(new Event('waiting')); });
// advanceTimersByTime also advances the mocked Date.now(), which the ladder
// uses to decide whether fragments are still arriving.
const jump  = (ms) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
afterEach(() => vi.useRealTimers());

describe('useRecovery', () => {
  it('stays silent for the first couple of seconds', () => {
    const { api, video } = harness();
    stall(video);
    jump(2000);
    expect(api.stallStage).toBeNull();
  });

  it('acknowledges a stall at 2.5s', () => {
    const { api, video } = harness();
    stall(video);
    jump(2600);
    expect(api.stallStage).toBe('buffering');
  });

  it('does NOT nudge hls.js while fragments are still arriving', () => {
    // The defect this guards: an early nudge aborted healthy 6-10s segment
    // fetches, and each abort restarted the download from zero.
    const { api, video, hlsRef } = harness();
    stall(video);
    jump(11000);
    act(() => api.noteProgress());      // bytes just arrived
    jump(2000);                         // past the 12s nudge
    expect(hlsRef.current.startLoad).not.toHaveBeenCalled();
    expect(api.stallStage).toBe('buffering');
  });

  it('nudges once nothing has arrived for the progress window', () => {
    const { api, video, hlsRef } = harness();
    stall(video);
    jump(21000);
    expect(hlsRef.current.startLoad).toHaveBeenCalled();
    expect(api.stallStage).toBe('recovering');
  });

  it('re-resolves after the nudge fails, at most twice', () => {
    const onReResolve = vi.fn();
    const { video } = harness({ onReResolve });
    stall(video);
    jump(39000);
    expect(onReResolve).toHaveBeenCalledTimes(1);
  });

  it('offers the manual escape hatch only after the automatic attempts', () => {
    const { api, video } = harness({ onReResolve: () => {} });
    stall(video);
    jump(56000);
    expect(api.stallStage).toBe('stuck');
  });

  it('playing again clears the ladder entirely', () => {
    const { api, video } = harness();
    stall(video);
    jump(2600);
    expect(api.stallStage).toBe('buffering');
    act(() => { video.dispatchEvent(new Event('playing')); });
    expect(api.stallStage).toBeNull();
  });

  it('repeated `waiting` events do not restart the ladder', () => {
    // Restarting meant the later stages never came due and the manual escape
    // hatch never appeared.
    const onReResolve = vi.fn();
    const { video } = harness({ onReResolve });
    stall(video);
    // Extra `waiting` events arrive throughout the stall, as they really do.
    jump(5000);  stall(video);
    jump(10000); stall(video);
    jump(24000);                       // 39s since the FIRST waiting
    // Had the ladder restarted on each event, 38s would not yet have elapsed
    // and the re-resolve would never have fired.
    expect(onReResolve).toHaveBeenCalledTimes(1);
  });

  it('waits longer on a slow link before declaring failure', () => {
    const api = {};
    const video = document.createElement('video');
    const hlsRef = { current: { bandwidthEstimate: 1_000_000, startLoad: vi.fn() } };
    function Probe(){ Object.assign(api, useRecovery({ videoRef:{current:video},
      hlsRef, stream: STREAM })); return null; }
    render(<Probe />);
    stall(video);
    jump(2600);                        // would already be 'buffering' at 1x
    expect(api.stallStage).toBeNull(); // 1.6x patience: not yet
    jump(1500);
    expect(api.stallStage).toBe('buffering');
  });

  it('switches a stalled stream at 25s, not 38s', () => {
    // The ladder gates on fragment progress, so a slow-but-moving stream is
    // never cut. A stream with NO bytes for 25s is dead; waiting 38s with a
    // validated alternative in hand was the slowest part of a failover.
    const onReResolve = vi.fn();
    const { video } = harness({ onReResolve });
    stall(video);
    jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(1);
    expect(onReResolve).toHaveBeenCalledWith({ startup: false });
  });

  it('a source that never started also fails over, flagged as startup', () => {
    // Player's one-shot 15s startup switch covers the FIRST source only. If
    // the alternate never started either, the ladder required currentTime >
    // 0.5 to switch, so the viewer sat until "stuck" with sources unused.
    const onReResolve = vi.fn();
    const api = {};
    const video = document.createElement('video');
    const hlsRef = { current: { bandwidthEstimate: 8_000_000, startLoad: vi.fn() } };
    function Probe(){ Object.assign(api, useRecovery({ videoRef:{current:video},
      hlsRef, stream: STREAM, onReResolve })); return null; }
    render(<Probe />);
    stall(video);
    jump(26000);
    expect(onReResolve).toHaveBeenCalledWith({ startup: true });
  });
  it('escalates again after a stream swap', () => {
    // A re-resolved stream (resolve.load(true)) arrives without clearStall.
    // The latch from the dead stream kept the ladder from ever running again,
    // so the viewer saw "Trying another source…" and a spinner forever.
    const onReResolve = vi.fn();
    const api = {};
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 30, writable: true });
    const hlsRef = { current: { bandwidthEstimate: 8_000_000, startLoad: vi.fn() } };
    const videoRef = { current: video };   // stable, as in the component
    function Probe({ stream }){ Object.assign(api, useRecovery({ videoRef,
      hlsRef, stream, onReResolve })); return null; }
    const { rerender } = render(<Probe stream={STREAM} />);
    stall(video);
    jump(26000);
    expect(api.stallStage).toBe('switching');
    expect(onReResolve).toHaveBeenCalledTimes(1);
    rerender(<Probe stream={{ masterUrl: 'y' }} />);
    stall(video);
    jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(2);
    jump(14000);                       // 40s after the swap
    expect(api.stallStage).toBe('stuck');
  });

  it('holds the ladder offline', () => {
    // An outage must not fail over: every switched-in source fails offline
    // too, so each one was marked dead and the viewer ended on an error.
    const onReResolve = vi.fn();
    const api = {};
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 30, writable: true });
    const hlsRef = { current: { bandwidthEstimate: 8_000_000, startLoad: vi.fn() } };
    const videoRef = { current: video };
    function Probe({ online }){ Object.assign(api, useRecovery({ videoRef,
      hlsRef, stream: STREAM, onReResolve, online })); return null; }
    const { rerender } = render(<Probe online={false} />);
    stall(video);
    jump(60000);
    expect(onReResolve).toHaveBeenCalledTimes(0);
    expect(api.stallStage).toBe('switching');
    rerender(<Probe online />);
    jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(1);
  });
  it('caps re-resolves even when each re-resolve swaps the stream', () => {
    // resolve.load(true) hands back a NEW stream object. Counting per stream
    // reset the cap on every swap: a dead upstream re-resolved (refresh=1)
    // every 25s forever and the stuck buttons never stayed up.
    const api = {};
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 30, writable: true });
    const videoRef = { current: video };
    const hlsRef = { current: { bandwidthEstimate: 8_000_000, startLoad: vi.fn() } };
    const swap = { current: null };
    const onReResolve = vi.fn(() => swap.current());
    function Probe(){
      const [stream, setStream] = useState({ masterUrl: 's0' });
      swap.current = () => setStream({ masterUrl: `s${Math.random()}` });
      Object.assign(api, useRecovery({ videoRef, hlsRef, stream, onReResolve, titleKey: 'movie:1' }));
      return null;
    }
    render(<Probe />);
    for (let i = 0; i < 4; i++) { stall(video); jump(26000); }
    expect(onReResolve).toHaveBeenCalledTimes(2);
    expect(api.stallStage).toBe('stuck');
    jump(120000);
    expect(onReResolve).toHaveBeenCalledTimes(2);
    expect(api.stallStage).toBe('stuck');
  });

  it('a successful play or a new title gives the ladder its re-resolves back', () => {
    const api = {};
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 30, writable: true });
    const videoRef = { current: video };
    const hlsRef = { current: { bandwidthEstimate: 8_000_000, startLoad: vi.fn() } };
    const onReResolve = vi.fn();
    function Probe({ stream, titleKey }){ Object.assign(api, useRecovery({ videoRef,
      hlsRef, stream, onReResolve, titleKey })); return null; }
    const { rerender } = render(<Probe stream={{ a: 1 }} titleKey="movie:1" />);
    stall(video); jump(26000);
    rerender(<Probe stream={{ a: 2 }} titleKey="movie:1" />);
    stall(video); jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(2);
    act(() => { video.dispatchEvent(new Event('playing')); });
    stall(video); jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(3);
    rerender(<Probe stream={{ a: 3 }} titleKey="movie:1" />);
    stall(video); jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(4);
    rerender(<Probe stream={{ a: 4 }} titleKey="movie:1" />);
    stall(video); jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(4);   // cap reached
    rerender(<Probe stream={{ a: 5 }} titleKey="tv:2:1:1" />);
    stall(video); jump(26000);
    expect(onReResolve).toHaveBeenCalledTimes(5);   // new title
  });
});
