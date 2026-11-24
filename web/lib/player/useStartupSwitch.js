'use client';
import { useEffect } from 'react';
import { canFailOver } from './offlineRecovery';
import { bytesFlowing, SWITCH_FLOWING_MAX_MS, SWITCH_TICK_MS } from './switchFlow';

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
/** No picture and no other row to switch to: the start ends on the player's
 *  end card at this point instead of "Starting <server>" forever (owner
 *  2026-11-24). Rows that land before it are still switched to. */
export const STARTUP_GIVE_UP_MS = 45000;

/**
 * `restartKey` re-arms the window: useHls bumps it when a direct row falls
 * back to its proxied url, so the proxy attempt gets the full 15 s before the
 * player moves to another server (review I3, 2026-11-21).
 *
 * Bytes still arriving at 15 s (a video `progress` event within
 * SWITCH_FLOW_GAP_MS) hold the switch, up to SWITCH_FLOWING_MAX_MS from the
 * start: a NetMirror mp4 has a 7.3 MB moov at the front and shows no metadata
 * on 4g until all of it is in. Same rule as the in-player switch (switchFlow).
 */
export default function useStartupSwitch({ stream, restartKey = 0, videoRef, usedRef, startedRef,
  sourceListRef, currentSourceRef, recoverBySwitchingRef, giveUpRef = null }) {
  useEffect(() => {
    if (!stream) return undefined;
    const startedAt = Date.now();
    let lastProgressAt = 0;
    const v0 = videoRef.current;
    const onProgress = () => { lastProgressAt = Date.now(); };
    v0?.addEventListener('progress', onProgress);
    let timer = null;
    const check = () => {
      const v = videoRef.current;
      if (usedRef.current || startedRef.current || !v
          || v.readyState >= 3 || !sourceListRef.current.length) return;
      const now = Date.now();
      if (now - startedAt < SWITCH_FLOWING_MAX_MS && bytesFlowing({ since: startedAt, lastProgressAt, now })) {
        timer = setTimeout(check, SWITCH_TICK_MS);
        return;
      }
      const alternate = sourceListRef.current.find(
        s => s.masterUrl && s.provider !== currentSourceRef.current,
      );
      if (!canFailOver(globalThis.navigator?.onLine)) return;
      if (!alternate) {
        // Nothing to switch to yet: keep watching for a late row, and end the
        // start at STARTUP_GIVE_UP_MS (bytes still flowing or not).
        if (!giveUpRef) return;
        if (now - startedAt < STARTUP_GIVE_UP_MS) { timer = setTimeout(check, SWITCH_TICK_MS); return; }
        usedRef.current = true;
        giveUpRef.current?.('startup give-up');
        return;
      }
      usedRef.current = true;
      recoverBySwitchingRef.current?.('startup timeout');
    };
    timer = setTimeout(check, STARTUP_SWITCH_MS);
    return () => { clearTimeout(timer); v0?.removeEventListener('progress', onProgress); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, restartKey]);
}
