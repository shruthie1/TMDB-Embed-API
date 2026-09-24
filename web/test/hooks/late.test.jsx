import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const listed = { tracks: [], throws: false };
const loaded = { calls: [], failUrls: [], hold: null };
vi.mock('../../lib/subtitles', () => ({
  listSubtitles: async () => { if (listed.throws) throw new Error('down'); return listed.tracks; },
  loadTrack: async (url, opts) => {
    loaded.calls.push({ url, ...opts });
    if (loaded.hold) await loaded.hold;
    if (loaded.failUrls.includes(url)) throw new Error('bad span');
    return `blob:${url}`;
  },
  getSubPrefs: () => ({ scale: 1, offsetMs: 0 }),
  setSubPrefs: (p) => ({ scale: 1, offsetMs: 0, ...p }),
}));
const revoked = [];
URL.createObjectURL ??= (b) => `blob:${b}`;
URL.revokeObjectURL = (u) => revoked.push(u);

const { useSubtitles } = await import('../../lib/player/useSubtitles');

// Unlike the existing harness, this one can RERENDER with new props - which is
// how the real player behaves.
function harness(initial) {
  let latest = {};
  function Probe(p){ latest = useSubtitles(p); return null; }
  const r = render(<Probe {...initial} />);
  return [new Proxy({}, { get: (_t, k) => latest[k] }),
          (next) => r.rerender(<Probe {...next} />)];
}

beforeEach(() => { listed.tracks=[]; listed.throws=false; loaded.calls=[]; loaded.failUrls=[]; loaded.hold=null; revoked.length=0; });

describe('late imdbId (the real first-load sequence)', () => {
  it('auto-enables once imdbId arrives after the first render', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    // First paint: the fast record has no imdbId yet.
    const [api, rerender] = harness({ imdbId: null });
    await new Promise(r => setTimeout(r, 20));
    expect(api.subs).toHaveLength(0);
    // The full record lands.
    await act(async () => { rerender({ imdbId: 'tt1' }); });
    await waitFor(() => expect(api.subs).toHaveLength(1));
    await waitFor(() => expect(api.currentSub).toBe('eng:0'));
    expect(api.subUrl).toBe('blob:u1');
  });

  it('auto-enables when the viewer opens the sheet before tracks arrive', async () => {
    // The user opens settings early; subs resolve a moment later.
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const [api] = harness({ imdbId: 'tt1' });
    await waitFor(() => expect(api.currentSub).toBe('eng:0'));
  });

  it('a season/episode change does not strand the sheet on Off', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const [api, rerender] = harness({ imdbId: 'tt1', season: 1, episode: 1 });
    await waitFor(() => expect(api.currentSub).toBe('eng:0'));
    listed.tracks = [{ id: 'eng:9', lang: 'eng', name: 'English E2', url: 'u2' }];
    await act(async () => { rerender({ imdbId: 'tt1', season: 1, episode: 2 }); });
    await waitFor(() => expect(api.subs[0]?.id).toBe('eng:9'));
    // The old id is gone from the list; if currentSub still points at it the
    // sheet highlights nothing and the row reads Off.
    await waitFor(() => expect(api.currentSub).toBe('eng:9'));
  });
});
