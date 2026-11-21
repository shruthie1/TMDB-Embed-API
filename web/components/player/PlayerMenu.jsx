'use client';
import { useEffect, useRef } from 'react';
import Icon from '../Icon';
import { SheetScrim, useAnchoredSheet } from './popover';

/** Shared surface only: each caller keeps its existing trigger and actions. */
export default function PlayerMenu({ title, icon, onClose, onBack, focusLabel, onTouch, children }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const root = menuRef.current;
    const named = [...(root?.querySelectorAll('[role="menuitemradio"]') || [])].find(row => row.querySelector('.pmenu-text')?.textContent === focusLabel);
    const target = named || root?.querySelector('[role="menuitemradio"][aria-checked="true"]') || root?.querySelector('[role="menuitemradio"]');
    target?.focus({ preventScroll: true });
    // APK: open with the selected row in view, once per level. preventScroll
    // above keeps the page still; only the list body moves.
    const body = root?.querySelector('.pmenu-picker-body');
    if (body && target && target !== body.querySelector('[role="menuitemradio"]')) {
      const off = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
      if (off < 0 || off + target.offsetHeight > body.clientHeight) body.scrollTop += off;
    }
  }, [title, focusLabel]);
  // Above the opener in landscape (APK 1.2.15); re-placed per level.
  useAnchoredSheet(menuRef, [title]);
  const close = (event) => {
    event.stopPropagation();
    // The opener remains mounted, including the settings sheet's drill-in row.
    const trigger = event.currentTarget.closest('.pmenu-wrap')
      ?.querySelector(':scope > button');
    onClose?.();
    trigger?.focus({ preventScroll: true });
  };
  return (
    <>
    <SheetScrim onClose={onClose} />
    <div ref={menuRef} className="pmenu pmenu-pick pmenu-unified" role="menu" aria-label={title}
         data-focus-group=""
         onClick={(event) => { event.stopPropagation(); onTouch?.(); }}
         onPointerDown={onTouch} onScroll={onTouch} onWheel={onTouch}
         onKeyDown={(event) => {
           if (event.key === 'Escape') { event.preventDefault(); if (onBack) { event.stopPropagation(); onBack(); } else close(event); }
           else onTouch?.();
         }}>
      <div className="pmenu-sheet-head pmenu-picker-head">
        {onBack && <button type="button" className="icon-btn focusable" data-focus="" aria-label="Back to servers" onClick={onBack}><Icon name="back" size={18} /></button>}
        <span className="pmenu-heading"><Icon name={icon} size={18} />{title}</span>
        <button type="button" className="icon-btn focusable" data-focus=""
                aria-label={`Close ${title.toLowerCase()}`} onClick={close}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="pmenu-picker-body">{children}</div>
    </div>
    </>
  );
}
