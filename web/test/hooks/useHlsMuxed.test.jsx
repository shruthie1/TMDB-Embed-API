import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { buildTs, CASTLE } from '../fixtures/ts';

// hls.js stand-in WITH a DefaultConfig loader, so the hook's fragment loader
// is installed exactly as in the browser. `fragment()` pushes bytes through
// whatever fLoader the hook configured, the way hls.js would.
const made = { last: null };
class BaseLoader {
  load(context, _cfg, callbacks) { callbacks.onSuccess({ data: context.__bytes }, {}, context, null); }
}
class FakeHls {
  static Events = { MANIFEST_PARSED: 'm', LEVEL_SWITCHED: 's', ERROR: 'e',
    AUDIO_TRACKS_UPDATED: 'atu', AUDIO_TRACK_SWITCHED: 'ats' };
  static isSupported = () => true;
  static DefaultConfig = { loader: BaseLoader };
  constructor(cfg) {
    this.cfg = cfg; this.levels = [{ height: 720 }]; this.audioTracks = []; this.audioTrack = -1;
    this.manualLevel = -1; this.levelSets = []; this.h = {}; made.last = this;
  }
  set currentLevel(v) { this.levelSets.push(v); }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); }
  emit(ev, d) { (this.h[ev] || []).forEach((f) => f(ev, d)); }
  loadSource() {} attachMedia() {} destroy() {} detachMedia() {}
  fragment(u8, type = 'main') {
    const Loader = this.cfg.fLoader;
    let out = null;
    new Loader().load({ frag: { type }, __bytes: u8.buffer }, {},
      { onSuccess: (r) => { out = new Uint8Array(r.data); }, onError() {}, onTimeout() {} });
    return out;
  }
}
vi.mock('hls.js', () => ({ default: FakeHls }));
vi.mock('../../lib/subtitles', async (orig) => await orig());
const { useHls } = await import('../../lib/player/useHls');

function harness(props = {}) {
  const api = {};
  const videoRef = { current: Object.assign(document.createElement('video'), { canPlayType: () => '' }) };
  const stream = { masterUrl: 'https://x/castle.m3u8' };
  function Probe() { Object.assign(api, useHls({ videoRef, stream, ...props })); return null; }
  render(<Probe />);
  return api;
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const audioPidOfPacket = (u8, i) => ((u8[i * 188 + 1] & 0x1f) << 8) | u8[i * 188 + 2];
// hls.js reads the first AAC PID (0x101). Find the packet that now carries
// that PID; its payload marker says whose audio it really is.
const slotCarries = (u8) => {
  for (let i = 0; i * 188 < u8.length; i += 1) {
    if (audioPidOfPacket(u8, i) === 0x101) return (u8[i * 188 + 5] << 8) | u8[i * 188 + 6];
  }
  return -1;
};

beforeEach(() => { made.last = null; });

describe('useHls - audio muxed inside MPEG-TS (CastleTV, 1508168)', () => {
  it('exposes the five tracks the playlist never declares', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    act(() => { made.last.emit('m', { audioTracks: [] }); made.last.fragment(buildTs(CASTLE)); });
    expect(api.audioTracks.map((t) => t.name)).toEqual(['Hindi', 'Malayalam', 'Tamil', 'Telugu', 'Kannada']);
  });

  it('starts in Telugu, already on the first fragment', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    let out;
    act(() => { out = made.last.fragment(buildTs(CASTLE)); });
    expect(api.currentAudio).toBe(3);
    expect(slotCarries(out)).toBe(0x104);           // hls.js's slot now holds Telugu
    expect(audioPidOfPacket(out, 2)).toBe(0x100);   // video untouched
  });

  it('a late empty rendition list does not wipe the muxed tracks', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    act(() => { made.last.fragment(buildTs(CASTLE)); made.last.emit('atu', { audioTracks: [] }); });
    expect(api.audioTracks).toHaveLength(5);
    expect(api.currentAudio).toBe(3);
  });

  it('switching re-routes later fragments and refetches, keeping the quality mode', async () => {
    const onLanguage = vi.fn();
    const api = harness({ preferredLanguage: 'Telugu', onLanguage });
    await flush();
    act(() => { made.last.fragment(buildTs(CASTLE)); });
    let ok;
    act(() => { ok = api.pickAudio(4); });
    expect(ok).toBe(true);
    expect(api.currentAudio).toBe(4);
    expect(made.last.levelSets).toEqual([-1]);      // flush + reload, still auto
    expect(onLanguage).toHaveBeenCalledWith('Kannada');
    expect(slotCarries(made.last.fragment(buildTs(CASTLE)))).toBe(0x105);
  });

  it('picking the default track plays the bytes unchanged', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    act(() => { made.last.fragment(buildTs(CASTLE)); });
    act(() => { api.pickAudio(0); });
    const orig = buildTs(CASTLE);
    expect(made.last.fragment(orig.slice())).toEqual(orig);
  });

  it('refuses an out-of-range pick so the caller can fall through', async () => {
    const api = harness();
    await flush();
    act(() => { made.last.fragment(buildTs(CASTLE)); });
    expect(api.pickAudio(9)).toBe(false);
    expect(made.last.levelSets).toEqual([]);
  });

  it('declared #EXT-X-MEDIA renditions win; the TS is left alone', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    let out;
    act(() => {
      made.last.audioTracks = [{ lang: 'hin' }, { lang: 'tel' }];
      made.last.emit('m', { audioTracks: made.last.audioTracks });
      out = made.last.fragment(buildTs(CASTLE));
    });
    expect(api.audioTracks.map((t) => t.name)).toEqual(['Hindi', 'Telugu']);
    expect(slotCarries(out)).toBe(0x101);
  });

  it('a single-track TS adds nothing and changes nothing', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    const one = buildTs([{ pid: 0x101, lang: 'tel' }]);
    let out;
    act(() => { out = made.last.fragment(one.slice()); });
    expect(api.audioTracks).toEqual([]);
    expect(out).toEqual(one);
  });

  it('audio-playlist fragments are never touched', async () => {
    const api = harness({ preferredLanguage: 'Telugu' });
    await flush();
    const orig = buildTs(CASTLE);
    let out;
    act(() => { out = made.last.fragment(orig.slice(), 'audio'); });
    expect(api.audioTracks).toEqual([]);
    expect(out).toEqual(orig);
  });
});
