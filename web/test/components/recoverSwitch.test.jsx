import { describe, it, expect, vi } from 'vitest';

/**
 * Recovery from a dead stream, mirroring the onFatal path in Player.jsx.
 *
 * A resolve usually validates SEVERAL providers and keeps them in `sources`,
 * each with its own masterUrl, so switching costs no network round-trip.
 * Falling straight to a re-resolve threw that away: it cleared the stream and
 * started over, meaning a spinner and 3-16s even though a working source was
 * already in hand.
 */
function onFatal({ code, sources, currentSource, switchSource, reResolve, dead }) {
  const is403 = code === 403 || code === 410;
  if (!is403) return 'reported';
  if (currentSource) dead?.add(currentSource);
  const alt = sources?.find(s => s.masterUrl && !dead?.has(s.provider));
  if (alt) { switchSource(alt); return 'switched'; }
  reResolve();
  return 'reresolved';
}

const SOURCES = [
  { provider: 'vidking', masterUrl: 'https://a/m.m3u8' },
  { provider: 'mapple', masterUrl: 'https://b/m.m3u8' },
];

describe('recovering from a stale signed url', () => {
  it('switches to another validated source instead of re-resolving', () => {
    // The whole point: the alternate is already in memory and validated.
    const switchSource = vi.fn(), reResolve = vi.fn();
    const out = onFatal({ code: 403, sources: SOURCES, currentSource: 'vidking',
                          switchSource, reResolve, dead: new Set() });
    expect(out).toBe('switched');
    expect(switchSource).toHaveBeenCalledWith(SOURCES[1]);
    expect(reResolve).not.toHaveBeenCalled();
  });

  it('never picks the source that just died', () => {
    const switchSource = vi.fn(), reResolve = vi.fn();
    onFatal({ code: 403, sources: SOURCES, currentSource: 'vidking',
              switchSource, reResolve, dead: new Set() });
    expect(switchSource.mock.calls[0][0].provider).not.toBe('vidking');
  });

  it('re-resolves when that was the last source we had', () => {
    const switchSource = vi.fn(), reResolve = vi.fn();
    const out = onFatal({ code: 403, sources: [SOURCES[0]], currentSource: 'vidking',
                          switchSource, reResolve, dead: new Set() });
    expect(out).toBe('reresolved');
    expect(switchSource).not.toHaveBeenCalled();
    expect(reResolve).toHaveBeenCalled();
  });

  it('handles 410 the same way as 403', () => {
    // Both mean the signed url is gone, not that the provider is broken.
    const switchSource = vi.fn(), reResolve = vi.fn();
    expect(onFatal({ code: 410, sources: SOURCES, currentSource: 'vidking',
                     switchSource, reResolve, dead: new Set() })).toBe('switched');
  });

  it('never returns to a source that already died this session', () => {
    // `provider !== currentSource` alone is not enough: after one switch the
    // ORIGINAL becomes eligible again, so two stale urls could hand the player
    // back and forth between them forever.
    const dead = new Set();
    const switchSource = vi.fn(), reResolve = vi.fn();

    // vidking dies -> switches to mapple.
    expect(onFatal({ code: 403, sources: SOURCES, currentSource: 'vidking',
                     switchSource, reResolve, dead })).toBe('switched');
    expect(switchSource.mock.calls[0][0].provider).toBe('mapple');

    // mapple dies too. vidking is NOT offered back; there is nothing left.
    expect(onFatal({ code: 403, sources: SOURCES, currentSource: 'mapple',
                     switchSource, reResolve, dead })).toBe('reresolved');
    expect(switchSource).toHaveBeenCalledTimes(1);
    expect(reResolve).toHaveBeenCalledTimes(1);
  });

  it('still reaches a third source when the first two died', () => {
    const dead = new Set();
    const three = [...SOURCES, { provider: 'vidzee', masterUrl: 'https://c/m.m3u8' }];
    const switchSource = vi.fn(), reResolve = vi.fn();
    onFatal({ code: 403, sources: three, currentSource: 'vidking', switchSource, reResolve, dead });
    onFatal({ code: 403, sources: three, currentSource: 'mapple', switchSource, reResolve, dead });
    expect(switchSource.mock.calls.map(c => c[0].provider)).toEqual(['mapple', 'vidzee']);
    expect(reResolve).not.toHaveBeenCalled();
  });

  it('does not switch on an unrelated fatal error', () => {
    // A decode failure follows the stream, so switching source would hide the
    // real cause and loop through every provider.
    const switchSource = vi.fn(), reResolve = vi.fn();
    const out = onFatal({ code: 500, sources: SOURCES, currentSource: 'vidking',
                          switchSource, reResolve, dead: new Set() });
    expect(out).toBe('reported');
    expect(switchSource).not.toHaveBeenCalled();
    expect(reResolve).not.toHaveBeenCalled();
  });

  it('skips a source with no url rather than switching to nothing', () => {
    const switchSource = vi.fn(), reResolve = vi.fn();
    const out = onFatal({
      code: 403, currentSource: 'vidking',
      sources: [SOURCES[0], { provider: 'ghost', masterUrl: null }],
      switchSource, reResolve, dead: new Set(),
    });
    expect(out).toBe('reresolved');
  });
});
