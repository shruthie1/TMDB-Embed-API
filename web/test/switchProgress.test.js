import { describe, it, expect } from 'vitest';
import {
  SWITCH_NO_LIFE_MS, SWITCH_HARD_MS, SWITCH_FLOW_GAP_MS, SWITCH_FLOWING_MAX_MS, beginSourceSwitch, tickSourceSwitch,
} from '../lib/player/switchFlow';

// 2026-11-24: a NetMirror mp4 (bcdnxw) has a 7,323,216-byte moov at the front of a
// 1,186,031,444-byte file. A TV browser on 4g gets no metadata (no buffer, no
// duration, readyState 0) until all of it is in, so the 8 s no-life cut killed
// a download that was still flowing (3 `switch timeout`, startupMs 7.7 s).
const OLD = { key: 'old' };
const NEW = { key: 'new' };
const T = { id: 'NetMirror-1', provider: 'NetMirror', masterUrl: 'https://x/ts-proxy' };
const begin = () => beginSourceSwitch({ target: T, label: 'NetMirror', streamKey: OLD, now: 0 });

describe('switch watchdog measures progress, not a fixed 8 s', () => {
  it('bytes still arriving at 8 s: wait, not dead', () => {
    const r = tickSourceSwitch(begin(), { streamKey: NEW, alive: false, lastProgressAt: SWITCH_NO_LIFE_MS - 400, now: SWITCH_NO_LIFE_MS });
    expect(r.verdict).toBe('wait');
  });

  it('bytes still arriving past 20 s: wait until the flowing cap', () => {
    const at = SWITCH_HARD_MS + 5000;
    expect(tickSourceSwitch(begin(), { streamKey: NEW, lastProgressAt: at - 500, now: at }).verdict).toBe('wait');
    expect(tickSourceSwitch(begin(), { streamKey: NEW, lastProgressAt: SWITCH_FLOWING_MAX_MS - 100, now: SWITCH_FLOWING_MAX_MS }).verdict).toBe('dead');
  });

  it('bytes stopped: the no-life cut applies again', () => {
    const now = SWITCH_NO_LIFE_MS + 1000;
    expect(tickSourceSwitch(begin(), { streamKey: NEW, lastProgressAt: now - SWITCH_FLOW_GAP_MS, now }).verdict).toBe('dead');
  });

  it('progress from before the switch never counts', () => {
    expect(tickSourceSwitch(begin(), { streamKey: NEW, lastProgressAt: -1, now: SWITCH_NO_LIFE_MS }).verdict).toBe('dead');
  });

  it('no progress reported: the old 8 s rule is unchanged', () => {
    expect(tickSourceSwitch(begin(), { streamKey: NEW, now: SWITCH_NO_LIFE_MS }).verdict).toBe('dead');
  });
});
