'use client';
import { Component } from 'react';

/**
 * Catches a render-time throw in its children and shows a plain message with
 * Retry and Back, in the same card style as the player's own error screen.
 *
 * Without it a throw inside the player (a malformed stream row, an hls.js
 * edge case) unmounted the whole title page to a blank screen with no way
 * forward but a manual reload.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[boundary] ${this.props.label || 'component'} crashed:`, error, info?.componentStack || '');
  }

  retry() {
    this.props.onRetry?.();
    this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label = 'This page', onClose } = this.props;
    return (
      <div className="overlay ov-screen boundary-screen">
        <div className="ov-card ov-card-error" role="alert">
          <span className="ov-error-icon" aria-hidden="true">!</span>
          <p className="ov-name">{`${label.charAt(0).toUpperCase()}${label.slice(1)} hit an error`}</p>
          <p className="ov-status">Retry usually fixes it. Your place in the film is saved.</p>
          <div className="ov-actions" data-focus-group="">
            <button type="button" className="btn primary focusable" data-focus="" onClick={this.retry}>Retry</button>
            {onClose && <button type="button" className="btn focusable" data-focus="" onClick={onClose}>Back</button>}
          </div>
          <details className="ov-details">
            <summary className="focusable" data-focus="">Details</summary>
            <p className="ov-hint dim">{String(error?.message || error).slice(0, 300)}</p>
          </details>
        </div>
      </div>
    );
  }
}
