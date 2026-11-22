import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

// Records every hls.js instance and the url it was asked to load.
const made = { all: [] };
class FakeHls {
  static Events = { MANIFEST_PARSED: 'm', LEVEL_SWITCHED: 's', ERROR: 'e',
    AUDIO_TRACKS_UPDATED: 'atu', AUDIO_TRACK_SWITCHED: 'ats', MANIFEST_LOADED: 'ml', FRAG_LOADED: 'fl' };
  static isSupported = () => true;
  // A loader base so the hook wraps fLoader/pLoader as with real hls.js.
  static DefaultConfig = { loader: class { constructor() { this.stats = { loaded: 0 }; } load() {} abort() {} destroy() {} } };
  constructor(cfg) { this.cfg = cfg; this.levels = []; this.audioTracks = []; this.audioTrack = 0;
    this.h = {}; this.destroyed = false; made.all.push(this); }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); }
  emit(ev, d) { (this.h[ev] || []).forEach((f) => f(ev, d)); }
  loadSource(u) { this.src = u; } attachMedia() {} detachMedia() {} stopLoad() {} destroy() { this.destroyed = true; }
}
vi.mock('hls.js', () => ({ default: FakeHls }));
vi.mock('../../lib/subtitles', async (orig) => await orig());

const { useHls } = await import('../../lib/player/useHls');
const { _resetDirectFailures } = await import('../../lib/player/directRoute');

const PROXY = 'https://vm.example/m3u8-proxy?url=x';
const DIRECT = 'https://img1.hscow.com/a.m3u8';

function harness(stream) {
  const onFatal = vi.fn();
  const onRouteFallback = vi.fn();
  const video = Object.assign(document.createElement('video'), { canPlayType: () => '' });
  const videoRef = { current: video };
  const out = { onFatal, onRouteFallback, video, api: null };
  function Probe() { out.api = useHls({ videoRef, stream, onFatal, onRouteFallback }); return null; }
  render(<Probe />);
  return out;
}
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const last = () => made.all[made.all.length - 1];

