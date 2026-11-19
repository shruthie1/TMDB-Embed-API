import { describe, it, expect } from 'vitest';
import { sampleNoPicture, ADVANCE_S, GRACE_MS } from '../lib/player/useNoPictureGuard';
import { videoCodecSupported, isUnsupported } from '../lib/player/codecSupport';
import { toSource, rankSources } from '../lib/backend';
import { fatalAction } from '../lib/player/fatalPolicy';
import { videoChoices } from '../lib/player/trackChoices';

// Prod 2026-11-19, The Paradise (1376856), Chrome 157 at Pixel 7: the mapple
// row is HEVC, MediaSource.isTypeSupported says false for hvc1/hev1, audio
// played over a black screen with no error.
const CHROME_ANDROID = { isTypeSupported: (t) => /avc1/.test(t), canPlayType: null };
const HEVC_OK = { isTypeSupported: () => true, canPlayType: null };

function el(over = {}) {
  let frames = over.frames ?? 0;
  return {
    paused: false, seeking: false, ended: false, currentTime: 0, videoWidth: 0,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: frames }),
    setFrames(n) { frames = n; },
    ...over,
  };
}

// Run one-second ticks, advancing the clock by `rate` media seconds each.
function run(v, ticks, { rate = 1, onTick } = {}) {
  const st = {};
  for (let i = 0; i < ticks; i += 1) {
    onTick?.(i, v);
    const r = sampleNoPicture(st, v, i * 1000);
    if (r !== 'wait') return { r, at: i };
    v.currentTime += rate;
  }
  return { r: 'wait', at: ticks };
}

describe('no-picture guard', () => {
  it('fires when audio advances with no video frame for the grace period', () => {
    const { r, at } = run(el(), 20);
    expect(r).toBe('fire');
    // Not before GRACE_MS of moving playback.
    expect(at * 1000).toBeGreaterThanOrEqual(GRACE_MS);
    expect(at).toBeLessThanOrEqual(9);
  });

  it('does not fire on a slow first frame that lands inside the grace period', () => {
    const { r } = run(el(), 20, { onTick: (i, v) => { if (i === 5) { v.videoWidth = 1920; v.setFrames(3); } } });
    expect(r).toBe('ok');
  });

  it('does not fire while loading (clock not moving) or paused', () => {
    expect(run(el(), 30, { rate: 0 }).r).toBe('wait');
    expect(run(el({ paused: true }), 30).r).toBe('wait');
  });

  it('a decoded frame counts even before videoWidth updates', () => {
    expect(run(el(), 20, { onTick: (i, v) => { if (i === 2) v.setFrames(10); } }).r).toBe('ok');
  });

  it('works without getVideoPlaybackQuality (videoWidth only)', () => {
    const v = el();
    delete v.getVideoPlaybackQuality;
    expect(run(v, 20).r).toBe('fire');
  });

  it('a seek restarts the measurement instead of counting as playback', () => {
    const st = {};
    const v = el();
    expect(sampleNoPicture(st, v, 0)).toBe('wait');
    v.currentTime = 2879; // a source switch restores position
    expect(sampleNoPicture(st, v, 1000)).toBe('wait');
    v.currentTime += 1;
    expect(sampleNoPicture(st, v, 2000)).toBe('wait');
    expect(st.baseTime).toBe(2879);
  });

  it('pauses the clock while the page is hidden', () => {
    const st = {};
    const v = el();
    for (let i = 0; i < 20; i += 1) {
      expect(sampleNoPicture(st, v, i * 1000, true)).toBe('wait');
      v.currentTime += 1;
    }
  });

  it('needs at least ADVANCE_S of media time', () => {
    expect(ADVANCE_S).toBe(3);
    // Slow creep: 0.1s per tick never reaches 3s inside 20 ticks.
    expect(run(el(), 20, { rate: 0.1 }).r).toBe('wait');
  });

  it('maps to a failover fatal action', () => {
    const a = fatalAction({ details: 'noVideoFrames', message: 'x' });
    expect(a).toMatchObject({ kind: 'novideo', failover: true });
  });
});

describe('codec support', () => {
  it('HEVC on Chrome Android is unsupported; avc and unknown are not flagged', () => {
    expect(videoCodecSupported({ videoCodec: 'hevc' }, CHROME_ANDROID)).toBe(false);
    expect(videoCodecSupported({ videoCodec: 'hevc', codecString: 'hvc1.1.6.L150.90,mp4a.40.2' }, CHROME_ANDROID)).toBe(false);
    expect(videoCodecSupported({ videoCodec: 'hevc' }, HEVC_OK)).toBe(true);
    expect(videoCodecSupported({ videoCodec: 'avc' }, CHROME_ANDROID)).toBe(true);
    expect(videoCodecSupported({ videoCodec: null }, CHROME_ANDROID)).toBe(null);
    expect(isUnsupported({ videoCodec: 'hevc' }, { isTypeSupported: null, canPlayType: null })).toBe(false);
  });

  it('uses the stated CODECS string when the row has one', () => {
    const asked = [];
    videoCodecSupported({ videoCodec: 'hevc', codecString: 'hev1.2.4.L120.B0,mp4a.40.2' },
      { isTypeSupported: (t) => { asked.push(t); return false; } });
    expect(asked).toEqual(['video/mp4; codecs="hev1.2.4.L120.B0"']);
  });

  it('falls back to canPlayType when there is no MediaSource (native HLS)', () => {
    expect(videoCodecSupported({ videoCodec: 'hevc' }, { isTypeSupported: null, canPlayType: () => 'probably' })).toBe(true);
    expect(videoCodecSupported({ videoCodec: 'hevc' }, { isTypeSupported: null, canPlayType: () => '' })).toBe(false);
  });
});

describe('ranking with an unsupported row', () => {
  // The Paradise as served: mapple 1080p HLS (HEVC) and NetMirror mp4 (H.264).
  const MAPPLE = { url: 'https://x/m3u8-proxy?url=a', provider: 'mapple', container: 'hls',
    levels: [{ height: 1080 }], videoCodec: 'hevc' };
  const NETMIRROR = { url: 'https://x/ts-proxy?url=b.mp4', provider: 'NetMirror', container: 'mp4', quality: '720p' };

  it('an unsupported HEVC row ranks after a playable mp4', () => {
    const rows = [MAPPLE, NETMIRROR].map(toSource).map((s) => (
      s.provider === 'mapple' ? { ...s, unsupported: true } : s));
    expect(rankSources(rows).map((s) => s.provider)).toEqual(['NetMirror', 'mapple']);
    expect(videoChoices(rows).map((c) => [c.label, c.unsupported])).toEqual([['NetMirror', false], ['mapple', true]]);
  });

  it('a supported HEVC row keeps its normal place (HLS before mp4)', () => {
    const rows = [MAPPLE, NETMIRROR].map(toSource).map((s) => ({ ...s, unsupported: false }));
    expect(rankSources(rows).map((s) => s.provider)).toEqual(['mapple', 'NetMirror']);
  });

  it('toSource carries videoCodec and the CODECS string', () => {
    const s = toSource({ ...MAPPLE, codecs: 'hvc1.1.6.L150.90,mp4a.40.2' });
    expect(s.videoCodec).toBe('hevc');
    expect(s.codecString).toBe('hvc1.1.6.L150.90,mp4a.40.2');
    expect(typeof s.unsupported).toBe('boolean');
  });
});
