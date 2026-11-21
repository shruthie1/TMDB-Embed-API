import { describe, it, expect } from 'vitest';
import { endpoint, sourcesFromResponse } from '../lib/backend';
import { vaEmbedChoice, shouldAutoEmbed } from '../lib/player/vaEmbed';

// Owner rule 2026-11-21: mapple and VaPlayer are APK-only. The browser never
// asks the server for them, never shows their rows, and never offers the
// VaPlayer embed ("VaPlayer (embed)", "Their player").
const row = (provider) => ({ provider, quality: '1080p', container: 'hls',
  url: `http://vm/m3u8-proxy?url=https%3A%2F%2F${provider}.example%2Fm.m3u8`, languages: ['Telugu'] });

describe('web surface', () => {
  it('tells the server it is the web, on the aggregate and single-provider routes', () => {
    expect(endpoint('movie', 1, {})).toBe('/api/streams/movie/1?client=web');
    expect(endpoint('tv', 2, { season: 1, episode: 3, full: true }))
      .toBe('/api/streams/series/2?season=1&episode=3&full=1&client=web');
    expect(endpoint('movie', 1, { provider: 'netmirror' })).toBe('/api/streams/netmirror/movie/1?client=web');
  });

  it('drops mapple and VaPlayer rows even if a cached or old answer has them', () => {
    const got = sourcesFromResponse({ streams: [row('CastleTV'), row('mapple'), row('VaPlayer'), row('Mapple · s12')] });
    expect(got.map((s) => s.provider)).toEqual(['CastleTV']);
  });

  it('offers no VaPlayer embed row', () => {
    const embed = vaEmbedChoice({ imdbId: 'tt11821912', mediaType: 'movie' });
    expect(embed).toBeNull();
    // and so never switches to it on its own, even with zero sources
    expect(shouldAutoEmbed({ embed, error: { message: 'none' }, sources: [] })).toBe(false);
  });
});
