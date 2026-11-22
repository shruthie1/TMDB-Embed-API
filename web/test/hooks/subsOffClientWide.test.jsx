import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

// Owner 2026-11-22: an "off" is a client-wide choice. It must survive a new
// title, the next episode, and a provider switch or refresh (a fresh player).
const byTitle = {};
vi.mock('../../lib/subtitles', () => ({
  listSubtitles: async ({ imdbId, episode }) => byTitle[`${imdbId}:${episode}`] || [],
  loadTrack: async (url) => `blob:${url}`,
  getSubPrefs: () => ({ scale: 1, offsetMs: 0 }),
  setSubPrefs: (p) => ({ scale: 1, offsetMs: 0, ...p }),
}));
URL.revokeObjectURL = () => {};

const { useSubtitles } = await import('../../lib/player/useSubtitles');

function mount(props) {
  let latest = {};
  function Probe(p) { latest = useSubtitles(p); return null; }
  const r = render(<Probe {...props} />);
  const api = new Proxy({}, { get: (_t, k) => latest[k] });
  return { api, rerender: (p) => r.rerender(<Probe {...p} />), unmount: r.unmount };
}
const tick = () => new Promise(r => setTimeout(r, 20));

beforeEach(() => {
  localStorage.clear();
  for (const k of Object.keys(byTitle)) delete byTitle[k];
  byTitle['ttA:0'] = [{ id: 'eng:a', lang: 'eng', name: 'English', url: 'uA' }];
  byTitle['ttB:0'] = [{ id: 'eng:b', lang: 'eng', name: 'English', url: 'uB' }];
  byTitle['ttS:1'] = [{ id: 'eng:s1', lang: 'eng', name: 'English', url: 'uS1' }];
  byTitle['ttS:2'] = [{ id: 'eng:s2', lang: 'eng', name: 'English', url: 'uS2' }];
});

describe('subtitles off is remembered client-wide', () => {
  it('fresh client: auto-picks the best track as before', async () => {
    const { api } = mount({ imdbId: 'ttA' });
    await waitFor(() => expect(api.currentSub).toBe('eng:a'));
  });

  it('off on title A -> title B (same player) starts with no subtitles', async () => {
    const m = mount({ imdbId: 'ttA' });
    await waitFor(() => expect(m.api.currentSub).toBe('eng:a'));
    act(() => m.api.setCurrentSub(null));
    m.rerender({ imdbId: 'ttB' });
    await waitFor(() => expect(m.api.subs[0]?.id).toBe('eng:b'));
    await tick();
    expect(m.api.currentSub).toBe(null);
    expect(m.api.subUrl).toBe(null);
  });

  it('off on title A -> title B (new player page) starts with no subtitles', async () => {
    const a = mount({ imdbId: 'ttA' });
    await waitFor(() => expect(a.api.currentSub).toBe('eng:a'));
    act(() => a.api.setCurrentSub(null));
    a.unmount();
    const b = mount({ imdbId: 'ttB' });
    await waitFor(() => expect(b.api.subs).toHaveLength(1));
    await tick();
    expect(b.api.currentSub).toBe(null);
  });

  it('off -> next episode starts with no subtitles', async () => {
    const m = mount({ imdbId: 'ttS', season: 1, episode: 1 });
    await waitFor(() => expect(m.api.currentSub).toBe('eng:s1'));
    act(() => m.api.setCurrentSub(null));
    m.rerender({ imdbId: 'ttS', season: 1, episode: 2 });
    await waitFor(() => expect(m.api.subs[0]?.id).toBe('eng:s2'));
    await tick();
    expect(m.api.currentSub).toBe(null);
  });

  it('off -> provider switch / refresh (player remount, same title) stays off', async () => {
    const a = mount({ imdbId: 'ttA' });
    await waitFor(() => expect(a.api.currentSub).toBe('eng:a'));
    act(() => a.api.setCurrentSub(null));
    a.unmount();
    const again = mount({ imdbId: 'ttA' });
    await waitFor(() => expect(again.api.subs).toHaveLength(1));
    await tick();
    expect(again.api.currentSub).toBe(null);
  });

  it('turned ON again explicitly -> next title auto-picks as before', async () => {
    const a = mount({ imdbId: 'ttA' });
    await waitFor(() => expect(a.api.currentSub).toBe('eng:a'));
    act(() => a.api.setCurrentSub(null));
    act(() => a.api.setCurrentSub('eng:a'));
    a.unmount();
    const b = mount({ imdbId: 'ttB' });
    await waitFor(() => expect(b.api.currentSub).toBe('eng:b'));
  });
});
