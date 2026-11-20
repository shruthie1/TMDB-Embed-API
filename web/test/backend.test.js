import { describe, it, expect } from 'vitest';
import { toSource, rankSources, sourceHeight, playableUrl, proxiedSegment, sourcesFromResponse } from '../lib/backend';

// Real shapes from GET /api/streams/movie/1441228 (Irumudi), captured
// 2026-09-21 against the Express API in this repo.
const DEMUX = {
  url: 'http://localhost:8790/castle-demux/cd5b389232ff09e6ee7ea8e6/master.m3u8',
  provider: 'CastleTV', quality: '720p', container: 'hls', levels: [],
  languages: ['Hindi', 'Kannada', 'Malayalam', 'Tamil', 'Telugu'],
  audio: [{ language: 'Hindi' }, { language: 'Telugu' }], selectableAudio: true,
};
const PROXIED = {
  url: 'http://localhost:8790/m3u8-proxy?url=https%3A%2F%2Fimg1.noesw.com%2Fhls_mps%2Fx%2F720%2Findex.m3u8',
  provider: 'CastleTV', quality: '720p', container: 'hls',
  languages: ['Telugu'], audio: [], selectableAudio: false,
};

describe('toSource', () => {
  it('routes proxied HLS through hls.js, not <video src>', () => {
    // Regression: the url test saw ".m3u8" only inside the encoded `url=`
    // parameter and marked 4 of 5 real masters progressive, which would have
    // dropped the quality ladder and the audio menu - the whole point of this UI.
    expect(toSource(PROXIED).progressive).toBe(false);
    expect(toSource(DEMUX).progressive).toBe(false);
  });

  it('marks a genuinely progressive file progressive', () => {
    expect(toSource({ url: 'http://x/ts-proxy?url=a.mp4', container: 'mp4' }).progressive).toBe(true);
  });

  it('carries the fields the player menus are built from', () => {
    const s = toSource(DEMUX);
    expect(s.masterUrl).toBe(DEMUX.url);
    expect(s.selectableAudio).toBe(true);
    expect(s.audio).toHaveLength(2);
    expect(s.languages).toContain('Telugu');
    // The backend proxies upstream Referer itself, so none is sent.
    expect(s.referer).toBeNull();
  });

  it('rejects a stream with no url', () => {
    expect(toSource(null)).toBeNull();
    expect(toSource({ provider: 'X' })).toBeNull();
  });
});

describe('NetMirror supplemental catalog identity', () => {
  const netflix = { provider: 'NetMirror', url: 'https://proxy.test/m3u8-proxy?url=nf.m3u8', container: 'hls', quality: 'Auto', languages: ['Telugu'] };
  const prime = { ...netflix, url: 'https://proxy.test/m3u8-proxy?url=pv.m3u8', languages: ['Hindi', 'Telugu'], audio: [{ language: 'Hindi' }, { language: 'Telugu' }], selectableAudio: true };
  it('keeps the same source ID in the aggregate and supplemental responses', () => {
    expect(toSource(netflix, 9).id).toBe(toSource(netflix, 0).id);
    expect(toSource(prime, 10).id).toBe(toSource(prime, 0).id);
  });
  it('keeps distinct catalog/language rows distinct even at the same array index', () => {
    expect(toSource(netflix, 0).id).not.toBe(toSource(prime, 0).id);
    expect(toSource(prime).languages).toEqual(['Hindi', 'Telugu']);
    expect(toSource(prime).selectableAudio).toBe(true);
    expect(toSource(prime).progressive).toBe(false);
  });
});

// Shapes from GET /api/streams/movie/811941 (Devara) and 770906 (Salaar),
// captured 2026-09-22.
const HYBRID = {
  url: 'http://localhost:8790/hybrid/4aa862c9dda5d33363098276/master.m3u8',
  provider: 'showsst+CastleTV', quality: '1080p', container: 'hls',
  levels: [{ height: 804 }, { height: 536 }, { height: 268 }],
  languages: ['Kannada', 'Malayalam', 'Tamil', 'Telugu'],
  audio: [{ language: 'Telugu' }], selectableAudio: true, hybrid: true,
};
const HD_NO_TELUGU = {
  url: 'http://localhost:8790/m3u8-proxy?url=https%3A%2F%2Fapi.x%2Fa.m3u8',
  provider: 'showsst', quality: '1080p', container: 'hls',
  levels: [{ height: 1080 }], languages: [], audio: [], selectableAudio: false,
};
const SD_TELUGU = {
  url: 'http://localhost:8790/m3u8-proxy?url=https%3A%2F%2Fimg1.x%2F720%2Fi.m3u8',
  provider: 'CastleTV', quality: '720p', container: 'hls',
  levels: [{ height: 720 }], languages: ['Telugu'], audio: [], selectableAudio: false,
};

