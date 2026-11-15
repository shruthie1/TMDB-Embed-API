import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
afterEach(cleanup);
import { useState } from 'react';
import ErrorBoundary from '../../components/ErrorBoundary';

// A render-time throw anywhere in the player (a bad stream shape, an hls.js
// edge case) used to unmount the whole title page to a blank screen. The
// boundary keeps the page, says what happened, and offers a way back.
function Boom({ fail }) {
  if (fail) throw new Error('kaboom');
  return <p>playing</p>;
}

describe('ErrorBoundary', () => {
  it('shows a clear fallback with Retry and Back instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onClose = vi.fn();
    render(<ErrorBoundary label="the player" onClose={onClose}><Boom fail /></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toMatch(/the player hit an error/i);
    fireEvent.click(screen.getByText('Back'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Retry renders the children again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let setFail;
    function Host() {
      const [fail, sf] = useState(true); setFail = sf;
      return <ErrorBoundary label="the player" onRetry={() => setFail(false)}><Boom fail={fail} /></ErrorBoundary>;
    }
    render(<Host />);
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByText('playing')).toBeTruthy();
  });
});
