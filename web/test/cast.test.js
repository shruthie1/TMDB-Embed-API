import { describe, it, expect, vi } from 'vitest';
import {
  WVC_PACKAGE, HLS_MIME, castMime, wvcSchemeLink, wvcIntentLink, castLink, canCast, isAndroidChrome, castBody, prepareCast,
} from '../lib/cast';

// C3 (docs/PENDING-WORK.md): cast to a TV through Web Video Caster (WVC).
// Link formats from https://www.webvideocaster.com/integrations.

const URL1 = 'https://tmdb-187-127-137-163.sslip.io/cast/0123456789abcdef01234567.m3u8';
const META = { title: 'Devara: Part 1', poster: 'https://image.tmdb.org/t/p/w500/x.jpg' };

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  androidTv: 'Mozilla/5.0 (Linux; Android 11; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  tablet: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

describe('WVC links', () => {
  it('scheme link carries url, title, poster and the HLS mime type', () => {
    const link = wvcSchemeLink(URL1, META);
    expect(link.startsWith('wvc-x-callback://open?')).toBe(true);
    const q = new URLSearchParams(link.split('?')[1]);
    expect(q.get('url')).toBe(URL1);
    expect(q.get('title')).toBe('Devara: Part 1');
    expect(q.get('poster')).toBe(META.poster);
    expect(q.get('mime_type')).toBe('application/vnd.apple.mpegurl');
    // WVC's own examples use %20, not '+'.
    expect(link).not.toContain('+');
    expect(link).toContain('Devara%3A%20Part%201');
  });

  it('intent link targets the WVC package with a Play Store fallback', () => {
    const link = wvcIntentLink(URL1, META);
    expect(link).toMatch(/^intent:\/\/tmdb-187-127-137-163\.sslip\.io\/cast\/0123456789abcdef01234567\.m3u8#Intent;/);
    expect(link).toContain('scheme=https;');
    expect(link).toContain('action=android.intent.action.VIEW;');
    expect(link).toContain('type=application/vnd.apple.mpegurl;');
    expect(link).toContain(`package=${WVC_PACKAGE};`);
    expect(link).toContain(`S.title=${encodeURIComponent('Devara: Part 1')};`);
    expect(link).toContain(`S.poster=${encodeURIComponent(META.poster)};`);
    expect(link).toContain(`S.browser_fallback_url=${encodeURIComponent(`https://play.google.com/store/apps/details?id=${WVC_PACKAGE}`)};`);
    expect(link.endsWith(';end')).toBe(true);
  });

  // Measured on the phone 2026-11-22 (cmd package query-activities, WVC 6.2.0):
  // application/x-mpegURL matches NO WVC activity (MIME match is
  // case-sensitive), so Chrome took S.browser_fallback_url = the Play Store
  // with WVC installed. These types match .WebBrowser.
  const WVC_MATCHING = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'video/mp4'];
  it('the intent type is lowercase and one WVC matches', () => {
    expect(HLS_MIME).toBe('application/vnd.apple.mpegurl');
    for (const mime of [undefined, 'application/x-mpegURL', 'VIDEO/MP4']) {
      const type = wvcIntentLink(URL1, { ...META, mime }).match(/;type=([^;]+);/)[1];
      expect(type).toBe(type.toLowerCase());
      expect(WVC_MATCHING).toContain(type);
      const q = new URLSearchParams(wvcSchemeLink(URL1, { ...META, mime }).split('?')[1]);
      expect(WVC_MATCHING).toContain(q.get('mime_type'));
    }
  });

  it('a DASH type never reaches an intent: application/dash+xml matches nothing', () => {
    expect(() => castMime('application/dash+xml')).toThrow(/VM HLS/);
    expect(() => wvcIntentLink('https://x/index.mpd', { mime: 'application/dash+xml' })).toThrow(/VM HLS/);
    expect(castMime('application/x-mpegURL')).toBe('application/vnd.apple.mpegurl');
  });

  it('Android Chrome gets the intent link, other phones the scheme link', () => {
    expect(isAndroidChrome(UA.androidChrome)).toBe(true);
    expect(isAndroidChrome(UA.androidFirefox)).toBe(false);
    expect(castLink(URL1, META, UA.androidChrome)).toMatch(/^intent:\/\//);
    expect(castLink(URL1, META, UA.iphone)).toMatch(/^wvc-x-callback:\/\//);
    expect(castLink(URL1, META, UA.androidFirefox)).toMatch(/^wvc-x-callback:\/\//);
  });
});

describe('canCast: phone only', () => {
  it('shows on phones', () => {
    expect(canCast({ ua: UA.androidChrome, tv: false })).toBe(true);
    expect(canCast({ ua: UA.iphone, tv: false })).toBe(true);
  });
  it('hides on desktop, TV and tablets', () => {
    expect(canCast({ ua: UA.desktop, tv: false })).toBe(false);
    expect(canCast({ ua: UA.androidTv, tv: false })).toBe(false);
    expect(canCast({ ua: UA.androidChrome, tv: true })).toBe(false);
    expect(canCast({ ua: UA.tablet, tv: false })).toBe(false);
  });
});

describe('castBody', () => {
  const video = { id: 'v', masterUrl: 'https://api/m3u8-proxy?url=v', provider: 'OneTouchTV', quality: 'Auto' };
  const audio = { id: 'a', masterUrl: 'https://api/castle-demux/abc/master.m3u8', provider: 'CastleTV', quality: '720p', codecString: 'avc1.64001f,mp4a.40.2' };

  it('a paired stream casts the pair, not the 20-minute /hybrid master', () => {
    const body = castBody({
      stream: { masterUrl: 'https://api/hybrid/x/master.m3u8', hybrid: true },
      pair: { video, audio }, tmdbId: 811941, mediaType: 'movie', title: 'Devara', nudge: 0.5,
    });
    expect(body.url).toBeUndefined();
    expect(body.pair.video).toEqual({ url: video.masterUrl, provider: 'OneTouchTV', quality: 'Auto' });
    expect(body.pair.audio).toEqual({ url: audio.masterUrl, provider: 'CastleTV', quality: '720p', codecs: 'avc1.64001f,mp4a.40.2' });
    expect(body).toMatchObject({ tmdbId: 811941, type: 'movie', title: 'Devara', nudge: 0.5 });
  });

  it('a plain stream casts its url', () => {
    const body = castBody({ stream: { masterUrl: 'https://api/m3u8-proxy?url=x' }, tmdbId: 1, mediaType: 'tv', title: 'S' });
    expect(body).toEqual({ url: 'https://api/m3u8-proxy?url=x', tmdbId: 1, type: 'series', title: 'S' });
  });
});

describe('prepareCast', () => {
  it('posts to /cast and returns the WVC link for the served master', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'x', url: URL1, audio: { language: 'tel' } })));
    const out = await prepareCast({ body: { url: 'u' }, meta: META, ua: UA.androidChrome, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('/cast', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ url: 'u' });
    expect(out.url).toBe(URL1);
    expect(out.href).toBe(castLink(URL1, META, UA.androidChrome));
  });

  it('a refusal throws with the server reason', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ reason: 'not pairable' }), { status: 409 });
    await expect(prepareCast({ body: {}, meta: META, ua: UA.iphone, fetchImpl })).rejects.toThrow(/not pairable/);
  });
});
