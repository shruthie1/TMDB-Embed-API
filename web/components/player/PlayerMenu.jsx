'use client';
import { useEffect, useRef } from 'react';
import Icon from '../Icon';

/** Shared surface only: each caller keeps its existing trigger and actions. */
export default function PlayerMenu({ title, icon, onClose, onBack, focusLabel, onTouch, children }) {
  const menuRef = useRef(null);
  useEffect(() => {
    const root = menuRef.current;
    const named = [...(root?.querySelectorAll('[role="menuitemradio"]') || [])].find(row => row.querySelector('.pmenu-text')?.textContent === focusLabel);
    (named || root?.querySelector('[role="menuitemradio"][aria-checked="true"]') || root?.querySelector('[role="menuitemradio"]'))?.focus({ preventScroll: true });
  }, [title, focusLabel]);
  const close = (event) => {
    event.stopPropagation();
    // The opener remains mounted, including the settings sheet's drill-in row.
    const trigger = event.currentTarget.closest('.pmenu-wrap')
      ?.querySelector(':scope > button');
    onClose?.();
    trigger?.focus({ preventScroll: true });
  };
  return (
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
  );
}
