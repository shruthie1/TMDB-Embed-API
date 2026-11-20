import { describe, it, expect } from 'vitest';
import {
  SWITCH_NO_LIFE_MS, SWITCH_HARD_MS, hasLife, beginSourceSwitch, tickSourceSwitch,
  advanceTarget, advanceNotice,
} from '../lib/player/switchFlow';

const OLD = { key: 'old' };
const NEW = { key: 'new' };
const T = { id: 'VaPlayer-3', provider: 'VaPlayer', masterUrl: 'https://x/va.m3u8' };

const begin = () => beginSourceSwitch({ target: T, label: 'VaPlayer', at: 2879, ctx: { lang: 'Telugu', height: 720 }, streamKey: OLD, now: 0 });

describe('switch overlay state', () => {
  it('starts as requested, the moment of the click', () => {
    const s = begin();
    expect(s.phase).toBe('requested');
    expect(s.label).toBe('VaPlayer');
  });

  it('the OLD stream playing on never counts as landed (pairing in flight)', () => {
    const r = tickSourceSwitch(begin(), { streamKey: OLD, frames: true, alive: true, now: 3000 });
    expect(r.verdict).toBe('wait');
    expect(r.state.phase).toBe('requested');
  });

  it('requested -> loading once the new stream is attached', () => {
    const r = tickSourceSwitch(begin(), { streamKey: NEW, frames: false, alive: false, now: 1000 });
    expect(r.verdict).toBe('wait');
    expect(r.state.phase).toBe('loading');
  });

  it('loading -> landed on the first frame of the new stream', () => {
    let r = tickSourceSwitch(begin(), { streamKey: NEW, now: 1000 });
    r = tickSourceSwitch(r.state, { streamKey: NEW, frames: true, now: 2500 });
    expect(r).toEqual({ state: null, verdict: 'landed' });
  });

  it('dead at 8s with no sign of life', () => {
    const s = begin();
    expect(tickSourceSwitch(s, { streamKey: NEW, now: SWITCH_NO_LIFE_MS - 1 }).verdict).toBe('wait');
    expect(tickSourceSwitch(s, { streamKey: NEW, now: SWITCH_NO_LIFE_MS }).verdict).toBe('dead');
  });

  it('a pairing that never attaches a new stream is dead at 20s, not 8s', () => {
    expect(tickSourceSwitch(begin(), { streamKey: OLD, alive: true, now: SWITCH_NO_LIFE_MS }).verdict).toBe('wait');
    expect(tickSourceSwitch(begin(), { streamKey: OLD, alive: true, now: SWITCH_HARD_MS }).verdict).toBe('dead');
  });

  it('a live-but-slow server gets up to 20s, no longer', () => {
    const s = begin();
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: true, now: 15000 }).verdict).toBe('wait');
    expect(tickSourceSwitch(s, { streamKey: NEW, alive: true, now: SWITCH_HARD_MS }).verdict).toBe('dead');
  });

  it('hasLife ignores stale dimensions from the previous source', () => {
    expect(hasLife({ videoWidth: 1722, buffered: { length: 0 }, duration: NaN, readyState: 0 })).toBe(false);
    expect(hasLife({ buffered: { length: 1 }, duration: NaN, readyState: 0 })).toBe(true);
    expect(hasLife({ buffered: { length: 0 }, duration: 9000, readyState: 1 })).toBe(true);
  });
});

describe('timeout -> auto-advance', () => {
  // RRR-shaped list (movie/579974): Hindi listed first.
  const rows = [
    { id: 'A-hi', provider: 'A', quality: '1080p', languages: ['Hindi'], masterUrl: 'https://a' },
    { id: 'Va-te', provider: 'VaPlayer', quality: '720p', languages: ['Telugu'], masterUrl: 'https://va' },
    { id: 'B-te', provider: 'B', quality: '720p', languages: ['Telugu'], masterUrl: 'https://b' },
    { id: 'C-te', provider: 'C', quality: '480p', languages: ['Telugu'], masterUrl: 'https://c' },
  ];

  it('picks the same-language next alive row, never the failed one', () => {
    const dead = new Set();
    const next = advanceTarget(rows, dead, rows[1], { lang: 'Telugu', height: 720 });
    expect(next.id).toBe('B-te');
    expect(dead.has('Va-te')).toBe(true);
  });

  it('with no language known at the click, Telugu still leads', () => {
    const next = advanceTarget(rows, new Set(), rows[1], {});
    expect(next.languages).toEqual(['Telugu']);
  });

  it('crosses language only when no same-language row is alive', () => {
    const dead = new Set(['B-te', 'C-te']);
    expect(advanceTarget(rows, dead, rows[1], { lang: 'Telugu' }).id).toBe('A-hi');
  });

  it('returns null when nothing is left', () => {
    expect(advanceTarget([rows[1]], new Set(), rows[1], { lang: 'Telugu' })).toBeNull();
  });

  it('says what happened in one line', () => {
    expect(advanceNotice('VaPlayer', 'B')).toBe("VaPlayer didn't respond, playing B.");
  });
});
