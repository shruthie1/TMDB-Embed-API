import { describe, it, expect } from 'vitest';
import {
  SWITCH_NO_LIFE_MS, SWITCH_HARD_MS, beginSourceSwitch, tickSourceSwitch, rearmSourceSwitch,
} from '../lib/player/switchFlow';
import { DIRECT_FIRST_FRAME_MS } from '../lib/player/directRoute';

// Re-review I-A: a switch to a web-direct row is judged by the 8 s / 20 s
// switch clock. The same-row proxy retry (useHls fallBack) must get its own
// window, and a direct hang must reach the proxy try before any dead verdict.
const OLD = { key: 'old' };
const NEW = { key: 'new' };
const T = { id: 'CastleTV-0', provider: 'CastleTV', masterUrl: 'https://vm/m3u8-proxy?url=x' };
const begin = () => beginSourceSwitch({ target: T, label: 'CastleTV', streamKey: OLD, now: 0 });

describe('switch clock and the direct->proxy retry', () => {
  it('a hung direct attempt is never judged dead by the no-life rule before its proxy try', () => {
    expect(DIRECT_FIRST_FRAME_MS).toBeGreaterThan(SWITCH_NO_LIFE_MS);
    const s = begin();
    for (const now of [SWITCH_NO_LIFE_MS, 9000, DIRECT_FIRST_FRAME_MS - 1]) {
      expect(tickSourceSwitch(s, { streamKey: NEW, alive: false, direct: true, now }).verdict).toBe('wait');
    }
  });

  it('direct fails at 9 s, proxy frames at 20 s: landed', () => {
    let s = tickSourceSwitch(begin(), { streamKey: NEW, alive: false, direct: true, now: 9000 }).state;
    s = rearmSourceSwitch(s, 9000);
    expect(s.phase).toBe('loading');
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: true, now: 19500 }).verdict).toBe('wait');
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: true, frames: true, now: 20000 }).verdict).toBe('landed');
  });

  it('the proxy try gets the full 8 s / 20 s window from the fallback', () => {
    const s = rearmSourceSwitch(begin(), 10000);
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: false, now: 10000 + SWITCH_NO_LIFE_MS - 1 }).verdict).toBe('wait');
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: false, now: 10000 + SWITCH_NO_LIFE_MS }).verdict).toBe('dead');
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: true, now: 10000 + SWITCH_HARD_MS }).verdict).toBe('dead');
  });

  it('non-direct rows keep the 8 s no-life verdict', () => {
    expect(tickSourceSwitch(begin(), { streamKey: NEW, alive: false, now: SWITCH_NO_LIFE_MS }).verdict).toBe('dead');
  });

  it('rearm with no switch pending is a no-op', () => {
    expect(rearmSourceSwitch(null, 5)).toBeNull();
  });
});