describe('rankSources', () => {
  it('prefers a stream with a real audio menu over a single-track one', () => {
    // Both "have" Telugu; only one lets the viewer switch to it.
    const ranked = rankSources([toSource(PROXIED, 1), toSource(DEMUX, 0)]);
    expect(ranked[0].selectableAudio).toBe(true);
  });

  // The whole point of the hybrid: best video AND the preferred language, in
  // sync. It must outrank a plain stream that has only one of the two.
  it('a hybrid outranks everything else', () => {
    const ranked = rankSources([
      toSource(HD_NO_TELUGU, 0), toSource(DEMUX, 1), toSource(HYBRID, 2),
    ]);
    expect(ranked[0].hybrid).toBe(true);
  });

  // Measured 2026-09-22: 4 of 16 Telugu titles (Salaar, RRR, Saaho, Maharshi)
  // carry Telugu ONLY below HD. The standing requirement is the LANGUAGE, so
  // resolution is what gets spent - never the other way round.
  it('720p in the preferred language beats 1080p without it', () => {
    const ranked = rankSources([toSource(HD_NO_TELUGU, 0), toSource(SD_TELUGU, 1)]);
    expect(ranked[0].languages).toContain('Telugu');
    expect(ranked[0].quality).toBe('720p');
  });

  // 5 of the 16 have no Telugu at all. Playing something beats refusing.
  it('falls back to the best available when no source has the language', () => {
    const ranked = rankSources([toSource(HD_NO_TELUGU, 0)]);
    expect(ranked[0].quality).toBe('1080p');
  });

  // Resolution breaks ties INSIDE a tier, never across one.
  it('within a tier the server order is preserved (quality comes from the server score)', () => {
    const lo = { ...HD_NO_TELUGU, quality: '480p', levels: [{ height: 480 }] };
    const ranked = rankSources([toSource(lo, 0), toSource(HD_NO_TELUGU, 1)]);
    expect(ranked.map((s) => s.quality)).toEqual(['480p', '1080p']);
    const flipped = rankSources([toSource(HD_NO_TELUGU, 0), toSource(lo, 1)]);
    expect(flipped.map((s) => s.quality)).toEqual(['1080p', '480p']);
  });

  it('ranking does not mutate the array it was given', () => {
    const input = [toSource(HD_NO_TELUGU, 0), toSource(HYBRID, 1)];
    const before = input.map((s) => s.id);
    rankSources(input);
    expect(input.map((s) => s.id)).toEqual(before);
  });
});

describe('sourceHeight', () => {
  it('reads the measured ladder in preference to the quality label', () => {
    expect(sourceHeight({ levels: [{ height: 804 }, { height: 536 }], quality: '1080p' })).toBe(804);
  });
  it('falls back to the quality label when no ladder is known', () => {
    expect(sourceHeight({ levels: [], quality: '720p' })).toBe(720);
  });
  it('is 0 when nothing is known, so it sorts last rather than first', () => {
    expect(sourceHeight({ levels: [], quality: 'Auto' })).toBe(0);
    expect(sourceHeight({})).toBe(0);
  });
});

describe('url helpers', () => {
  it('pass through - the backend already proxied these', () => {
    const u = 'http://localhost:8790/m3u8-proxy?url=abc';
    // Wrapping again would produce a relay pointed at a relay.
    expect(playableUrl(u)).toBe(u);
    expect(proxiedSegment(u)).toBe(u);
  });
});


describe('NetMirror catalog metadata and partial coverage', () => {
  const row = { provider: 'NetMirror', url: 'https://x/nf.m3u8', container: 'hls', languages: ['Hindi'], audio: [{ language: 'Hindi' }], catalogLanguages: ['Hindi', 'Telugu', 'Tamil'], selectableAudio: true };
  it('keeps catalog display languages separate from actual playable tracks', () => {
    const [source] = sourcesFromResponse({ streams: [row] });
    expect(source.catalogLanguages).toEqual(['Hindi', 'Telugu', 'Tamil']);
    expect(source.languages).toEqual(['Hindi']);
    expect(source.audio).toEqual([{ language: 'Hindi' }]);
  });
  it('retains playable partial rows and clears the pending flag when coverage completes', () => {
    const [partial] = sourcesFromResponse({ streams: [row], providerError: 'netmirror-budget' });
    const [complete] = sourcesFromResponse({ streams: [row] });
    expect(partial.incomplete).toBe(true);
    expect(complete.incomplete).toBe(false);
    expect(partial.id).toBe(complete.id);
    const [aggregate] = sourcesFromResponse({ streams: [row], providerErrors: ['netmirror'] });
    expect(aggregate.incomplete).toBe(true);
  });
});
