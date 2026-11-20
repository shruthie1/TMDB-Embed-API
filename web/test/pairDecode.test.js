import { describe, it, expect, vi, afterEach } from 'vitest';
import { pairDecodable } from '../lib/player/codecSupport';
import { pairSources } from '../lib/backend';

// docs/PENDING-WORK.md H8: /hybrid/pair answered 200 even when this browser
// could not decode the fused master, and the player switched into a black or
// silent stream. The server now states the codecs; the player asks first.
const CHROME_ANDROID = { isTypeSupported: (t) => /avc1|mp4a/.test(t), canPlayType: null };
const ALL = { isTypeSupported: () => true, canPlayType: null };

describe('pairDecodable (H8)', () => {
  it('refuses an HEVC-only pair where MediaSource has no HEVC', () => {
    expect(pairDecodable({ video: ['hvc1.1.6.L150.90'], audio: 'mp4a.40.2' }, CHROME_ANDROID)).toBe(false);
  });
  it('refuses an AC-3 donor where MediaSource has no AC-3', () => {
    expect(pairDecodable({ video: ['avc1.640028'], audio: 'ac-3' }, CHROME_ANDROID)).toBe(false);
  });
  it('accepts when any one video level decodes with the audio (hls.js drops the rest)', () => {
    expect(pairDecodable({ video: ['hvc1.1.6.L150.90', 'avc1.640028'], audio: 'mp4a.40.2' }, CHROME_ANDROID)).toBe(true);
  });
  it('accepts a browser that decodes everything', () => {
    expect(pairDecodable({ video: ['hvc1.1.6.L150.90'], audio: 'ec-3' }, ALL)).toBe(true);
  });
  it('says unknown (null) when the server stated nothing or there is no way to ask', () => {
    expect(pairDecodable(null, ALL)).toBe(null);
    expect(pairDecodable({ video: [], audio: null }, ALL)).toBe(null);
    expect(pairDecodable({ video: ['hvc1.1.6.L150.90'], audio: 'mp4a.40.2' }, {})).toBe(null);
  });
});

describe('pairSources (H6/H8)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('posts each side\'s stated codecs and returns the pair\'s codecs', async () => {
    let sent;
    vi.stubGlobal('fetch', async (_u, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ url: 'http://x/hybrid/1/master.m3u8', codecs: { video: ['hvc1.1.6.L150.90'], audio: 'mp4a.40.2' } }));
    });
    const out = await pairSources(
      { masterUrl: 'http://v/m.m3u8', provider: 'mapple', codecString: 'hvc1.1.6.L150.90,mp4a.40.2' },
      { masterUrl: 'http://a/m.m3u8', provider: 'CastleTV', codecString: null },
    );
    expect(sent.video.codecs).toBe('hvc1.1.6.L150.90,mp4a.40.2');
    expect(sent.audio.codecs).toBeUndefined();
    expect(out.codecs).toEqual({ video: ['hvc1.1.6.L150.90'], audio: 'mp4a.40.2' });
  });
});
