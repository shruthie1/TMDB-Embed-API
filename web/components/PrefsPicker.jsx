'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { PREF_LANGS, getPrefs, hasPrefs, savePrefs } from '../lib/prefs';
import { isTv } from '../lib/dpad';

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Preferred languages, as a small centred dialog. Tap order is still saved
 * as rank order (rows follow it), but the UI no longer shows numbers.
 *
 * First visit: Telugu is pre-selected, it opens after the home page has painted,
 * and it is sticky (no outside-tap or Escape dismiss). Save needs at least one
 * language; Skip stores an empty choice, which means all languages.
 */
export function PrefsModal({ open, onClose, firstVisit = false }) {
  const [langs, setLangs] = useState([]);
  const cardRef = useRef(null);
  // TV first visit: focus Save once it is enabled, so one OK accepts Telugu.
  const saveFirst = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    // First visit opens with Telugu already chosen and ready to save - Telugu
    // is the library's standing default, so a first-time viewer lands on it
    // without hunting. They can still add or clear languages before saving.
    setLangs(firstVisit ? ['te'] : getPrefs().langs);
    const card = cardRef.current;
    const returnTo = document.activeElement;
    // Focus the dialog itself, so no tile looks different on open. A TV has no
    // pointer: there the first tile takes focus and shows the ring. On a TV
    // first visit Save takes it instead (effect below), as Telugu is chosen.
    if (isTv() && firstVisit) saveFirst.current = true;
    else if (isTv()) card?.querySelector('.lang-opt')?.focus();
    else card?.focus();
    // Keep Tab inside the dialog; arrows are scoped by lib/dpad.js.
    const onKey = (e) => {
      if (e.key === 'Escape' && !firstVisit) { e.stopPropagation(); onClose(); return; }
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
      saveFirst.current = false;
      if (returnTo instanceof HTMLElement) returnTo.focus({ focusVisible: viaKeys || isTv() });
    };
  }, [open, firstVisit, onClose]);

  // Save is disabled on the open render (langs not yet set), so wait for it.
  useEffect(() => {
    if (!open || !saveFirst.current) return;
    const save = cardRef.current?.querySelector('.lang-modal-actions .btn.primary');
    if (save && !save.disabled) { saveFirst.current = false; save.focus(); }
  }, [open, langs]);

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
          {!firstVisit && (
            <button type="button" className="icon-btn lang-close focusable" data-focus=""
                    aria-label="Close" onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          )}
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
                  onClick={() => done({ langs: [] })}>Skip</button>
        </div>
      </div>
    </div>
  );
}

/** Header button plus the dialog; opens once on a first visit, after load. */
export default function PrefsButton({ className = 'nav-link nav-search', iconSize = 15, firstVisit = true }) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Two buttons exist (desktop top bar, TV/phone AppNav); only one may
    // open the first-visit picker, or it would open twice.
    if (!firstVisit || hasPrefs()) return undefined;
    // After the page has loaded and painted, so the home page is visible
    // behind the dimmed backdrop rather than replaced by it.
    let t;
    const show = () => { t = setTimeout(() => { setFirst(true); setOpen(true); }, 700); };
    if (document.readyState === 'complete') show();
    else window.addEventListener('load', show, { once: true });
    return () => { clearTimeout(t); window.removeEventListener('load', show); };
  }, [firstVisit]);

  return (
    <>
      <button type="button" className={`${className} focusable`} data-focus=""
              aria-label="Your languages" onClick={() => { setFirst(false); setOpen(true); }}>
        <Icon name="settings" size={iconSize} />
        <span className="app-nav-label">Languages</span>
      </button>
      {/* Portalled to <body>: inside the sticky header it shared the
          header's stacking context (z-index 20), so on a phone the bottom
          tab bar (z-index 30) covered the buttons. */}
      {mounted && createPortal(
        <PrefsModal open={open} firstVisit={first}
                    onClose={() => { setOpen(false); setFirst(false); }} />,
        document.body)}
    </>
  );
}
