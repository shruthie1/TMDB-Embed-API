'use client';
import { isTvDevice } from './player/hlsConfig';
import { backAction, exitApp, isTyping, isVidaa } from './tvKeys';

// TV remote navigation.
//
// The browser's default focus order is DOM order, which is wrong for a grid of
// rails: pressing Down from a card should land on the card BELOW it, not on the
// next card in the same row. So we resolve direction geometrically, and
// remember which card each rail was last on (focus memory) — returning to a row
// should put you back where you were, not at its start.

const FOCUSABLE = '[data-focus]';

/**
 * Is this element actually on screen and usable?
 *
 * `offsetParent !== null` alone is not enough. The player's control bar hides
 * itself with `opacity:0; pointer-events:none` and stays in the layout, so a
 * D-pad press moved focus onto buttons the viewer could not see - on a TV,
 * invisible focus is indistinguishable from a dead remote.
 */
function reachable(el) {
  if (el.offsetParent === null) return false;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
  // A faded-out ancestor makes this unusable even though the element itself
  // reports opacity 1.
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (Number(s.opacity) === 0 || s.visibility === 'hidden') return false;
  }
  return true;
}

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
}

/** Nearest element in `dir`, biased so straight-ahead beats diagonal. */
function nearest(from, dir, candidates) {
  const a = rectOf(from);
  let best = null, bestScore = Infinity;
  for (const el of candidates) {
    if (el === from) continue;
    const b = rectOf(el);
    const dx = b.x - a.x, dy = b.y - a.y;
    const forward =
      dir === 'right' ? dx > 8 : dir === 'left' ? dx < -8 :
      dir === 'down' ? dy > 8 : dy < -8;
    if (!forward) continue;
    // Along-axis distance dominates; cross-axis drift is penalised heavily so
    // Down doesn't jump diagonally across the screen.
    const along = Math.abs(dir === 'left' || dir === 'right' ? dx : dy);
    const cross = Math.abs(dir === 'left' || dir === 'right' ? dy : dx);
    const score = along + cross * 3;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

export function initDpad() {
  if (typeof window === 'undefined' || window.__chitramDpad) return () => {};
  window.__chitramDpad = true;

  // Group element -> last focused child, so returning restores position.
  // Keyed on any focus GROUP, not just rails: the top bar and the filter panel
  // are groups too, and remembering only rails meant leaving the header lost
  // your place entirely.
  const memory = new WeakMap();
  const groupOf = (el) => el?.closest('[data-rail], [data-focus-group]') || null;

  const onKey = (e) => {
    const dir =
      e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowLeft' ? 'left' :
      e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : null;
    if (!dir) return;

    const active = document.activeElement;
    // SELECT too: arrows change the selected option, and stealing them means
    // the sort control cannot be changed from a remote at all. Shortcuts.jsx
    // already exempted SELECT; these two disagreed.
    if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
                   || active.isContentEditable)) return;

    /**
     * A focused SLIDER owns left/right - that is what a slider is for.
     *
     * Same idea as the SELECT exemption above: the seek bar is role=slider and
     * handles ArrowLeft/ArrowRight itself (onScrubKey in PlayerControls), so
     * walking focus away from it would make the bar unusable from a remote -
     * which is the whole reason it is a D-pad stop. Up/down still fall through
     * to navigation, so the bar is never a trap: the viewer leaves it the way
     * they arrived.
     */
    if ((dir === 'left' || dir === 'right')
        && active?.getAttribute?.('role') === 'slider') return;

    /**
     * LEFT/RIGHT belong to the player on anything that is not a TV.
     *
     * initDpad() runs on every device, not only on TVs, so with the player open
     * this handler scoped to it (a role=dialog aria-modal) and walked focus
     * along the control row. The reported symptom was exactly that - "arrows
     * are changing button focus": the seek keys moved between buttons instead
     * of scrubbing, and Player.jsx never got to act, because its own handler
     * stands down while focus sits on a control.
     *
     * A remote genuinely needs left/right to cross that row, so this applies
     * only off-TV, where Tab is the natural way between controls and left/right
     * are far more useful as seek. Up/down still navigate everywhere, so
     * nothing becomes unreachable.
     */
    if ((dir === 'left' || dir === 'right') && !isTv()
        && document.querySelector('[role="dialog"][aria-modal="true"]')) return;

    /**
     * Scope to the topmost open dialog, when there is one.
     *
     * The query was document-wide, so with the player open the D-pad walked
     * into the detail page behind it - measured on a Fire TV user agent: the
     * TV source buttons were never reached in 30 presses because focus was
     * moving through a page nobody could see. A modal must contain focus.
     */
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .filter(reachable);
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const all = [...scope.querySelectorAll(FOCUSABLE)].filter(reachable);
    if (all.length === 0) return;

    if (!active || !active.matches?.(FOCUSABLE)) {
      all[0].focus();
      e.preventDefault();
      return;
    }

    let next = null;
    const group = groupOf(active);

    // Moving vertically: prefer the remembered element in the target group.
    if (dir === 'down' || dir === 'up') {
      const groups = [...scope.querySelectorAll('[data-rail], [data-focus-group]')]
        .filter(reachable);
      const idx = groups.indexOf(group);
      const target = idx >= 0 ? groups[dir === 'down' ? idx + 1 : idx - 1] : null;
      if (target) {
        const remembered = memory.get(target);
        next = (remembered && target.contains(remembered) && reachable(remembered))
          ? remembered
          : nearest(active, dir, [...target.querySelectorAll(FOCUSABLE)]);
      }
    }
    if (!next) next = nearest(active, dir, all);

    if (next) {
      // Remember where we were BEFORE moving, so coming back restores it.
      if (group) memory.set(group, active);
      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      e.preventDefault();
    }
  };

  /**
   * TV Back (Backspace) outside the player.
   *
   * Remotes send Back as Backspace, and nothing outside the player listened
   * for it: overlays only close on Escape, and pages had no Back at all. So
   * on a TV, Backspace closes an open overlay by sending it an Escape, and
   * otherwise goes back one page. On the VIDAA home page it closes the app.
   */
  const onBack = (e) => {
    if (e.defaultPrevented) return;
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .filter(reachable);
    const action = backAction({
      key: e.key, keyCode: e.keyCode, tv: isTv(),
      typing: isTyping(document.activeElement),
      playerOpen: !!document.querySelector('.player'),
      dialogOpen: dialogs.length > 0,
      pathname: window.location.pathname,
      vidaa: isVidaa(navigator.userAgent),
    });
    if (!action) return;
    e.preventDefault();
    if (action === 'escape') {
      // Sent from the topmost dialog so it bubbles to the window listeners
      // that Filters, Shortcuts and PrefsPicker already have for Escape.
      dialogs[dialogs.length - 1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    } else if (action === 'exit') {
      exitApp();
    } else if (window.history.length > 1) {
      window.history.back();
    } else {
      // Opened straight onto a deep link: there is no page to go back to.
      window.location.assign('/');
    }
  };

  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onBack);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onBack);
    window.__chitramDpad = false;
  };
}

