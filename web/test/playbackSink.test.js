import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportPlayback } from '../lib/api';

const nextConfig = readFileSync(fileURLToPath(new URL('../next.config.mjs', import.meta.url)), 'utf8');

afterEach(() => { vi.unstubAllGlobals(); });

describe('reportPlayback sink', () => {
  it('POSTs every field the learning layer needs, with keepalive', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    reportPlayback({ mediaType: 'tv', tmdbId: 1399, season: 1, episode: 2, provider: 'CastleTV', ok: true,
      startupMs: 900, stallCount: 1, stallMs: 300, recoveryCount: 0, device: 'mobile',
      mediaUrl: '/m3u8-proxy?url=https%3A%2F%2Fcdn.x%2Fa.m3u8', audioLang: 'Telugu', langOk: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/playback-report');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ tmdbId: 1399, type: 'tv', season: 1, episode: 2, provider: 'CastleTV',
      playedOk: true, startupMs: 900, stallCount: 1, stallMs: 300, recoveryCount: 0,
      audioLang: 'Telugu', langOk: false, device: 'mobile' });
    expect(body).toHaveProperty('mediaIdentity');
    expect(body.mediaUrl).toContain('m3u8-proxy');
  });

  it('sends langOk as null unless the caller states a boolean', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    reportPlayback({ mediaType: 'movie', tmdbId: 1, provider: 'x', ok: false });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).langOk).toBeNull();
  });

  it('swallows a failed POST and a throwing fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect(() => reportPlayback({ mediaType: 'movie', tmdbId: 1, provider: 'x', ok: true })).not.toThrow();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('boom'); }));
    expect(() => reportPlayback({ mediaType: 'movie', tmdbId: 1, provider: 'x', ok: true })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('sends nothing without a provider or title', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    reportPlayback({ mediaType: 'movie', tmdbId: 1, provider: null, ok: true });
    reportPlayback({ mediaType: 'movie', tmdbId: 0, provider: 'x', ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is routed to the Express backend, not answered by Next', () => {
    expect(nextConfig).toMatch(/source: '\/api\/playback-report',\s*destination: `\$\{origin\}\/api\/playback-report`/);
  });
});
