import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRotateFullscreen, ARM_MS } from '../../lib/player/useRotateFullscreen';

/**
 * A stand-in for `window.matchMedia('(orientation: landscape)')`.
 *
 * jsdom has no media query engine, so the hook's only view of orientation is
 * whatever this returns. `set()` flips the state and fires the listeners the
 * same way a real rotation does.
 */
function installMatchMedia(landscape = false) {
  const listeners = new Set();
  const mql = {
    get matches() { return landscape; },
    media: '(orientation: landscape)',
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    // Older WebKit only has these.
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn(() => mql);
  return {
    set(next) {
      landscape = next;
      act(() => { listeners.forEach(fn => fn({ matches: next })); });
    },
    get listenerCount() { return listeners.size; },
  };
}

/** A fake fullscreen-capable element plus the document plumbing around it. */
function installFullscreen({ supported = true } = {}) {
  const calls = { request: 0, exit: 0, lock: [], unlock: 0 };
  const el = document.createElement('div');
  if (supported) {
    el.requestFullscreen = vi.fn(() => {
      calls.request++;
      Object.defineProperty(document, 'fullscreenElement', {
        value: el, configurable: true,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
  }
  document.exitFullscreen = vi.fn(() => {
    calls.exit++;
    Object.defineProperty(document, 'fullscreenElement', {
      value: null, configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  });
  Object.defineProperty(document, 'fullscreenElement', {
    value: null, configurable: true,
  });
  screen.orientation = {
    type: 'portrait-primary',
    lock: vi.fn(o => { calls.lock.push(o); return Promise.resolve(); }),
    unlock: vi.fn(() => { calls.unlock++; }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { el, calls };
}

function harness(props = {}) {
  const api = {};
  function Probe(p) { Object.assign(api, useRotateFullscreen(p)); return null; }
  const view = render(<Probe {...props} />);
  return {
    api,
    rerender: (next) => view.rerender(<Probe {...next} />),
    unmount: () => view.unmount(),
  };
}

let ua;
beforeEach(() => {
  ua = navigator.userAgent;
  setUA('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36');
});
afterEach(() => {
  setUA(ua);
  vi.restoreAllMocks();
  delete window.matchMedia;
});

function setUA(v) {
  Object.defineProperty(navigator, 'userAgent', { value: v, configurable: true });
}

describe('useRotateFullscreen', () => {
  it('goes fullscreen when the phone is rotated to landscape', () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    expect(calls.request).toBe(0);
    act(() => api.arm());               // the viewer tapped play
    mm.set(true);                       // then rotated
    expect(calls.request).toBe(1);
  });

  it('exits fullscreen when rotated back to portrait', async () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    act(() => api.arm());
    mm.set(true);
    expect(calls.request).toBe(1);
    mm.set(false);                      // rotate back
    expect(calls.exit).toBe(1);
  });

  it('does not fire on a TV, which never rotates', () => {
    setUA('Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36');
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    // Arm it, so this test is actually exercising the TV guard and not merely
    // the missing-activation guard — without this the assertion passes even
    // with the TV check deleted, which is to say it tests nothing.
    act(() => api.arm());
    mm.set(true);
    expect(calls.request).toBe(0);
    // And it must not have fallen back to nagging a television for a tap.
    expect(api.needsTap).toBe(false);
    expect(api.canRotateFullscreen).toBe(false);
  });

  it('never calls requestFullscreen when the element does not support it (iOS)', () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen({ supported: false });
    harness({ boxRef: { current: el }, enabled: true });

    mm.set(true);
    // Nothing to call, and crucially no throw.
    expect(calls.request).toBe(0);
    expect(el.requestFullscreen).toBeUndefined();
  });

  it('enters the native video player on iPhone, where the box has no fullscreen API', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen({ supported: false });
    // iPhone only exposes webkitEnterFullscreen on the <video>, not on the box.
    const video = document.createElement('video');
    const enter = vi.fn();
    video.webkitEnterFullscreen = enter;
    el.appendChild(video);
    const { api } = harness({ boxRef: { current: el }, enabled: true });
    // The device CAN reach fullscreen (via the native video path).
    expect(api.canRotateFullscreen).toBe(true);
    act(() => api.arm());               // the viewer tapped play
    mm.set(true);
    // Rotation uses the native path, never the (absent) element API.
    expect(enter).toHaveBeenCalledTimes(1);
    expect(calls.request).toBe(0);
  });

  it('locks the orientation once fullscreen, so the OS rotation lock cannot trap it', async () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    act(() => api.arm());
    mm.set(true);
    await act(async () => {});          // the lock is awaited after the request
    expect(calls.lock).toContain('landscape');
  });

  it('does not fight the user after they exit fullscreen by hand while still landscape', () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    act(() => api.arm());
    mm.set(true);
    expect(calls.request).toBe(1);

    // Escape / system back: fullscreen ends but the phone is still landscape.
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', {
        value: null, configurable: true,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    // A stray re-render must not immediately drag them back in.
    act(() => api.arm());
    mm.set(true);
    expect(calls.request).toBe(1);
  });

  it('stops listening once unmounted', () => {
    const mm = installMatchMedia(false);
    const { el } = installFullscreen();
    const { unmount } = harness({ boxRef: { current: el }, enabled: true });
    expect(mm.listenerCount).toBeGreaterThan(0);
    unmount();
    expect(mm.listenerCount).toBe(0);
  });

  it('does nothing at all while disabled', () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: false });
    // Armed, so the assertion turns on `enabled` rather than on the missing
    // activation that would block it anyway.
    act(() => api.arm());
    mm.set(true);
    expect(calls.request).toBe(0);
    expect(mm.listenerCount).toBe(0);
  });

  it('asks for a tap instead of calling a gesture-gated API it cannot use', () => {
    // The core constraint: `orientationchange` grants no user activation, so a
    // rotation arriving with no recent touch must NOT call requestFullscreen —
    // that call would only be refused with NotAllowedError and fail silently.
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    mm.set(true);                       // rotated, but nobody touched anything
    expect(calls.request).toBe(0);
    expect(api.needsTap).toBe(true);
  });

  it('forgets stale activation once the transient window has passed', () => {
    vi.useFakeTimers();
    try {
      const mm = installMatchMedia(false);
      const { el, calls } = installFullscreen();
      const { api } = harness({ boxRef: { current: el }, enabled: true });

      act(() => api.arm());
      // Long enough that the browser would no longer honour the request.
      act(() => { vi.advanceTimersByTime(ARM_MS + 500); });
      mm.set(true);

      expect(calls.request).toBe(0);
      expect(api.needsTap).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('the tap affordance completes the fullscreen the rotation could not', async () => {
    const mm = installMatchMedia(false);
    const { el, calls } = installFullscreen();
    const { api } = harness({ boxRef: { current: el }, enabled: true });

    mm.set(true);
    expect(api.needsTap).toBe(true);
    expect(calls.request).toBe(0);

    // The tap carries real activation, so this is the path that works.
    await act(async () => { await api.fullscreenFromTap(); });
    expect(calls.request).toBe(1);
    expect(api.needsTap).toBe(false);
  });
});
