'use client';
import { useEffect } from 'react';
import { canFailOver } from './offlineRecovery';

// A server-side validation only proves that bytes exist from the VM. On a
// user's device the first frame can still take 14-19s, especially when a
// provider's CDN route is slow. Once another validated source is already in
// hand, switch at startup instead of waiting for the mid-playback recovery
// ladder (which intentionally waits much longer for ordinary stalls).
//
// This is scoped to one stream and fires once. It never interrupts a source
// that has reached a playable readyState, and it does not start a new
// resolve; the alternate URL is already validated and in memory.
// Give the selected source enough time to receive its first media
// fragment on high-latency mobile/TV networks. Switching at 8s looked
// like provider flapping even when playback was about to start.
export const STARTUP_SWITCH_MS = 15000;

/**
 * `restartKey` re-arms the window: useHls bumps it when a direct row falls
 * back to its proxied url, so the proxy attempt gets the full 15 s before the
 * player moves to another server (review I3, 2026-11-21).
 */
export default function useStartupSwitch({ stream, restartKey = 0, videoRef, usedRef, startedRef,
  sourceListRef, currentSourceRef, recoverBySwitchingRef }) {
  useEffect(() => {
    if (!stream) return undefined;
    const timer = setTimeout(() => {
      const v = videoRef.current;
      if (usedRef.current || startedRef.current || !v
          || v.readyState >= 3 || !sourceListRef.current.length) return;
      const alternate = sourceListRef.current.find(
        s => s.masterUrl && s.provider !== currentSourceRef.current,
      );
      if (!alternate || !canFailOver(globalThis.navigator?.onLine)) return;
      usedRef.current = true;
      recoverBySwitchingRef.current?.('startup timeout');
    }, STARTUP_SWITCH_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, restartKey]);
}
