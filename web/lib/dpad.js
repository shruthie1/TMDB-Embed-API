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
  const cs = getComputedStyle(el);
  // offsetParent is ALSO null for a position:fixed element, which the player
  // is. Treating that as hidden dropped the player out of the dialog scope, so
  // the D-pad walked the title page behind the film.
  if (el.offsetParent === null && cs.position !== 'fixed') return false;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
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

// A poster in a rail or a results grid.
const CARD = '[data-rail] [data-focus], .grid-titles [data-focus]';

const onScreenOf = (els) => els.filter((el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
});
const firstOnScreen = (els) => onScreenOf(els)[0] || els[0] || null;

/**
 * The card in the next row up or down that sits under `from`: the row is the
 * nearest band of cards in that direction, and within it the card with the
 * most horizontal overlap wins (then the nearest centre). Returns null when
 * something other than a card sits between the two rows (an episode list, a
 * button): plain geometry handles that.
 */
export function cardBelow(from, dir, candidates) {
  const a = from.getBoundingClientRect();
  const down = dir === 'down';
  const cards = [], others = [];
  for (const el of candidates) {
    if (el === from) continue;
    const r = el.getBoundingClientRect();
    const ahead = down ? r.top >= a.bottom - 4 : r.bottom <= a.top + 4;
    if (!ahead) continue;
    (el.matches(CARD) ? cards : el.matches('.see-all') ? [] : others).push({ el, r });
  }
  if (cards.length === 0) return null;
  const edge = down ? Math.min(...cards.map((c) => c.r.top)) : Math.max(...cards.map((c) => c.r.bottom));
  const half = a.height / 2;
  const row = cards.filter((c) => (down ? c.r.top < edge + half : c.r.bottom > edge - half));
  // Something that is not a card lies before that row: let geometry decide.
  const centreY = (r) => r.top + r.height / 2;
  if (others.some((o) => (down ? centreY(o.r) < edge : centreY(o.r) > edge))) return null;
  const cx = a.left + a.width / 2;
  let best = null, bestOverlap = -1, bestDx = Infinity;
  for (const c of row) {
    const overlap = Math.max(0, Math.min(a.right, c.r.right) - Math.max(a.left, c.r.left));
    const dx = Math.abs(c.r.left + c.r.width / 2 - cx);
    if (overlap > bestOverlap || (overlap === bestOverlap && dx < bestDx)) {
      best = c.el; bestOverlap = overlap; bestDx = dx;
    }
  }
  return best;
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
    // Left/Right stay on the same line: the target must share some of the
    // source's height. Without this, Right from the last header link jumped
    // to a poster half a screen down that sat off-screen to the right.
    if ((dir === 'left' || dir === 'right')
        && !(b.r.top < a.r.bottom && b.r.bottom > a.r.top)) continue;
    // Along-axis distance dominates; cross-axis drift is penalised heavily so
    // Down doesn't jump diagonally across the screen.
    const horiz = dir === 'left' || dir === 'right';
    const along = Math.abs(horiz ? dx : dy);
    // Cross drift is the GAP between the two boxes on the other axis, not the
    // distance between centres: a full-width list row straight below a small
    // button is directly below it. Centre distance only breaks ties. Measured
    // centre-to-centre, Up from a size button in the settings sheet jumped
    // over the subtitle rows to the sheet's close button.
    const gap = horiz
      ? Math.max(0, b.r.top - a.r.bottom, a.r.top - b.r.bottom)
      : Math.max(0, b.r.left - a.r.right, a.r.left - b.r.right);
    const centre = Math.abs(horiz ? dy : dx);
    const score = along + gap * 3 + centre * 0.1;
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
  // The last element focused outside the TV side rail: Right from the rail
  // returns to it.
  let lastContent = null;
  const onFocusIn = (e) => {
    const t = e.target;
    if (t?.matches?.(FOCUSABLE) && !t.closest('[data-nav]')) lastContent = t;
  };
  const groupOf = (el) => el?.closest('[data-rail], [data-focus-group]') || null;

  const onKey = (e) => {
    // A handler that ran first (the player, a slider) already used this key.
    if (e.defaultPrevented) return;
    const dir =
      e.key === 'ArrowRight' ? 'right' : e.key === 'ArrowLeft' ? 'left' :
      e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : null;
    if (!dir) return;

    const active = document.activeElement;
    // SELECT too: arrows change the selected option, and stealing them means
    // the sort control cannot be changed from a remote at all. Shortcuts.jsx
    // already exempted SELECT; these two disagreed.
    // A one-line text field has no use for Up/Down, and keeping them made the
    // search box a trap on a remote: no key could leave it for the results.
    const lineField = active?.tagName === 'INPUT'
      && /^(text|search|email|url|tel|)$/.test(active.getAttribute('type') || '');
    const fieldOwnsKey = lineField ? (dir === 'left' || dir === 'right')
      : (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable));
    if (fieldOwnsKey) return;

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
    // An open menu (the player's settings sheet, a picker list) holds focus
    // until it is closed with Back or a pick. Walking out of it left the list
    // open over the film with focus somewhere behind it.
    const menu = active?.closest?.('[role="menu"]');
    const scope = menu && reachable(menu) ? menu
      : dialogs.length ? dialogs[dialogs.length - 1] : document;
    const all = [...scope.querySelectorAll(FOCUSABLE)].filter(reachable);
    if (all.length === 0) return;
    const content = all.filter((el) => !el.closest('[data-nav]'));

    if (!active || !active.matches?.(FOCUSABLE)) {
      // Nothing focused yet (a page just opened): start on the page's main
      // action when one is on screen, else the first visible control. The
      // first element in the DOM is the logo, which is never what OK means.
      const pool = content.length ? content : all;
      const onScreen = onScreenOf(pool);
      const first = onScreen.find((el) => el.matches('.btn.primary')) || onScreen[0] || pool[0];
      first.focus();
      e.preventDefault();
      return;
    }

    const group = groupOf(active);
    const nav = active.closest('[data-nav]');
    const vertical = dir === 'down' || dir === 'up';
    let next = null;

    if (nav) {
      /**
       * The TV side rail (components/Nav.jsx). Up/Down stay inside it; Right
       * goes back to exactly where the viewer was in the page.
       */
      if (vertical) next = nearest(active, dir, all.filter((el) => nav.contains(el)));
      else if (dir === 'right') {
        next = lastContent && document.contains(lastContent) && reachable(lastContent)
          ? lastContent : firstOnScreen(content);
      }
    } else {
      /**
       * Direction is decided by geometry. Down from a card goes to the card
       * directly below it in the next row (most horizontal overlap), and the
       * row's "See all" link is never picked over a card. Group memory is not
       * applied to cards: it put focus back on an old column, which read as a
       * random card. The side rail is not a vertical target from the page.
       */
      if (vertical && active.matches(CARD)) next = cardBelow(active, dir, content);
      if (!next && vertical) {
        next = nearest(active, dir, content.filter((el) => !el.matches('.see-all')))
          || nearest(active, dir, content);
      }
      if (!next && !vertical) next = nearest(active, dir, content);
      // Left from the first thing on a line opens the side rail.
      if (!next && dir === 'left') {
        const items = all.filter((el) => el.closest('[data-nav]'));
        next = items.find((el) => el.classList.contains('on')) || items[0] || null;
        if (next) lastContent = active;
      }
      // Right from the last card of a row reaches the row's "See all".
      if (!next && dir === 'right' && active.closest('[data-rail]')) {
        const more = active.closest('.row-sec')?.querySelector('.see-all[data-focus]');
        if (more && reachable(more)) next = more;
      }
      if (next && vertical && !next.matches(CARD)) {
        const target = groupOf(next);
        const remembered = target && target !== group ? memory.get(target) : null;
        if (remembered && remembered !== next && target.contains(remembered)
            && reachable(remembered)) next = remembered;
      }
    }

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
  window.addEventListener('focusin', onFocusIn);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onBack);
    window.removeEventListener('focusin', onFocusIn);
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