/**
 * True when the app is running on a TV — enables 10-foot sizing.
 *
 * ONE owner: this delegates to isTvDevice, which also chooses the player's
 * buffer profile. Two independent sniffs disagreed - this one missed Android TV
 * and Chromecast entirely (they report a plain mobile UA), so the whole
 * [data-tv] type scale silently did not apply on those boxes while the player
 * still trimmed its buffers.
 *
 * A manual override wins over any sniff, because UA detection cannot be made
 * reliable: add ?tv=1 (or ?tv=0) once and it is remembered.
 */
// How long a manual ?tv= / ?native= override is remembered.
const OVERRIDE_MS = 24 * 60 * 60 * 1000;

export function isTv() {
  return readOverride('chitram.tv', 'tv', isTvDevice);
}

/**
 * A remembered ?tv= / ?native= override, or the sniff when there is none.
 *
 * The override EXPIRES. It used to be stored as a bare '1' that won forever,
 * which is right on the device it was set on and wrong everywhere else: one
 * `?tv=1` test url pinned a laptop into the 10-foot layout on every later
 * visit, with no way back except `?tv=0` or clearing site data. A day is long
 * enough to finish testing on a real TV - where the sniff usually gets it
 * right anyway - and short enough that a dev machine returns to normal by
 * itself.
 *
 * Exported so both overrides share one implementation; they drifted apart
 * before, and only one of them was documented.
 */
export function readOverride(key, param, sniff) {
  if (typeof navigator === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search).get(param);
    if (q === '1' || q === '0') {
      localStorage.setItem(key, JSON.stringify({ v: q, until: Date.now() + OVERRIDE_MS }));
      return q === '1';
    }
    const raw = localStorage.getItem(key);
    if (raw) {
      // A legacy bare '1'/'0' has no expiry. Honour it for this read and let
      // it lapse, rather than stranding anyone who set one before this change.
      if (raw === '1' || raw === '0') { localStorage.removeItem(key); return raw === '1'; }
      const { v, until } = JSON.parse(raw);
      if (Number.isFinite(until) && until > Date.now()) return v === '1';
      localStorage.removeItem(key);
    }
  } catch { /* private mode, bad json, or no window: fall through to the sniff */ }
  return sniff();
}
