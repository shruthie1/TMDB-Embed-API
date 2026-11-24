'use client';
import { forwardRef } from 'react';
import Icon from './Icon';

/** Shimmer placeholder. Always sized like the content it replaces (no CLS). */
export function Skeleton({ variant = 'box', width, height, className = '', style = {} }) {
  const cls = variant === 'text' ? 'skel skel-text' : variant === 'poster' ? 'skel skel-poster' : 'skel';
  return <div className={`${cls} ${className}`} style={{ width, height, ...style }} aria-hidden="true" />;
}

/** Filter pill. Toggles; D-pad focusable. */
export function Chip({ children, active = false, onClick, onRemove, ...rest }) {
  return (
    <button
      type="button"
      className={`chip focusable ${active ? 'on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
      data-focus=""
      {...rest}
    >
      {children}
      {onRemove && (
        <span
          className="chip-x"
          role="button"
          tabIndex={-1}
          aria-label="Remove filter"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          <Icon name="close" size={11} />
        </span>
      )}
    </button>
  );
}

/** Static label: quality, language, certification. Never interactive. */
export function Badge({ children, className = '' }) {
  return <span className={`badge ${className}`}>{children}</span>;
}

export const Button = forwardRef(function Button({ children, icon, variant = 'default', className = '', ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={`btn ${variant} focusable ${className}`} data-focus="" {...rest}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
});

export function IconButton({ icon, label, size = 18, className = '', ...rest }) {
  return (
    <button type="button" className={`icon-btn focusable ${className}`} aria-label={label} data-focus="" {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/** Nothing here — say why, and offer the way forward. */
export function EmptyState({ icon = 'bookmark', title, hint, action }) {
  return (
    <div className="state">
      <Icon name={icon} size={26} className="state-ico" />
      <p className="state-title">{title}</p>
      {hint && <p className="state-hint">{hint}</p>}
      {action}
    </div>
  );
}

/** Something broke — what, and what to do about it. */
export function ErrorState({ title = 'Something went wrong', hint, onRetry }) {
  return (
    <div className="state">
      <Icon name="close" size={26} className="state-ico" />
      <p className="state-title">{title}</p>
      {hint && <p className="state-hint">{hint}</p>}
      {onRetry && <Button variant="primary" onClick={onRetry} icon="restart">Try again</Button>}
    </div>
  );
}

/** Transient confirmation. Announced politely for screen readers. */
export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast" role="status" aria-live="polite">{message}</div>;
}
