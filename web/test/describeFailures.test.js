import { describe, it, expect } from 'vitest';
import { describeFailures } from '../lib/player/useSubtitles';

/**
 * What the viewer is told when no caption loads.
 *
 * `failures` was already collected and then discarded, so a 404, a trailer
 * file and a track timed for a different cut all produced the same
 * "No usable subtitle for this release." Three different situations, one
 * message, and only one of them is actually our problem.
 *
 * The strings below are the real ones thrown by loadTrack.
 */
const MISTIMED = (n) => `subtitle spans ${n}min against a 157min film`;
const TOO_FEW = (n) => `subtitle has only ${n} cues`;
const HTTP = 'subtitle fetch failed: 404';

describe('describeFailures', () => {
  it('names mistiming, and points at the entries still worth trying', () => {
    // Measured on tt0330373: seven English tracks, six spanning 65-136min
    // against a 157min film. Rejecting them is correct - saying so is the fix.
    const msg = describeFailures([65, 75, 111, 136, 75, 65].map(MISTIMED), 6);
    expect(msg).toMatch(/different cut/);
    expect(msg).toMatch(/Try another/);
  });

  it('never claims to speak for the whole sheet', () => {
    // `tried` counts the files behind ONE menu entry - its url plus alternates.
    // The first version said "All 3 subtitles for this film", which the viewer
    // read against a sheet listing SIX entries. The count was right; the scope
    // was not.
    const msg = describeFailures([MISTIMED(70), MISTIMED(75), MISTIMED(80)], 3);
    expect(msg).not.toMatch(/for this film/);
    expect(msg).not.toMatch(/^All /);
  });

  it('gives the proportion when only some were mistimed', () => {
    const msg = describeFailures([MISTIMED(70), HTTP], 4);
    expect(msg).toMatch(/1 of 4/);
    expect(msg).toMatch(/Try another/);
  });

  it('calls out a song or trailer file, which is not a timing problem', () => {
    expect(describeFailures([TOO_FEW(6), TOO_FEW(11)], 2))
      .toMatch(/songs or trailers/);
  });

  it('stays generic for transport failures rather than leaking a status code', () => {
    const msg = describeFailures([HTTP, HTTP], 2);
    expect(msg).toBe('No usable subtitle for this release.');
    expect(msg).not.toMatch(/404/);
  });

  it('uses the singular wording when only one track was ever offered', () => {
    expect(describeFailures([HTTP], 1)).toBe('That subtitle could not be loaded.');
  });

  it('never throws on an empty or malformed list', () => {
    for (const bad of [[], undefined, [null], [{}]]) {
      expect(() => describeFailures(bad, 1)).not.toThrow();
    }
  });
});
