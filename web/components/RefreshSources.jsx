'use client';
import { useEffect, useRef } from 'react';
import Icon from './Icon';

/**
 * The "Refresh sources" control (lib/player/refreshModel.js), drawn from
 * useRefreshSources. Never a dead control: during the cooldown it stays
 * focusable (aria-disabled, not disabled) and a press says when the next
 * refresh may run. The result line sits in a polite live region; the spinner
 * stops under reduced motion (globals.css).
 *
 * `focusOnTv`: the failure card starts TV focus here.
 * `iconOnly`: the details page's round icon button beside My List. The name
 * stays "Refresh sources"; the state shows as the spinner, aria-busy and the
 * note beside it.
 */
export default function RefreshSources({ r, className = 'btn', primary = false, focusOnTv = false, iconOnly = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (focusOnTv && typeof document !== 'undefined' && document.documentElement.dataset.tv === 'true') ref.current?.focus();
  }, [focusOnTv]);
  if (!r) return null;
  const waiting = r.state !== 'idle';
  return (
    <span className={`refresh-src${iconOnly ? ' refresh-src-icon' : ''}`}>
      <button ref={ref} type="button"
              className={`${className}${primary ? ' primary' : ''} focusable refresh-btn${iconOnly ? ' refresh-icon' : ''}`} data-focus=""
              data-state={r.state} aria-busy={r.running || undefined} aria-disabled={waiting ? 'true' : undefined}
              aria-label={iconOnly ? 'Refresh sources' : undefined} title={iconOnly ? 'Refresh sources' : undefined}
              onClick={r.refresh}>
        {r.running ? <span className="refresh-spin" aria-hidden="true" /> : <Icon name={iconOnly ? 'refresh' : 'restart'} size={iconOnly ? 16 : 14} />}
        {!iconOnly && <span>{r.label}</span>}
      </button>
      <span className="refresh-note" role="status" aria-live="polite" aria-atomic="true">{r.note || ''}</span>
    </span>
  );
}
