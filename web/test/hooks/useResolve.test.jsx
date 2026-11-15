import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// The hook talks to the backend through lib/backend (this repo's adapter for
// the Express API); stub that boundary so the test drives real event sequences
// without a network. Upstream this mocked lib/api, which is where Chitram's
// resolver client lived.
const emit = { fn: null };
vi.mock('../../lib/backend', () => ({
  PREFERRED_LANGUAGE: 'Telugu',
  playableUrl: (u) => u,
  proxiedSegment: (u) => u,
  resolveLive: (type, id, opts) => { emit.fn = opts; return () => {}; },
}));

const { useResolve, describe: describeEvent, bestLabel } =
  await import('../../lib/player/useResolve');

function harness(props = { mediaType: 'movie', tmdbId: 13 }) {
  const api = {};
  function Probe(p) { Object.assign(api, useResolve(p)); return null; }
  render(<Probe {...props} />);
  return api;
}

beforeEach(() => {
  emit.fn = null;
  localStorage.clear();
});

describe('useResolve — the progress log', () => {
  it('renders a line for each real server event', () => {
    // This is the regression: the log stayed empty while events arrived.
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'wave-start', providers: ['a', 'b'], t: 1 }));
    act(() => emit.fn.onEvent({ type: 'extract-start', provider: 'a', t: 2 }));
    expect(api.log.map(l => l.line)).toEqual(['Trying a, b', 'Opening a']);
  });

  it('keeps only the last four lines, so the overlay cannot grow forever', () => {
    const api = harness();
    for (let i = 0; i < 8; i++) {
      act(() => emit.fn.onEvent({ type: 'extract-start', provider: `p${i}`, t: i }));
    }
    expect(api.log).toHaveLength(4);
    expect(api.log[3].line).toBe('Opening p7');
  });

  it('ignores events with no human sentence rather than logging blanks', () => {
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'something-internal', t: 1 }));
    expect(api.log).toHaveLength(0);
  });

  it('does not clear the log once events have arrived', () => {
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'cache-check', provider: 'mapple', t: 1 }));
    expect(api.log).toHaveLength(1);
    act(() => emit.fn.onEvent({ type: 'cache-hit', provider: 'mapple', t: 2 }));
    expect(api.log).toHaveLength(2);
  });
});

describe('useResolve — sources', () => {
  it('collects every validated provider as it arrives', () => {
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'validate-ok', provider: 'mapple',
      masterUrl: 'https://m/1.m3u8', variants: [{ resolution: '1920x1080' }], t: 1 }));
    act(() => emit.fn.onEvent({ type: 'validate-ok', provider: 'vidking',
      masterUrl: 'https://v/1.m3u8', variants: [{ resolution: '3840x2160' }], t: 2 }));
    expect(api.sources.map(s => s.provider)).toEqual(['mapple', 'vidking']);
    expect(api.sources[1].best).toBe('2160p');
  });

  it('never lists the same provider twice', () => {
    const api = harness();
    const e = { type: 'validate-ok', provider: 'mapple', masterUrl: 'https://m/1.m3u8', t: 1 };
    act(() => emit.fn.onEvent(e));
    act(() => emit.fn.onEvent({ ...e, t: 2 }));
    expect(api.sources).toHaveLength(1);
  });

  it('replaces a provider URL when a refresh returns a new signed URL', () => {
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'validate-ok', provider: 'vidking',
      masterUrl: 'https://v/expired.m3u8', variants: [{ resolution: '1280x720' }], t: 1 }));
    act(() => emit.fn.onEvent({ type: 'validate-ok', provider: 'vidking',
      masterUrl: 'https://v/fresh.m3u8', variants: [{ resolution: '1920x1080' }], t: 2 }));
    expect(api.sources).toHaveLength(1);
    expect(api.sources[0].masterUrl).toBe('https://v/fresh.m3u8');
    expect(api.sources[0].best).toBe('1080p');
  });

  it('merges the sources carried by `done` without dropping earlier ones', () => {
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'validate-ok', provider: 'mapple',
      masterUrl: 'https://m/1.m3u8', t: 1 }));
    act(() => emit.fn.onDone({ provider: 'mapple', masterUrl: 'https://m/1.m3u8',
      sources: [{ provider: 'mapple' }, { provider: 'videasy' }] }));
    expect(api.sources.map(s => s.provider)).toEqual(['mapple', 'videasy']);
  });

  // movie/1440735 really returns NetMirror x3 and CastleTV x2. Keying the
  // merge on the provider NAME collapsed those to one row each, and the
  // survivor was whichever arrived first - so the NetMirror master carrying
  // the Kannada and Telugu audio renditions was unreachable.
  it('keeps several distinct streams from the SAME provider', () => {
    const api = harness();
    act(() => emit.fn.onDone({ provider: 'netmirror', masterUrl: 'https://n/a.m3u8',
      sources: [
        { provider: 'netmirror', masterUrl: 'https://n/a.m3u8', quality: 'Auto' },
        { provider: 'netmirror', masterUrl: 'https://n/b.m3u8', quality: 'Auto' },
        { provider: 'castletv',  masterUrl: 'https://c/a.m3u8', quality: '720p' },
        { provider: 'castletv',  masterUrl: 'https://c/b.m3u8', quality: '480p' },
      ] }));
    expect(api.sources.length).toBe(4);
    expect(api.sources.map(s => s.masterUrl)).toEqual([
      'https://n/a.m3u8', 'https://n/b.m3u8', 'https://c/a.m3u8', 'https://c/b.m3u8',
    ]);
  });

  it('the same stream arriving twice still merges', () => {
    const api = harness();
    act(() => emit.fn.onEvent({ type: 'validate-ok', provider: 'netmirror',
      masterUrl: 'https://n/a.m3u8', t: 1 }));
    act(() => emit.fn.onDone({ provider: 'netmirror', masterUrl: 'https://n/a.m3u8',
      sources: [{ provider: 'netmirror', masterUrl: 'https://n/a.m3u8' }] }));
    expect(api.sources.length).toBe(1);
  });

  it('stops promising more sources once the wave settles', () => {
    const api = harness();
    expect(api.sourcesPending).toBe(true);
    act(() => emit.fn.onEvent({ type: 'resolved', t: 9 }));
    expect(api.sourcesPending).toBe(false);
  });

  it('a cache hit has no wave, so nothing further is promised', () => {
    const api = harness();
    act(() => emit.fn.onDone({ provider: 'mapple', cached: true, masterUrl: 'x' }));
    expect(api.sourcesPending).toBe(false);
  });
});

