import { useCallback, useMemo, useRef } from 'react';

/**
 * A server pick whose signed url has expired gets ONE fresh url before the
 * switch guard gives up on it.
 *
 * The rows in the Servers menu carry the urls from the first resolve, and
 * nothing renews them while the page stays open. OneTouchTV signs its master
 * for one hour (`hdnts=exp=` sits 60 min after the resolve; CastleTV's sits
 * 180 min out). Measured 2026-11-16 on movie/690957: an expired OneTouchTV
 * master answers /m3u8-proxy with 403, hls.js raises a fatal error 0.7s after
 * the click, and the switch guard put the old server back. On a phone left
 * open for over an hour the pick therefore never stuck: the tick snapped back
 * before anyone saw it move, and the row could not be played again without a
 * reload, because nothing ever asked the backend for a new url.
 *
 * Now a 403/410 on a viewer's own pick asks that provider again (refresh=1)
 * and plays the matching fresh row. Only when that also fails does the guard
 * revert and say so.
 */

const norm = (l) => (Array.isArray(l) ? l : []).map((x) => String(x).toLowerCase()).sort().join(',');

/** The fresh row that stands for `target`: same provider, closest shape. */
export function freshRowFor(target, found = []) {
  if (!target) return null;
  const same = (found || []).filter((s) => s?.masterUrl && s.provider === target.provider);
  if (!same.length) return null;
  const q = target.quality || '';
  const langs = norm(target.languages);
  return same.find((s) => (s.quality || '') === q && norm(s.languages) === langs)
    || same.find((s) => (s.quality || '') === q)
    || same.find((s) => norm(s.languages) === langs)
    || same[0];
}

/**
 * `fetchRows(target)`  resolves to the provider's fresh rows (or null).
 * `apply(target, fresh)` plays the fresh url under the target's id.
 * `giveUp()`           what happens without a fresh url (the guard reverts).
 * `currentId()`        the id playing now; a late answer for a row the viewer
 *                      already left is dropped.
 */
export function useStaleRefresh({ fetchRows, apply, giveUp, currentId }) {
  const tried = useRef(new Set());
  const cb = useRef({ fetchRows, apply, giveUp, currentId });
  cb.current = { fetchRows, apply, giveUp, currentId };

  // True when a refresh started, so the caller skips its own handling.
  const tryRefresh = useCallback((target) => {
    if (!target?.masterUrl || target.hybrid || target.id == null) return false;
    if (String(target.id).startsWith('pair-')) return false;
    if (tried.current.has(target.id)) return false;   // once per row, then revert
    tried.current.add(target.id);
    const still = () => cb.current.currentId?.() === target.id;
    Promise.resolve()
      .then(() => cb.current.fetchRows(target))
      .then((found) => {
        if (!still()) return;
        const fresh = freshRowFor(target, found || []);
        if (fresh) cb.current.apply(target, fresh);
        else cb.current.giveUp();
      })
      .catch(() => { if (still()) cb.current.giveUp(); });
    return true;
  }, []);

  // A pick that played: the next expiry of that row may be refreshed again.
  const reset = useCallback(() => { tried.current.clear(); }, []);

  return useMemo(() => ({ tryRefresh, reset }), [tryRefresh, reset]);
}

export default useStaleRefresh;
