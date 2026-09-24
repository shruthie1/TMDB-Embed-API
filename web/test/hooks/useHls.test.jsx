import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';

// A minimal hls.js stand-in that records what the hook asks of it.
const made = { last: null };
class FakeHls {
  static Events = { MANIFEST_PARSED:'m', LEVEL_SWITCHED:'s', ERROR:'e',
    AUDIO_TRACKS_UPDATED:'atu', AUDIO_TRACK_SWITCHED:'ats' };
  static isSupported = () => true;
  constructor(cfg){ this.cfg=cfg; this.levels=[]; this.audioTracks=[];
    this.currentLevel=-1; this.nextLevel=-1; this.autoLevelCapping=-1;
    this.audioTrack=0; this.h={}; made.last=this; }
  on(ev,fn){ (this.h[ev] ||= []).push(fn); }
  emit(ev,d){ (this.h[ev]||[]).forEach(f=>f(ev,d)); }
  loadSource(){} attachMedia(){} destroy(){}
}
vi.mock('hls.js', () => ({ default: FakeHls }));
vi.mock('../../lib/api', () => ({ playableUrl: (u) => u }));
// Use the REAL languageName. Mocking it to know only 'tel' hid the fact that
// HLS manifests carry ISO-639-1 ('te'), so live renditions rendered as "TE".
vi.mock('../../lib/subtitles', async (orig) => await orig());

const { useHls } = await import('../../lib/player/useHls');

function harness(stream, tweakVideo) {
  const api = {};
  const videoRef = { current: Object.assign(document.createElement('video'),
                     { canPlayType: () => '' }) };
  tweakVideo?.(videoRef.current);
  function Probe(){ Object.assign(api, useHls({ videoRef, stream })); return null; }
  render(<Probe />);
  return api;
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => { made.last = null; });

describe('useHls — quality', () => {
  it('exposes the ladder highest first once the manifest parses', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    act(() => { made.last.levels = [
      { height: 360, bitrate: 800000 }, { height: 1080, bitrate: 4000000 },
      { height: 2160, bitrate: 8000000 }];
      made.last.emit('m'); });
    expect(api.levels.map(l => l.label)).toEqual(['2160p', '1080p', '360p']);
  });

  // THE "0k" BADGE. CastleTV serves per-language MEDIA playlists (no
  // #EXT-X-STREAM-INF), so hls.js synthesises ONE level with height 0 and
  // bitrate 0. LEVEL_SWITCHED did Math.round(0/1000) and the control row
  // showed a meaningless "0k" while a 720p picture was playing.
  it('a level with no height and no bitrate never renders as "0k"', async () => {
    const api = harness({ masterUrl: 'https://x/media.m3u8' });
    await flush();
    act(() => {
      made.last.levels = [{ height: 0, bitrate: 0 }];
      made.last.emit('m');
      made.last.emit('s', { level: 0 });
    });
    expect(api.autoLevel).not.toBe('0k');
    expect(api.levels.map(l => l.label)).not.toContain('0k');
  });

  it('falls back to the decoded picture height when the manifest declares none', async () => {
    // jsdom leaves videoHeight at 0, so stub what the decoder would report.
    const api = harness({ masterUrl: 'https://x/media.m3u8' }, (v) =>
      Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true }));
    await flush();
    act(() => {
      made.last.levels = [{ height: 0, bitrate: 0 }];
      made.last.emit('m');
      made.last.emit('s', { level: 0 });
    });
    // The decoder knows it is 720p even though the playlist never said so.
    expect(api.autoLevel).toBe('720p');
    expect(api.levels[0].label).toBe('720p');
  });

  it('a real bitrate is still shown when height is absent', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    act(() => {
      made.last.levels = [{ height: 0, bitrate: 1500000 }];
      made.last.emit('m');
      made.last.emit('s', { level: 0 });
    });
    expect(api.autoLevel).toBe('1500k');
  });

  it('a picked rung STICKS via autoLevelCapping, not currentLevel', async () => {
    // The bug: `currentLevel = i` is declined while buffering and silently
    // reverts to -1, so the chosen quality never took effect. Capping holds.
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    act(() => { made.last.levels = [{ height: 360 }, { height: 1080 }]; made.last.emit('m'); });
    act(() => api.pickLevel(0));
    expect(made.last.autoLevelCapping).toBe(0);
    expect(made.last.nextLevel).toBe(0);
    expect(api.currentLevel).toBe(0);
  });

  it('auto releases the cap so ABR can climb again', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    act(() => { made.last.levels = [{ height: 360 }, { height: 1080 }]; made.last.emit('m'); });
    act(() => api.pickLevel(1));
    act(() => api.pickLevel(-1));
    expect(made.last.autoLevelCapping).toBe(-1);
    expect(made.last.currentLevel).toBe(-1);
    expect(api.currentLevel).toBe(-1);
  });

  it('index survives the display sort, so picking 360p picks level 0', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    act(() => { made.last.levels = [{ height: 360 }, { height: 720 }, { height: 2160 }];
      made.last.emit('m'); });
    const lowest = api.levels[api.levels.length - 1];
    expect(lowest.label).toBe('360p');
    act(() => api.pickLevel(lowest.index));
    expect(made.last.autoLevelCapping).toBe(0);
  });
});

describe('useHls — audio', () => {
  it('names a track by language rather than "Track 1"', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    // Real hls.js delivers renditions in the EVENT DATA. `hls.audioTracks` is
    // still empty at MANIFEST_PARSED, so a test that sets the property passes
    // while the app shows nothing - which is exactly what happened against
    // Shaka's Angel One (6 renditions, empty menu).
    act(() => made.last.emit('m', { audioTracks: [{ lang: 'tel' }, { name: 'Commentary' }] }));
    expect(api.audioTracks.map(t => t.name)).toEqual(['Telugu', 'Commentary']);
  });

  it('picks up renditions that only arrive on AUDIO_TRACKS_UPDATED', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    // Manifest parsed with no audio info at all...
    act(() => made.last.emit('m', {}));
    expect(api.audioTracks).toEqual([]);
    // ...then the track list lands separately, as it does for a real stream.
    act(() => made.last.emit('atu', { audioTracks: [{ lang: 'te' }, { lang: 'hi' }] }));
    expect(api.audioTracks.map(t => t.name)).toEqual(['Telugu', 'Hindi']);
  });

  it('follows the active track when hls.js switches it', async () => {
    const api = harness({ masterUrl: 'https://x/m.m3u8' });
    await flush();
    act(() => made.last.emit('m', { audioTracks: [{ lang: 'te' }, { lang: 'ta' }] }));
    act(() => made.last.emit('ats', { id: 1 }));
    expect(api.currentAudio).toBe(1);
  });
});
