'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { PREF_LANGS, getPrefs, effectiveLangs, savePrefs } from '../lib/prefs';
import { isTv } from '../lib/dpad';

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Preferred languages, as a small centred dialog. Tap order is still saved
 * as rank order (rows follow it), but the UI no longer shows numbers.
 *
 * It never opens by itself (owner, 2026-11-22): a first visit uses every
 * language, Telugu first, and the viewer changes that only from the
 * Languages button. Nothing saved, or an old empty Skip choice, opens with
 * every language selected, since that is what the rows already use.
 * Save needs at least one language; Cancel keeps the current choice.
 */
export function PrefsModal({ open, onClose }) {
  const [langs, setLangs] = useState([]);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setLangs(effectiveLangs(getPrefs()));
    const card = cardRef.current;
    const returnTo = document.activeElement;
    // Focus the dialog itself, so no tile looks different on open. A TV has no
    // pointer: there the first tile takes focus and shows the ring.
    if (isTv()) card?.querySelector('.lang-opt')?.focus();
    else card?.focus();
    // Keep Tab inside the dialog; arrows are scoped by lib/dpad.js.
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !card) return;
      const items = [...card.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    // Focus goes back to the trigger on close, showing the ring only if the
    // dialog was being used from the keyboard: after a click or tap the ring
    // would be a stray box on a button nobody is pointing at.
    let viaKeys = false;
    const onPointer = () => { viaKeys = false; };
    const onAnyKey = (e) => { if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') viaKeys = true; };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onAnyKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onAnyKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      if (returnTo instanceof HTMLElement) returnTo.focus({ focusVisible: viaKeys || isTv() });
    };
  }, [open, onClose]);

  if (!open) return null;

  // Functional update: two quick taps must not read the same stale list.
  const toggle = (code) =>
    setLangs(list => (list.includes(code) ? list.filter(x => x !== code) : [...list, code]));
  const done = (next) => { savePrefs(next); onClose(); };

  return (
    // No onClick on the backdrop: an outside tap must not dismiss the choice.
    <div className="lang-modal-backdrop">
      {/* role=dialog on an in-flow element: lib/dpad.js scopes arrow keys to
          an open dialog only when it has an offsetParent. */}
      <div ref={cardRef} className="lang-modal" role="dialog" aria-modal="true" tabIndex={-1}
           aria-labelledby="lang-modal-title" aria-describedby="lang-modal-hint">
        <div className="lang-modal-head">
          <h2 id="lang-modal-title" className="lang-modal-title">Your languages</h2>
          <span className="lang-modal-count" aria-live="polite">
            {langs.length ? `${langs.length} selected` : ''}
          </span>
          <button type="button" className="icon-btn lang-close focusable" data-focus=""
                  aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <p id="lang-modal-hint" className="lang-modal-hint">
          Pick the languages you watch.
        </p>
        <div className="lang-options" data-focus-group="">
          {PREF_LANGS.map(l => {
            const on = langs.includes(l.code);
            return (
              <button key={l.code} type="button" data-focus=""
                      className={`lang-opt focusable lang-focus${on ? ' on' : ''}`}
                      aria-pressed={on} onClick={() => toggle(l.code)}>
                <span className="lang-opt-label">{l.label}</span>
                <span className="lang-opt-mark" aria-hidden="true">
                  {on ? <Icon name="check" size={14} /> : null}
                </span>
              </button>
            );
          })}
        </div>
        <div className="lang-modal-actions">
          {!langs.length && <p className="lang-modal-need">Pick at least one language</p>}
          <button type="button" data-focus="" className="btn primary focusable lang-focus"
                  disabled={!langs.length} onClick={() => done({ langs })}>Save</button>
          <button type="button" data-focus="" className="btn focusable lang-focus"
                  onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** Header button plus the dialog. The dialog opens only from this button. */
export default function PrefsButton({ className = 'nav-link nav-search', iconSize = 15 }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => { setMounted(true); }, []);

  return (
    <>
      <button type="button" className={`${className} focusable`} data-focus=""
              aria-label="Your languages" onClick={() => setOpen(true)}>
        <Icon name="settings" size={iconSize} />
        <span className="app-nav-label">Languages</span>
      </button>
      {/* Portalled to <body>: inside the sticky header it shared the
          header's stacking context (z-index 20), so on a phone the bottom
          tab bar (z-index 30) covered the buttons. */}
      {mounted && createPortal(
        <PrefsModal open={open} onClose={close} />,
        document.body)}
    </>
  );
}
