import { describe, expect, it } from 'vitest';
import { initialAudioTrack } from '../lib/player/useHls';

describe('initialAudioTrack', () => {
  it('has no selection when the manifest has no audio renditions', () => {
    expect(initialAudioTrack([])).toBe(-1);
  });

  it('selects the explicit HLS default when no preference matches', () => {
    // Second argument is the preference; pass one nothing matches so this
    // keeps testing the original DEFAULT=YES behaviour.
    expect(initialAudioTrack([
      { lang: 'tel', default: false },
      { lang: 'eng', default: true },
    ], null)).toBe(1);
    expect(initialAudioTrack([
      { lang: 'hin', default: false },
      { lang: 'eng', default: true },
    ], 'Telugu')).toBe(1);
  });

  it('prefers the viewer language over the manifest DEFAULT flag', () => {
    // This backend republishes CastleTV's muxed TS with the FIRST rendition
    // marked DEFAULT=YES, which on an Indian five-language title is Hindi.
    // Honouring DEFAULT alone started every such title in the wrong language.
    expect(initialAudioTrack([
      { lang: 'hin', default: true },
      { lang: 'tel', default: false },
    ], 'Telugu')).toBe(1);
  });

  it('matches the preference by ISO code or by name', () => {
    // The manifest says LANGUAGE="tel"; the API's languages array says "Telugu".
    expect(initialAudioTrack([{ lang: 'hin' }, { lang: 'tel' }], 'Telugu')).toBe(1);
    expect(initialAudioTrack([{ lang: 'hin' }, { lang: 'tel' }], 'tel')).toBe(1);
  });

  it('falls back to DEFAULT when the preferred language is absent', () => {
    expect(initialAudioTrack([
      { lang: 'hin', default: false },
      { lang: 'tam', default: true },
    ], 'Telugu')).toBe(1);
  });

  it('selects the only rendition even when the provider marks it DEFAULT=NO', () => {
    // This is the shape used by the supplied streamvin manifest.
    expect(initialAudioTrack([{ lang: 'tel', default: false }])).toBe(0);
  });
});
