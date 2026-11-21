import { describe, it, expect } from 'vitest';
import {
  sourceAudioRenditions, sourceAudioLanguages, audioLanguageKey, displayLanguage, isResolvedLanguage,
  isKnownAudioLanguage, trackNameLanguage, trackAudioLanguage, languageSourceIndex,
} from '../lib/player/languageSources';

// Final-review I1 (2026-11-21): a provider copies an und rendition's NAME into
// `language` ("Telugu 5.1"). The tag must not win as-is when it is not a language.
describe('an unresolved tag is read as a track name', () => {
  const src = (audio, extra = {}) => ({ id: 'V', provider: 'V', selectableAudio: true, audio, languages: [], ...extra });

  it('Telugu 5.1, Hindi AAC 2.0 and TEL resolve as renditions', () => {
    const r = sourceAudioRenditions(src([{ language: 'Telugu 5.1' }, { language: 'Hindi AAC 2.0' }, { language: 'TEL', name: 'Main' }]));
    expect(r.map(x => [x.language, x.key])).toEqual([['Telugu', 'telugu'], ['Hindi', 'hindi'], ['Telugu', 'telugu']]);
  });

  it('the vidrock row lists Telugu, not "Telugu 5.1"', () => {
    const row = src([{ language: 'Telugu 5.1', name: 'Telugu 5.1' }, { language: 'Hindi', name: 'Hindi' }],
      { languages: ['Telugu 5.1', 'Hindi'] });
    expect(sourceAudioLanguages(row)).toEqual(['Telugu', 'Hindi']);
    expect(languageSourceIndex([row]).byLanguage.has('telugu')).toBe(true);
    expect(sourceAudioLanguages({ id: 'S', languages: ['Telugu 5.1'] })).toEqual(['Telugu']);
  });

  it('an unresolved tag falls through to the name', () => {
    const r = sourceAudioRenditions(src([{ language: 'Commentary', name: 'Telugu 5.1' }]));
    expect(r[0].language).toBe('Telugu');
  });

  it('a codec-only label never becomes a language', () => {
    const r = sourceAudioRenditions(src([{ language: 'AAC 5.1' }]));
    expect(r.every(x => !isResolvedLanguage(x.language))).toBe(true);
    expect(trackNameLanguage('AAC 5.1')).toBe(null);
    expect(trackNameLanguage('HE-AAC 5.1')).toBe(null);
  });

  it('trackNameLanguage returns one language or null', () => {
    expect(trackNameLanguage('Telugu 5.1')).toBe('Telugu');
    expect(trackNameLanguage('Hindi AAC 2.0')).toBe('Hindi');
    expect(trackNameLanguage('TEL')).toBe('Telugu');
    expect(trackNameLanguage('Telugu / Hindi')).toBe(null);
    expect(trackNameLanguage('per it')).toBe(null);
    expect(trackNameLanguage('Telugu Stereo')).toBe('Telugu');
  });

  it('a label with any other word is left as given (no lost region or role)', () => {
    expect(trackNameLanguage('Portuguese (Brazil)')).toBe(null);
    expect(trackNameLanguage('Spanish LAT')).toBe(null);
    expect(trackNameLanguage('Telugu Commentary')).toBe(null);
    expect(sourceAudioLanguages({ id: 'S', languages: ['Portuguese (Brazil)'] })).toEqual(['Portuguese (Brazil)']);
  });

  it('in-player tracks get the same rule', () => {
    expect(audioLanguageKey(trackAudioLanguage({ lang: 'Telugu 5.1' }))).toBe('telugu');
  });
});

// Final-review finding A / M1, M3: parity with the server and the APK.
describe('code parity', () => {
  it("te_IN is Telugu, like te-IN", () => {
    expect(displayLanguage('te_IN')).toBe('Telugu');
    expect(audioLanguageKey('te_IN')).toBe('telugu');
    expect(audioLanguageKey('te-IN')).toBe('telugu');
  });

  it('tel-hin is not narrowed to Telugu (Hindi is not dropped)', () => {
    expect(displayLanguage('tel-hin')).not.toBe('Telugu');
    expect(audioLanguageKey('tel-hin')).toBe('tel-hin');
  });

  it('region, script and pt-BR rules stay', () => {
    expect(displayLanguage('es-419')).toBe('Spanish');
    expect(displayLanguage('zh-Hant')).toBe('Chinese');
    expect(displayLanguage('pt-BR')).toBe('Portuguese (BR)');
  });

  it('mul and zxx are not languages', () => {
    for (const v of ['mul', 'zxx', 'MUL']) expect(isKnownAudioLanguage(v)).toBe(false);
    expect(sourceAudioLanguages({ id: 'S', languages: ['mul', 'Telugu'], selectableAudio: true })).toEqual(['Telugu']);
  });
});
