'use client';
import { useEffect } from 'react';

/** Full-page error with Retry and Home, used by app/error.jsx and app/global-error.jsx. */
export default function ErrorScreen({ error, onRetry }) {
  useEffect(() => { console.error('[page] render error:', error); }, [error]);
  return (
    <div className="overlay ov-screen boundary-screen">
      <div className="ov-card ov-card-error" role="alert">
        <span className="ov-error-icon" aria-hidden="true">!</span>
        <p className="ov-name">This page hit an error</p>
        <p className="ov-status">Retry usually fixes it.</p>
        <div className="ov-actions" data-focus-group="">
          <button type="button" className="btn primary focusable" data-focus="" onClick={() => onRetry?.()}>Retry</button>
          <a className="btn focusable" data-focus="" href="/">Home</a>
        </div>
        {error?.digest && <p className="ov-hint dim">Ref: {error.digest}</p>}
      </div>
    </div>
  );
}
