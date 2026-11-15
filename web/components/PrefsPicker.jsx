'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chip, Button } from './ui';
import Icon from './Icon';
import { PREF_LANGS, DEFAULT_PREFS, getPrefs, hasPrefs, savePrefs }
  from '../lib/prefs';

/**
 * Preferred languages as a modal; tap order is rank order.
 *
 * Opens by itself once, on a first visit with no stored choice. It is sticky:
 * a tap outside or Escape does not dismiss it, so the first choice is always
 * made on purpose (Save or Use defaults). The header button reopens it.
 */
export function PrefsModal({ open, onClose, firstVisit = false }) {
  const [langs, setLangs] = useState(DEFAULT_PREFS.langs);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setLangs(getPrefs().langs);
    panelRef.current?.querySelector('[data-focus]')?.focus();
  }, [open]);

  // Functional update: two quick taps must not read the same stale list.
  const toggle = (set, v) =>
    set(list => (list.includes(v) ? list.filter(x => x !== v) : [...list, v]));
  const done = (next) => { savePrefs(next); onClose(); };

  return (
    <>
      {/* No onClick: an outside tap must not dismiss the choice by accident. */}
      <div className={`sheet-scrim ${open ? 'on' : ''}`} aria-hidden={!open} />
      <aside ref={panelRef} className={`fpanel ${open ? 'open' : ''}`} aria-hidden={!open}>
        {/* role=dialog sits on an inner element: lib/dpad.js scopes arrow
            keys to the open dialog only if it has an offsetParent, which a
            position:fixed element never has. On the aside itself, the D-pad
            walked out of the pop-up into the rows behind it. */}
        <div role="dialog" aria-label="Your languages" aria-modal={open ? 'true' : undefined}
             style={{ display: 'flex', flexDirection: 'column', flex: '1 0 auto' }}>
        <div className="fpanel-grab" />
        <div className="fpanel-head">
          <h2 className="row-label">Your languages</h2>
          {!firstVisit && (
            <button className="icon-btn focusable" data-focus="" aria-label="Close"
                    onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
        <div className="fgroup">
          <p className="flabel">First tapped ranks first</p>
          <div className="chips">
            {PREF_LANGS.map(l => (
              <Chip key={l.code} active={langs.includes(l.code)}
                    onClick={() => toggle(setLangs, l.code)}>
                {langs.includes(l.code) ? `${langs.indexOf(l.code) + 1}. ` : ''}{l.label}
              </Chip>
            ))}
          </div>
        </div>
        <div className="fpanel-foot chips">
          <Button variant="primary" onClick={() => done({ langs })}>Save</Button>
          <Button onClick={() => done(DEFAULT_PREFS)}>Use defaults</Button>
        </div>
        </div>
      </aside>
    </>
  );
}

/** Header button plus the modal; auto-opens once on a first visit. */
export default function PrefsButton() {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (!hasPrefs()) { setFirst(true); setOpen(true); }
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
          tab bar (z-index 30) covered the Save button. */}
      {mounted && createPortal(
        <PrefsModal open={open} firstVisit={first}
                    onClose={() => { setOpen(false); setFirst(false); }} />,
        document.body)}
    </>
  );
}