let logs;
beforeEach(() => {
  made.all = []; _resetDirectFailures();
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('useHls web-direct routing', () => {
  const stream = { id: 'CastleTV-0', provider: 'CastleTV', masterUrl: PROXY, webDirectUrl: DIRECT };

  it('plays the direct url first and logs the decision', async () => {
    harness(stream);
    await flush();
    expect(made.all.length).toBe(1);
    expect(last().src).toBe(DIRECT);
    expect(logs.some((l) => /\[route\] web direct provider=CastleTV host=img1\.hscow\.com/.test(l))).toBe(true);
  });

  it('a single non-fatal fragment error is left to hls.js (no proxy fallback)', async () => {
    const { onFatal } = harness(stream);
    await flush();
    act(() => last().emit('e', { fatal: false, details: 'fragLoadError', response: { code: 0 } }));
    await flush();
    expect(made.all.length).toBe(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('a direct failure before the first frame retries the SAME row via proxy, not failover', async () => {
    const { onFatal, onRouteFallback } = harness(stream);
    await flush();
    const first = last();
    // Two manifest failures escalate to fatal (existing rule); on direct that
    // becomes the same-row proxy retry.
    act(() => first.emit('e', { fatal: false, details: 'manifestLoadError', response: { code: 403 } }));
    act(() => first.emit('e', { fatal: false, details: 'manifestLoadError', response: { code: 403 } }));
    await flush();
    expect(onRouteFallback).toHaveBeenCalledTimes(1);
    expect(first.destroyed).toBe(true);
    expect(made.all.length).toBe(2);
    expect(last().src).toBe(PROXY);
    expect(onFatal).not.toHaveBeenCalled();
    expect(logs.some((l) => /\[route\] web direct-failed .*fallback=proxy/.test(l))).toBe(true);
    // The proxy attempt failing is a normal fatal: failover proceeds.
    act(() => last().emit('e', { fatal: true, details: 'manifestLoadError' }));
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('exposes the attempt mode: direct, then proxy after the fallback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { api } = harness(stream);
    await flush();
    expect(api.routeRef.current).toBe('direct');
    await act(async () => { vi.advanceTimersByTime(10001); });
    await flush();
    expect(api.routeRef.current).toBe('proxy');
  });

  it('a stream with no masterUrl does not keep the previous direct route', async () => {
    const out = { api: null };
    const video = Object.assign(document.createElement('video'), { canPlayType: () => '' });
    const videoRef = { current: video };
    const onFatal = vi.fn();
    const masterless = { id: 'x', provider: 'CastleTV', masterUrl: null };
    function Probe({ s }) { out.api = useHls({ videoRef, stream: s, onFatal }); return null; }
    const { rerender } = render(<Probe s={stream} />);
    await flush();
    expect(out.api.routeRef.current).toBe('direct');
    rerender(<Probe s={masterless} />);
    await flush();
    expect(out.api.routeRef.current).toBeNull();
  });

  it('no first frame within 10 s on direct -> proxy fallback', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { video } = harness(stream);
    await flush();
    expect(last().src).toBe(DIRECT);
    // Bytes keep arriving (slow, not stalled), so only the 10 s cap applies.
    for (let i = 0; i < 10; i++) {
      await act(async () => { video.dispatchEvent(new Event('progress')); vi.advanceTimersByTime(1000); });
    }
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(last().src).toBe(PROXY);
    expect(logs.some((l) => /reason=no-first-frame-10s/.test(l))).toBe(true);
  });

  it('after the first frame a direct error is a normal error (no proxy retry)', async () => {
    const { onFatal, video } = harness(stream);
    await flush();
    act(() => { video.dispatchEvent(new Event('loadeddata')); });
    act(() => last().emit('e', { fatal: true, details: 'fragLoadError' }));
    expect(made.all.length).toBe(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('a row without webDirectUrl plays the proxied url, as before', async () => {
    harness({ ...stream, webDirectUrl: null });
    await flush();
    expect(last().src).toBe(PROXY);
  });

  it('progressive direct: video error before loadeddata switches the src to the proxy', async () => {
    const { video, onFatal } = harness({ ...stream, progressive: true, masterUrl: 'https://vm.example/ts-proxy?url=y', webDirectUrl: 'https://cdn.example/v.mp4' });
    await flush();
    expect(video.getAttribute('src')).toBe('https://cdn.example/v.mp4');
    act(() => { video.dispatchEvent(new Event('error')); });
    expect(video.getAttribute('src')).toBe('https://vm.example/ts-proxy?url=y');
    expect(onFatal).not.toHaveBeenCalled();
  });
});

// P6 (2026-11-22): a direct row with NO bytes for 4 s before the first frame
// goes to the proxy at 4 s, not at the 10 s cap. A slow row that is receiving
// bytes keeps going.
describe('useHls direct stall: no bytes for 4 s', () => {
  const stream = { id: 'MultiMovies-0', provider: 'MultiMovies', masterUrl: PROXY, webDirectUrl: DIRECT };

  it('no bytes at all -> proxy at 4 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { onRouteFallback } = harness(stream);
    await flush();
    expect(last().src).toBe(DIRECT);
    await act(async () => { vi.advanceTimersByTime(3900); });
    expect(last().src).toBe(DIRECT);
    await act(async () => { vi.advanceTimersByTime(200); });
    await flush();
    expect(last().src).toBe(PROXY);
    expect(onRouteFallback).toHaveBeenCalledWith('no-bytes-4s');
    expect(logs.some((l) => /direct-failed .*reason=no-bytes-4s fallback=proxy/.test(l))).toBe(true);
  });

  it('a playlist arrived, then nothing for 4 s -> proxy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    harness(stream);
    await flush();
    await act(async () => { vi.advanceTimersByTime(2000); });
    act(() => last().emit('ml', {}));          // MANIFEST_LOADED = bytes
    await act(async () => { vi.advanceTimersByTime(3900); });
    expect(last().src).toBe(DIRECT);
    await act(async () => { vi.advanceTimersByTime(200); });
    await flush();
    expect(last().src).toBe(PROXY);
  });

  it('fragment bytes flowing (loader stats) keep the direct row past 4 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    harness(stream);
    await flush();
    // The fragment loader the hook wraps: its stats.loaded grows from onprogress.
    const Loader = last().cfg.fLoader;
    expect(Loader).toBeTruthy();
    const l = new Loader();
    l.load({ frag: { type: 'main' } }, {}, { onSuccess() {} });
    for (let i = 1; i <= 8; i++) {
      l.stats.loaded = i * 100_000;
      await act(async () => { vi.advanceTimersByTime(1000); });
    }
    expect(last().src).toBe(DIRECT);
  });
});
