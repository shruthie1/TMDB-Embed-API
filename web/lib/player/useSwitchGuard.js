import { useCallback, useMemo, useRef } from 'react';

/**
 * A viewer's server pick either lands or goes back to what was playing.
 *
 * Before this, a pick that failed (a 403 on the new master, a manifest that
 * never loaded, a provider that never produced a frame) went to the generic
 * paths: onFatal's 403 branch jumped to whichever source came FIRST in the
 * list, and the others raised the full-screen error. Either way the viewer
 * lost the server they were watching, and the menu's tick no longer matched
 * anything they had chosen.
 *
 * Usage, from Player.jsx:
 *   begin(prev, label)  just before a MANUAL switch. `prev` is a playable
 *                       snapshot of what is on screen now ({ id, provider,
 *                       masterUrl, ... , at: seconds }).
 *   landed()            the new stream decoded its first frame.
 *   fail()              any failure signal. Returns true when it reverted, so
 *                       the caller skips its generic handling.
 *
 * `revert(prev)` re-plays the snapshot; `onRevert(message)` shows the short
 * inline notice. Both are read through a ref so the returned callbacks stay
 * stable and can be listed in dependency arrays without re-runs.
 */
export function useSwitchGuard({ revert, onRevert }) {
  const pending = useRef(null);
  const cb = useRef({ revert, onRevert });
  cb.current = { revert, onRevert };

  const begin = useCallback((prev, label) => {
    // Nothing playable to go back to (first load): nothing to guard.
    pending.current = prev?.masterUrl ? { prev, label: label || 'That server' } : null;
  }, []);

  const landed = useCallback(() => { pending.current = null; }, []);

  const fail = useCallback(() => {
    const p = pending.current;
    if (!p) return false;
    pending.current = null;
    cb.current.revert?.(p.prev);
    const back = p.prev.label || p.prev.provider || 'the previous server';
    cb.current.onRevert?.(`${p.label} did not load. Back on ${back}.`);
    return true;
  }, []);

  const isPending = useCallback(() => pending.current != null, []);

  // One stable object, so callers can list it as a dependency.
  return useMemo(() => ({ begin, landed, fail, isPending }), [begin, landed, fail, isPending]);
}

export default useSwitchGuard;
