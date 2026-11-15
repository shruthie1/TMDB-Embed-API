'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { PREF_LANGS, getPrefs, hasPrefs, savePrefs } from '../lib/prefs';

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Preferred languages, as a small centred dialog. Tap order is still saved
 * as rank order (rows follow it), but the UI no longer shows numbers.
 *
 * First visit: nothing is selected, it opens after the home page has painted,
 * and it is sticky (no outside-tap or Escape dismiss). Save needs at least one
 * language; Skip stores an empty choice, which means all languages.
 */
export function PrefsModal({ open, onClose, firstVisit = false }) {
  const [langs, setLangs] = useState([]);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setLangs(firstVisit ? [] : getPrefs().langs);
    const card = cardRef.current;
    const returnTo = document.activeElement;
    // First language, not the close button, so the dialog opens on a choice.
    (card?.querySelector('.lang-opt') || card?.querySelector(FOCUSABLE))?.focus();
    // Keep Tab inside the dialog; arrows are scoped by lib/dpad.js.
    const onKey = (e) => {
      if (e.key === 'Escape' && !firstVisit) { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !card) return;
      const items = [...card.querySelectorAll(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [open, firstVisit, onClose]);

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
      <div ref={cardRef} className="lang-modal" role="dialog" aria-modal="true"
           aria-labelledby="lang-modal-title" aria-describedby="lang-modal-hint">
        <div className="lang-modal-head">
          <h2 id="lang-modal-title" className="lang-modal-title">Your languages</h2>
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
        <p className="lang-modal-need" aria-live="polite">
          {langs.length ? `${langs.length} selected` : 'Pick at least one language'}
        </p>
        <div className="lang-modal-actions">
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
export default function PrefsButton() {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (hasPrefs()) return undefined;
    // After the page has loaded and painted, so the home page is visible
    // behind the dimmed backdrop rather than replaced by it.
    let t;
    const show = () => { t = setTimeout(() => { setFirst(true); setOpen(true); }, 700); };
    if (document.readyState === 'complete') show();
    else window.addEventListener('load', show, { once: true });
    return () => { clearTimeout(t); window.removeEventListener('load', show); };
  }, []);

  return (
    <>
      <button type="button" className="nav-link nav-search focusable" data-focus=""
              aria-label="Your languages" onClick={() => { setFirst(false); setOpen(true); }}>
        <Icon name="settings" size={15} />
        <span>Languages</span>
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
