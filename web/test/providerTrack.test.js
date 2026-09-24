import { describe, it, expect } from 'vitest';
import { trackReducer } from '../lib/player/useResolve';

/**
 * The per-provider queue track.
 *
 * This exists because of a measured, reproducible lie in the overlay: on
 * tmdb 60550 the message said "Opening vidking" and then did not change for
 * 12 seconds. vidking had NOT been opened - it was sitting behind two other
 * Chromium extractions on a two-core VM. The viewer has no way to tell a
 * queued provider from a hung one, so they conclude the player is broken.
 *
 * These tests pin the distinction the reducer has to preserve: queued is not
 * opening, and an extracted-but-unvalidated source is not a found one.
 */
const feed = (...events) => events.reduce(trackReducer, []);

describe('trackReducer', () => {
  it('seeds the whole roster as queued before any provider runs', () => {
    // wave-start arrives before the first extraction. Without this the rows
    // pop in one at a time and the viewer cannot see how much is still ahead.
    const rows = feed({ type: 'wave-start', providers: ['vidking', 'mapple', 'showsst'] });
    expect(rows.map(r => r.name)).toEqual(['vidking', 'mapple', 'showsst']);
    expect(rows.every(r => r.state === 'queued')).toBe(true);
  });

  it('holds roster order when results come back out of order', () => {
    // showsst finishing first must not lift its row to the top - a list that
    // reorders under the eye is harder to read than a static one.
    const rows = feed(
      { type: 'wave-start', providers: ['vidking', 'mapple', 'showsst'] },
      { type: 'extract-ok', provider: 'showsst', ms: 900 },
    );
    expect(rows.map(r => r.name)).toEqual(['vidking', 'mapple', 'showsst']);
  });

  it('separates queued from opening using the gate depth', () => {
    // The exact bug: extract-start fires at SUBMIT time, not at start time.
    const rows = feed(
      { type: 'wave-start', providers: ['vidking', 'mapple'] },
      { type: 'extract-start', provider: 'vidking', queued: 2 },
      { type: 'extract-start', provider: 'mapple', queued: 0 },
    );
    expect(rows[0]).toMatchObject({ state: 'queued', queued: 2 });
    expect(rows[1]).toMatchObject({ state: 'opening', queued: 0 });
  });

  it('promotes a provider from queued to opening when its slot frees', () => {
    const rows = feed(
      { type: 'extract-start', provider: 'vidking', queued: 3 },
      { type: 'extract-start', provider: 'vidking', queued: 0 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'opening', queued: 0 });
  });

  it('records extraction time on success', () => {
    const rows = feed({ type: 'extract-ok', provider: 'mapple', ms: 2400 });
    expect(rows[0]).toMatchObject({ state: 'validating', ms: 2400 });
  });

  it('demotes a source that extracted but failed validation', () => {
    // extract-ok only means a URL came back. If it will not play, calling it
    // "found" promises the viewer a stream that does not exist.
    const rows = feed(
      { type: 'extract-ok', provider: 'showsst', ms: 1800 },
      { type: 'validate-fail', provider: 'showsst', reason: 'segment 403' },
    );
    expect(rows[0].state).toBe('failed');
  });

  it('shows the fast tier and cache hits, which never touch the gate', () => {
    // ~80% of resolves are served without a browser and emit no extract
    // events at all. An empty track on those would look broken.
    expect(feed({ type: 'fast-hit', provider: 'mappleapi', ms: 1500 })[0])
      .toMatchObject({ name: 'mappleapi', state: 'ok', ms: 1500 });
    expect(feed({ type: 'cache-hit', provider: 'vidking' })[0])
      .toMatchObject({ name: 'vidking', state: 'ok' });
  });

  it('returns the same array when an event changes nothing', () => {
    // Identity is load-bearing: this runs on every SSE message, and a new
    // array each time re-renders the overlay against no visible change.
    const rows = feed({ type: 'extract-start', provider: 'vidking', queued: 0 });
    expect(trackReducer(rows, { type: 'validate-retry', provider: 'vidking' })).toBe(rows);
    expect(trackReducer(rows, { type: 'resolved' })).toBe(rows);
    expect(trackReducer(rows, { type: 'extract-start', provider: 'vidking', queued: 0 })).toBe(rows);
  });

  it('ignores a wave-start carrying no roster', () => {
    const rows = feed({ type: 'extract-ok', provider: 'mapple', ms: 100 });
    expect(trackReducer(rows, { type: 'wave-start', providers: [] })).toBe(rows);
  });
});
