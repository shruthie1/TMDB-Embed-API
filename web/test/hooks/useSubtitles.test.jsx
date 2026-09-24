import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

const listed = { tracks: [], throws: false };
const loaded = { calls: [], failUrls: [], hold: null };
vi.mock('../../lib/subtitles', () => ({
  listSubtitles: async () => { if (listed.throws) throw new Error('down'); return listed.tracks; },
  loadTrack: async (url, opts) => {
    loaded.calls.push({ url, ...opts });
    // A gate, so a test can observe the in-flight state rather than only the
    // settled one.
    if (loaded.hold) await loaded.hold;
    // Mirrors reality: a bad file only reveals itself after downloading.
    if (loaded.failUrls.includes(url)) throw new Error('subtitle spans 3min against a 187min film');
    return `blob:${url}`;
  },
  getSubPrefs: () => ({ scale: 1, offsetMs: 0 }),
  setSubPrefs: (p) => ({ scale: 1, offsetMs: 0, ...p }),
}));
// jsdom implements neither of these; the hook revokes every blob url it
// replaces, which is what stops the player leaking one per subtitle switch.
const revoked = [];
URL.createObjectURL ??= (b) => `blob:${b}`;
URL.revokeObjectURL = (u) => revoked.push(u);

const { useSubtitles } = await import('../../lib/player/useSubtitles');

function harness(props = { imdbId: 'tt1' }) {
  let latest = {};
  function Probe(p){ latest = useSubtitles(p); return null; }
  render(<Probe {...props} />);
  // A live view of the hook's current return, so an assertion after a state
  // change never reads a stale snapshot.
  return new Proxy({}, { get: (_t, k) => latest[k] });
}

beforeEach(() => { listed.tracks = []; listed.throws = false; loaded.calls = []; loaded.failUrls = []; loaded.hold = null; revoked.length = 0; });

