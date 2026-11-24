import { describe, it, expect } from 'vitest';
import { isMuxedSource, sourceAudioLanguages, languageCandidates } from '../lib/player/languageSources';
import { audioChoices } from '../lib/player/trackChoices';
import { initialAudioTrack } from '../lib/player/useHls';

// Jailer 937020: vidrock/CastleTV single-variant rows, one TS with AAC tracks tagged hin/tam/tel/mal/kan.
const five = ['Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada'];
const row = (provider, extra = {}) => ({ id: `${provider}-0`, provider, languages: five, selectableAudio: false, hybrid: false, progressive: false, audio: [], ...extra });

describe('muxed TS rows (several PMT-tagged tracks in one file)', () => {
  it('vidrock and CastleTV muxed rows offer every file language', () => {
    expect(isMuxedSource(row('vidrock'))).toBe(true);
    expect(isMuxedSource(row('CastleTV'))).toBe(true);
    expect(sourceAudioLanguages(row('vidrock'))).toEqual(five);
    expect(languageCandidates([row('vidrock')], 'Telugu').map(s => s.id)).toEqual(['vidrock-0']);
  });

  it('a server ts-pmt marker counts for any provider', () => {
    expect(isMuxedSource(row('newhost', { languageSource: 'ts-pmt' }))).toBe(true);
  });

  it('other non-selectable rows keep their first language (unknown beats wrong)', () => {
    expect(isMuxedSource(row('OneTouchTV'))).toBe(false);
    expect(sourceAudioLanguages(row('OneTouchTV'))).toEqual(['Hindi']);
    expect(isMuxedSource(row('vidrock', { progressive: true }))).toBe(false);
    expect(isMuxedSource(row('vidrock', { languages: ['Hindi'] }))).toBe(false);
  });

  it('the audio menu offers Telugu from a muxed row of another server', () => {
    const out = audioChoices([row('gd', { languages: ['Hindi'] }), row('vidrock')], 'gd-0');
    expect(out.map(c => c.id)).toEqual(five.map(l => `src:vidrock-0:${l}`));
  });

  it('the muxed loader starts on the Telugu PID when the file tags it', () => {
    const tracks = [{ pid: 0x101, lang: 'hin' }, { pid: 0x102, lang: 'tam' }, { pid: 0x103, lang: 'tel' }];
    expect(initialAudioTrack(tracks, 'Telugu')).toBe(2);
    expect(initialAudioTrack(tracks, 'English')).toBe(0);
  });
});