describe('useResolve — switching', () => {
  it('sends the remembered provider for this exact title and episode', () => {
    localStorage.setItem('chitram:last-provider:v1:tv:1396:2:5', 'vidking');
    const api = harness({ mediaType: 'tv', tmdbId: 1396, season: 2, episode: 5 });
    expect(api).toBeDefined();
    expect(emit.fn.provider).toBe('vidking');
  });

  it('switching replaces the stream without a re-resolve', () => {
    const api = harness();
    act(() => emit.fn.onDone({ provider: 'mapple', masterUrl: 'https://m/1.m3u8' }));
    act(() => api.switchSource({ provider: 'vidking', masterUrl: 'https://v/1.m3u8',
      variants: [{ resolution: '1280x720' }] }));
    expect(api.currentSource).toBe('vidking');
    expect(api.stream.masterUrl).toBe('https://v/1.m3u8');
  });

  it('switching clears a stale error so it cannot sit over a working stream', () => {
    const api = harness();
    act(() => emit.fn.onFail({ reason: 'nope', tried: ['a'] }));
    expect(api.error).not.toBeNull();
    act(() => api.switchSource({ provider: 'vidking', masterUrl: 'https://v/1.m3u8' }));
    expect(api.error).toBeNull();
  });

  // A manual switch used to rebuild the stream from url + variants alone, so
  // `progressive` was dropped and a netmirror .mp4 went down the hls.js path
  // and failed to parse. The picker changed; the picture did not.
  it('carries progressive through a manual switch, so an mp4 is not fed to hls.js', () => {
    const api = harness();
    act(() => api.switchSource({ provider: 'netmirror', masterUrl: 'https://n/a.mp4',
      progressive: true, referer: 'https://net27.cc/' }));
    expect(api.stream.progressive).toBe(true);
    expect(api.stream.referer).toBe('https://net27.cc/');
  });

  it('defaults progressive to false for a playlist source', () => {
    const api = harness();
    act(() => api.switchSource({ provider: 'vidking', masterUrl: 'https://v/1.m3u8' }));
    expect(api.stream.progressive).toBe(false);
  });
});

describe('describe()', () => {
  it('covers every event type the resolver emits', () => {
    const types = ['cache-check', 'cache-hit', 'wave-start', 'extract-start',
                   'extract-ok', 'extract-fail', 'validate-ok', 'validate-fail'];
    for (const type of types) {
      const line = describeEvent({ type, provider: 'p', providers: ['p'], ms: 1000, t: 1 });
      expect(line, type).toBeTruthy();
    }
  });
});

describe('bestLabel()', () => {
  it('reads the height from a resolution', () => {
    expect(bestLabel([{ resolution: '3840x2160' }])).toBe('2160p');
  });
  it('falls back to the quality string when there are no variants', () => {
    expect(bestLabel([], '1920x1080')).toBe('1080p');
  });
  it('is empty rather than undefined when nothing is known', () => {
    expect(bestLabel(undefined, null)).toBe('');
  });
});

describe('useResolve — mergeSources (late providers, e.g. NetMirror fetched on its own)', () => {
  const nf = { provider: 'NetMirror', masterUrl: 'https://x/nf.m3u8', quality: 'Auto', languages: ['Telugu'] };
  const pv = { provider: 'NetMirror', masterUrl: 'https://x/pv.m3u8', quality: 'Auto', languages: ['Hindi'] };

  it('keeps every row of a provider that ships several (Netflix AND Prime)', () => {
    // Matching on the provider NAME alone made the Prime row overwrite the
    // Netflix one, so a title on two platforms showed one.
    const api = harness();
    act(() => api.mergeSources([nf, pv]));
    expect(api.sources.map((s) => s.masterUrl)).toEqual([nf.masterUrl, pv.masterUrl]);
  });

  it('updates a row it already has in place instead of duplicating it', () => {
    const api = harness();
    act(() => api.mergeSources([nf]));
    act(() => api.mergeSources([{ ...nf, languages: ['Telugu', 'Hindi'] }]));
    expect(api.sources).toHaveLength(1);
    expect(api.sources[0].languages).toEqual(['Telugu', 'Hindi']);
  });
});
