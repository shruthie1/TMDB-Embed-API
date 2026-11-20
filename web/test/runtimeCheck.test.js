import { describe, it, expect } from 'vitest';
import { runtimeVerdict } from '../lib/player/runtimeCheck';

// Player.jsx sends ok:true only on 'ok'. On 'unknown' it defers the report
// until the durationchange/poll check can run.
describe('runtimeVerdict gates the success report', () => {
  it('is unknown while runtimeMin has not loaded, so a play is not confirmed', () => {
    // Krack 784572: truncated Castle Telugu file, first frame before runtimeMin.
    expect(runtimeVerdict(null, 102.5 * 60)).toBe('unknown');
    expect(runtimeVerdict(0, 102.5 * 60)).toBe('unknown');
    expect(runtimeVerdict(undefined, 102.5 * 60)).toBe('unknown');
  });

  it('is unknown while the duration is not known', () => {
    expect(runtimeVerdict(154, NaN)).toBe('unknown');
    expect(runtimeVerdict(154, 0)).toBe('unknown');
    expect(runtimeVerdict(154, undefined)).toBe('unknown');
  });

  it('flags the truncated file once runtimeMin arrives', () => {
    expect(runtimeVerdict(154, 102.5 * 60)).toBe('mismatch');
  });

  it('confirms a full-length file', () => {
    expect(runtimeVerdict(154, 9033)).toBe('ok');
  });

  it('keeps the 0.82 threshold', () => {
    expect(runtimeVerdict(100, 82 * 60)).toBe('ok');
    expect(runtimeVerdict(100, 81.9 * 60)).toBe('mismatch');
  });
});