describe('useSubtitles', () => {
  it('lists the tracks for a title', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
  });

  it('a catalogue failure is silent - captions never break playback', async () => {
    listed.throws = true;
    const api = harness();
    await new Promise(r => setTimeout(r, 10));
    expect(api.subs).toEqual([]);
  });

  it('loads the chosen track and exposes a blob url', async () => {
    listed.tracks = [{ id: 'tel:0', lang: 'tel', name: 'Telugu', url: 'u-tel' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
    act(() => api.setCurrentSub('tel:0'));
    await waitFor(() => expect(api.subUrl).toBe('blob:u-tel'));
  });

  it('turning captions off clears the track', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
    act(() => api.setCurrentSub('eng:0'));
    await waitFor(() => expect(api.subUrl).toBeTruthy());
    act(() => api.setCurrentSub(null));
    await waitFor(() => expect(api.subUrl).toBeNull());
  });

  it('a timing change re-fetches, because the offset is baked into the cues', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
    act(() => api.setCurrentSub('eng:0'));
    await waitFor(() => expect(loaded.calls).toHaveLength(1));
    act(() => api.updatePrefs({ offsetMs: 500 }));
    await waitFor(() => expect(loaded.calls).toHaveLength(2));
    expect(loaded.calls[1].offsetMs).toBe(500);
  });

  it('revokes the previous blob url, so switching never leaks', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' },
                     { id: 'tel:0', lang: 'tel', name: 'Telugu', url: 'u2' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(2));
    act(() => api.setCurrentSub('eng:0'));
    await waitFor(() => expect(api.subUrl).toBe('blob:u1'));
    act(() => api.setCurrentSub('tel:0'));
    await waitFor(() => expect(api.subUrl).toBe('blob:u2'));
    expect(revoked).toContain('blob:u1');
  });

  it('a size change does NOT re-fetch - it is only a CSS token', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
    act(() => api.setCurrentSub('eng:0'));
    await waitFor(() => expect(loaded.calls).toHaveLength(1));
    act(() => api.updatePrefs({ scale: 1.5 }));
    await new Promise(r => setTimeout(r, 20));
    expect(loaded.calls).toHaveLength(1);
    expect(document.documentElement.style.getPropertyValue('--cue-scale')).toBe('1.5');
  });

  it('enables the best English track on its own', async () => {
    // Nothing selected a track before, so captions never appeared unless the
    // viewer went hunting in the menu. listSubtitles already ranks by
    // reliability, so the best candidate is simply the first.
    listed.tracks = [
      { id: 'eng:0', lang: 'eng', name: 'English (Blu-ray)', url: 'u-best' },
      { id: 'eng:1', lang: 'eng', name: 'English (WEB-DL)',  url: 'u-other' },
    ];
    const api = harness();
    await waitFor(() => expect(api.subUrl).toBe('blob:u-best'));
    expect(api.currentSub).toBe('eng:0');
  });

  it('leaves subtitles OFF once the viewer turns them off', async () => {
    // `currentSub: null` alone cannot tell "not started" from "switched off",
    // so without tracking the choice, auto-select would switch them straight
    // back on and the off button would appear broken.
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const api = harness();
    await waitFor(() => expect(api.subUrl).toBe('blob:u1'));
    act(() => api.setCurrentSub(null));
    await waitFor(() => expect(api.subUrl).toBeNull());
    // Give the effect every chance to re-fire.
    await new Promise(r => setTimeout(r, 30));
    expect(api.currentSub).toBeNull();
    expect(api.subUrl).toBeNull();
  });

  it('tells same-language variants apart, so picking the 2nd loads the 2nd', async () => {
    // Every English variant shares lang 'eng'. Selecting by language code
    // meant the picker always loaded the first file whichever row was tapped.
    listed.tracks = [
      { id: 'eng:0', lang: 'eng', name: 'English (Blu-ray)', url: 'u-bluray' },
      { id: 'eng:1', lang: 'eng', name: 'English (WEB-DL)',  url: 'u-webdl' },
    ];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(2));
    // The best track is auto-enabled first, so u-bluray loads on its own.
    await waitFor(() => expect(api.subUrl).toBe('blob:u-bluray'));
    act(() => api.setCurrentSub('eng:1'));
    await waitFor(() => expect(api.subUrl).toBe('blob:u-webdl'));
    // The point of the test: tapping the 2nd row loads the 2nd FILE, not the
    // first again. Both were fetched, in order.
    expect(loaded.calls.map(c => c.url)).toEqual(['u-bluray', 'u-webdl']);
  });

  it('reports while a track is downloading, so the row is not silent', async () => {
    // The viewer's complaint: pick a subtitle, see nothing, cannot tell a slow
    // load from a broken one. A reliable track can cost several sequential
    // downloads, so the wait is real and has to be visible.
    let release;
    loaded.hold = new Promise(r => { release = r; });
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'u1' }];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));

    // Auto-select starts the download itself, so the wait is visible without
    // the viewer touching anything - which is the whole point of showing it.
    await waitFor(() => expect(api.subLoading).toBe(true));
    // The previous track is cleared at once: stale cues are the wrong words.
    expect(api.subUrl).toBeNull();

    await act(async () => { release(); });
    await waitFor(() => expect(api.subLoading).toBe(false));
    expect(api.subUrl).toBe('blob:u1');
  });

  it('stops reporting a load when every candidate fails', async () => {
    listed.tracks = [{ id: 'eng:0', lang: 'eng', name: 'English', url: 'bad' }];
    loaded.failUrls = ['bad'];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
    act(() => api.setCurrentSub('eng:0'));
    await waitFor(() => expect(api.subLoading).toBe(false));
    expect(api.subUrl).toBeNull();
  });

  it('falls through to an alternate when the chosen file is unusable', async () => {
    // A song file or a track cut for another release only fails after
    // download; captions should still appear rather than nothing.
    listed.tracks = [{
      id: 'eng:0', lang: 'eng', name: 'English', url: 'u-bad',
      alternates: ['u-good'],
    }];
    loaded.failUrls = ['u-bad'];
    const api = harness();
    await waitFor(() => expect(api.subs).toHaveLength(1));
    act(() => api.setCurrentSub('eng:0'));
    await waitFor(() => expect(api.subUrl).toBe('blob:u-good'));
    expect(loaded.calls.map(c => c.url)).toEqual(['u-bad', 'u-good']);
  });
});
