'use client';
import Icon from '../Icon';

/** Shared surface only: each caller keeps its existing trigger and actions. */
export default function PlayerMenu({ title, icon, onClose, onTouch, children }) {
  const close = (event) => {
    event.stopPropagation();
    // The opener remains mounted, including the settings sheet's drill-in row.
    const trigger = event.currentTarget.closest('.pmenu-wrap')
      ?.querySelector(':scope > button');
    onClose?.();
    trigger?.focus({ preventScroll: true });
  };
  return (
    <div className="pmenu pmenu-pick pmenu-unified" role="menu" aria-label={title}
         data-focus-group=""
         onClick={(event) => { event.stopPropagation(); onTouch?.(); }}
         onPointerDown={onTouch} onScroll={onTouch} onWheel={onTouch}
         onKeyDown={(event) => {
           if (event.key === 'Escape') { event.preventDefault(); close(event); }
           else onTouch?.();
         }}>
      <div className="pmenu-sheet-head pmenu-picker-head">
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
