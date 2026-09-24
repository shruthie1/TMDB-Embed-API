import { describe, it, expect } from 'vitest';
import { abortReason, isAbort } from '../lib/abortReason';

describe('abortReason', () => {
  it('produces an AbortError so existing handlers keep working', () => {
    // Callers branch on err.name === 'AbortError' (lib/api.js) and on
    // signal.aborted. A plain Error here would silently turn a handled cancel
    // into a reported failure.
    const e = abortReason('timeout after 15000ms');
    expect(e).toBeInstanceOf(DOMException);
    expect(e.name).toBe('AbortError');
    expect(isAbort(e)).toBe(true);
  });

  it('carries the reason as the message', () => {
    // The whole point: "signal is aborted without reason" told us nothing
    // about WHICH cancel fired.
    expect(abortReason('unmounted').message).toBe('unmounted');
  });

  it('never produces the browser default message', () => {
    expect(abortReason('x').message).not.toMatch(/without reason/);
    expect(abortReason().message).toBe('cancelled');
  });

  it('does not treat a real error as an abort', () => {
    expect(isAbort(new TypeError('network'))).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort(undefined)).toBe(false);
  });

  it('a controller aborted with a reason exposes it on the signal', () => {
    const ac = new AbortController();
    ac.abort(abortReason('caller cancelled'));
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason.name).toBe('AbortError');
    expect(ac.signal.reason.message).toBe('caller cancelled');
  });

  it('a bare abort is what we are avoiding', () => {
    // Documents the behaviour being fixed. The exact wording is ENGINE
    // SPECIFIC - Chrome says "signal is aborted without reason" (which is what
    // the dev overlay printed), jsdom says "This operation was aborted" - so
    // assert the invariant instead: a bare abort carries a synthesised message
    // that names no cause, while ours names one.
    const bare = new AbortController();
    bare.abort();
    const ours = new AbortController();
    ours.abort(abortReason('unmounted'));

    expect(bare.signal.reason.name).toBe('AbortError');
    expect(ours.signal.reason.message).toBe('unmounted');
    expect(bare.signal.reason.message).not.toBe('unmounted');
  });
});
