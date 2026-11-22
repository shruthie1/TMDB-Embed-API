import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Hls from 'hls.js';
import { cachedPlaylistLoader, clearPlaylists, getPlaylist, putPlaylist, isVodPlaylist, playlistCacheSize } from '../../lib/player/playlistCache';
import { forgetTitleStreams } from '../../lib/backend';

// P3 + P4 (2026-11-22), against the REAL hls.js 1.7.1 (no media attached):
// playlists of kept rows come from memory, and the video and audio media
// playlists are asked for in parallel.

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Telugu",LANGUAGE="tel",DEFAULT=YES,AUTOSELECT=YES,URI="audio_te.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hindi",LANGUAGE="hin",DEFAULT=NO,AUTOSELECT=YES,URI="audio_hi.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,AUDIO="aud"',
  'v480.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
  'v1080.m3u8',
].join('\n');
const MEDIA = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-VERSION:3', '#EXTINF:6.0,', 'seg0.ts', '#EXTINF:6.0,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n');
const BASE = 'https://cdn.test/t/';

// A network stand-in: records every request, answers after `delayMs`.
function makeNet(delayMs = 50) {
  const net = { requests: [], inflightMax: 0, inflight: 0 };
  class NetLoader {
    constructor() { this.stats = { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } }; }
    load(context, _config, callbacks) {
      this.context = context;
      net.requests.push({ url: context.url, at: Date.now() });
      net.inflight += 1; net.inflightMax = Math.max(net.inflightMax, net.inflight);
      this.timer = setTimeout(() => {
        net.inflight -= 1;
        const name = context.url.slice(BASE.length);
        const data = name === 'master.m3u8' ? MASTER : MEDIA;
        this.stats.loaded = this.stats.total = data.length;
        const now = performance.now();
        this.stats.loading = { start: now, first: now, end: now };
        callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
      }, delayMs);
    }
    abort() { clearTimeout(this.timer); }
    destroy() { clearTimeout(this.timer); }
    getCacheAge() { return null; }
    getResponseHeader() { return null; }
  }
  return { net, NetLoader };
}

async function playOnce(NetLoader, { cached = true } = {}) {
  const hls = new Hls({ pLoader: cached ? cachedPlaylistLoader(NetLoader) : NetLoader, debug: false });
  const levelsLoaded = new Promise((resolve) => {
    let video = false; let audio = false;
    const done = () => { if (video && audio) resolve(); };
    hls.on(Hls.Events.LEVEL_LOADED, () => { video = true; done(); });
    hls.on(Hls.Events.AUDIO_TRACK_LOADED, () => { audio = true; done(); });
  });
  hls.loadSource(`${BASE}master.m3u8`);
  await levelsLoaded;
  hls.destroy();
}

let logs;
beforeEach(() => {
  clearPlaylists();
  logs = [];
  vi.spyOn(console, 'info').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('playlist cache (P3)', () => {
  it('a second Play of the same rows fetches 0 playlists', async () => {
    const { net, NetLoader } = makeNet();
    await playOnce(NetLoader);
    const first = net.requests.length;
    expect(first).toBe(3);   // master + one video + one audio playlist
    await playOnce(NetLoader);
    expect(net.requests.length).toBe(first);
    expect(logs.filter((l) => l.startsWith('[cache] hit playlist:')).length).toBe(3);
  });

  it('a failed row clears the kept playlists', async () => {
    const { net, NetLoader } = makeNet();
    await playOnce(NetLoader);
    forgetTitleStreams('movie', 1, { reason: 'row-failed' });
    expect(playlistCacheSize()).toBe(0);
    await playOnce(NetLoader);
    expect(net.requests.length).toBe(6);
  });

  it('keeps only VOD text: master or media with ENDLIST', () => {
    expect(isVodPlaylist(MASTER)).toBe(true);
    expect(isVodPlaylist(MEDIA)).toBe(true);
    expect(isVodPlaylist(MEDIA.replace('#EXT-X-ENDLIST', ''))).toBe(false);
    expect(putPlaylist('https://x/live.m3u8', MEDIA.replace('#EXT-X-ENDLIST', ''))).toBe(false);
  });

  it('honours the url expiry and the 30 min TTL', () => {
    const t0 = 1_763_800_000_000;
    const exp = Math.floor((t0 + 120_000) / 1000);
    putPlaylist(`https://x/a.m3u8?Expires=${exp}`, MEDIA, undefined, t0);
    expect(getPlaylist(`https://x/a.m3u8?Expires=${exp}`, t0 + 60_000)).not.toBeNull();
    expect(getPlaylist(`https://x/a.m3u8?Expires=${exp}`, t0 + 100_000)).toBeNull();
    putPlaylist('https://x/b.m3u8', MEDIA, undefined, t0);
    expect(getPlaylist('https://x/b.m3u8', t0 + 29 * 60_000)).not.toBeNull();
    expect(getPlaylist('https://x/b.m3u8', t0 + 30 * 60_000 + 1)).toBeNull();
  });
});

describe('video and audio playlists in parallel (P4)', () => {
  it('hls.js asks for both media playlists before either answers', async () => {
    const { net, NetLoader } = makeNet(80);
    await playOnce(NetLoader, { cached: false });
    const media = net.requests.filter((r) => !r.url.endsWith('master.m3u8'));
    expect(media.map((r) => r.url.slice(BASE.length)).sort()).toEqual(['audio_te.m3u8', 'v480.m3u8']);
    expect(net.inflightMax).toBe(2);
    expect(Math.abs(media[0].at - media[1].at)).toBeLessThan(20);
  });
});
