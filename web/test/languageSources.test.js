import { describe, it, expect } from 'vitest';
import { languageSourceIndex, languageCandidates, sourceAudioRenditions, audioLanguageKey } from '../lib/player/languageSources';
import { advanceTarget, beginSourceSwitch } from '../lib/player/switchFlow';
const source = (id, languages, extra = {}) => ({ id, provider: id, languages, masterUrl: `https://fixture/${id}.m3u8`, ...extra });
describe('bidirectional audio discovery', () => {
  it('retains every server per language and every real language per server', () => {
    const a = source('A', ['Telugu', 'Hindi'], { selectableAudio: true });
    const b = source('B', ['te']);
    const index = languageSourceIndex([a,b]);
    expect(index.bySource.get('A')).toEqual(['Telugu','Hindi']);
    expect(index.byLanguage.get('telugu').sources.map(s => s.id)).toEqual(['A','B']);
  });
  it('uses explicit Telugu intent after Hindi fails and includes late on-demand results', () => {
    const hi = source('Hindi', ['Hindi']), a = source('A', ['Telugu']), b = source('B', ['Telugu']);
    const dead = new Set();
    const click = beginSourceSwitch({ target:a, at:73, ctx:{ lang:'Telugu', strictLanguage:true } });
    expect(click.at).toBe(73);
    expect(advanceTarget([hi,a,b], dead, a, click.ctx)).toBe(b);
    expect(advanceTarget([hi,a,b], dead, b, click.ctx)).toBeNull();
    const late = source('Late', ['Telugu']);
    expect(advanceTarget([hi,a,b,late], dead, b, click.ctx)).toBe(late);
    expect(languageCandidates([hi,a,b], 'Telugu')).toHaveLength(2);
  });
  it('does not invent catalog-only or explicitly absent audio renditions', () => {
    expect(languageCandidates([source('A',['Telugu'], {selectableAudio:true,audio:[],catalogLanguages:['Telugu']})], 'Telugu')).toEqual([]);
    expect(languageCandidates([source('A',[], {catalogLanguages:['Telugu']})], 'Telugu')).toEqual([]);
  });
});

it('generic numbered track labels do not become language evidence', () => {
  expect(languageCandidates([source('A',['Track 1'])], 'Track 1')).toEqual([]);
  expect(languageCandidates([source('B',['Audio 2'])], 'Audio 2')).toEqual([]);
});

describe('language pick never resolves to the playing source (W2)', () => {
  it('drops the current source so a pick always switches or says none', async () => {
    const { languageSwitchCandidates } = await import('../lib/player/languageSources');
    const castle = source('castletv-0', ['Telugu', 'Hindi'], { selectableAudio: true });
    const va = source('vaplayer-0', ['Hindi']);
    expect(languageSwitchCandidates([castle, va], 'Hindi', 'castletv-0').map(s => s.id)).toEqual(['vaplayer-0']);
    expect(languageSwitchCandidates([castle], 'Hindi', 'castletv-0')).toEqual([]);
    // Telugu order is kept for the other servers.
    const a = source('A', ['Telugu']), b = source('B', ['te']);
    expect(languageSwitchCandidates([castle, a, b], 'Telugu', 'castletv-0').map(s => s.id)).toEqual(['A', 'B']);
    expect(languageSwitchCandidates([a, b, source('U', ['Telugu'], { unsupported: true })], 'Telugu', null).map(s => s.id)).toEqual(['A', 'B']);
  });
});

describe('two-way index hardening (task 3)', () => {
  it('buckets cross-spelled audio tags under one key with per-source renditions', () => {
    const a = source('A', [], { selectableAudio: true, audio: [{ language: 'te', uri: 'a' }] });
    const b = source('B', [], { selectableAudio: true, audio: [{ language: 'Telugu', uri: 'b' }] });
    const { byLanguage } = languageSourceIndex([a, b]);
    const telugu = [...byLanguage.entries()].filter(([k]) => k === 'telugu');
    expect(telugu).toHaveLength(1);
    expect(byLanguage.size).toBe(1);
    const entry = byLanguage.get('telugu');
    expect(entry.sources.map(s => s.id)).toEqual(['A', 'B']);
    expect(entry.renditions.get('A').uri).toBe('a');
    expect(entry.renditions.get('B').uri).toBe('b');
  });
  it('maps a whole-stream language to a null rendition', () => {
    const { byLanguage } = languageSourceIndex([source('H', ['Hindi'], { audio: [] })]);
    expect(byLanguage.get('hindi').sources.map(s => s.id)).toEqual(['H']);
    expect(byLanguage.get('hindi').renditions.get('H')).toBeNull();
    expect(byLanguage.has('telugu')).toBe(false);
  });
  it('reads the rendition name when the language tag is und', () => {
    const { byLanguage, bySource } = languageSourceIndex([source('C', [], { selectableAudio: true, audio: [{ language: 'und', name: 'Telugu', uri: 'c' }] })]);
    expect(bySource.get('C').map(audioLanguageKey)).toEqual(['telugu']);
    expect(byLanguage.get('telugu').renditions.get('C').uri).toBe('c');
  });
  it('handles empty input', () => {
    const index = languageSourceIndex([]);
    expect(index.byLanguage.size).toBe(0);
    expect(index.bySource.size).toBe(0);
    expect(sourceAudioRenditions({})).toEqual([]);
    expect(sourceAudioRenditions({ audio: [] })).toEqual([]);
  });
  it('buckets a region code under the base language key', () => {
    const { byLanguage } = languageSourceIndex([source('R', [], { selectableAudio: true, audio: [{ language: 'hi-IN', uri: 'r' }] })]);
    expect([...byLanguage.keys()]).toEqual([audioLanguageKey('Hindi')]);
    expect(byLanguage.get(audioLanguageKey('Hindi')).renditions.get('R').uri).toBe('r');
  });
  it('sourceAudioRenditions returns display name, key, uri, name and default', () => {
    expect(sourceAudioRenditions({ audio: [{ language: 'te', name: 'Telugu 5.1', uri: 'u', default: true }, { language: 'und', name: 'Track 2', uri: 'x' }] }))
      .toEqual([{ language: 'Telugu', key: 'telugu', uri: 'u', name: 'Telugu 5.1', default: true }]);
  });
});

describe('language from a track name (fix round 1)', () => {
  it('takes the first word that names a language', async () => {
    const { languageFromTrackName, trackAudioLanguage } = await import('../lib/player/languageSources');
    for (const name of ['Telugu 5.1', 'Telugu (AAC)', 'TEL - Stereo', 'Telugu Dolby', '[2] Telugu 5.1']) {
      expect(languageFromTrackName(name)).toBe('Telugu');
      expect(trackAudioLanguage({ language: 'und', name })).toBe('Telugu');
      expect(sourceAudioRenditions({ audio: [{ language: 'und', name, uri: 'u' }] })[0]).toMatchObject({ language: 'Telugu', key: 'telugu' });
    }
  });
  it('keeps the whole cleaned name when no word resolves', async () => {
    const { languageFromTrackName, trackAudioLanguage } = await import('../lib/player/languageSources');
    expect(languageFromTrackName('Director Commentary')).toBe('Director Commentary');
    expect(trackAudioLanguage({ language: 'und', name: '[1] Director Commentary' })).toBe('Director Commentary');
    expect(languageFromTrackName('Track 2')).toBeNull();
  });
});

describe('short words in a track name (fix round 2)', () => {
  it('only ALL-CAPS short codes or full names count', async () => {
    const { languageFromTrackName } = await import('../lib/player/languageSources');
    expect(languageFromTrackName('Commentary per director')).toBe('Commentary per director');
    expect(languageFromTrackName('it')).toBe('it');
    expect(languageFromTrackName('TEL - Stereo')).toBe('Telugu');
    expect(languageFromTrackName('telugu 5.1')).toBe('Telugu');
  });
});

describe('languages[] floor when no rendition names a language (fix round 4)', () => {
  const audio = [{ language: 'und', name: 'Director Commentary', uri: 'd' }];
  it('a commentary rendition does not hide Telugu from languages[]', async () => {
    const { sourceAudioLanguages } = await import('../lib/player/languageSources');
    for (const selectableAudio of [true, false]) {
      expect(sourceAudioLanguages(source('S', ['te'], { selectableAudio, audio }))).toEqual(selectableAudio ? ['Director Commentary', 'Telugu'] : ['Telugu']);
      const { byLanguage } = languageSourceIndex([source('S', ['te'], { selectableAudio, audio })]);
      expect(byLanguage.get('telugu').renditions.get('S')).toBeNull();
    }
  });
  it('an und rendition with no name falls back to languages[]', async () => {
    const { sourceAudioLanguages } = await import('../lib/player/languageSources');
    expect(sourceAudioLanguages(source('S', ['Telugu'], { selectableAudio: true, audio: [{ language: 'und', uri: 'x' }] }))).toEqual(['Telugu']);
  });
  it('resolved renditions are the truth: languages[] adds nothing', async () => {
    const { sourceAudioLanguages } = await import('../lib/player/languageSources');
    expect(sourceAudioLanguages(source('N', ['Hindi', 'Telugu', 'Tamil'], { selectableAudio: true, audio: [{ language: 'Telugu' }, { language: 'Hindi' }] }))).toEqual(['Telugu', 'Hindi']);
  });
});

describe('single-language source shows exactly one language (fix round 5)', () => {
  it('picks the first rendition that names a language, over languages[]', async () => {
    const { sourceAudioLanguages } = await import('../lib/player/languageSources');
    const probe = source('P', ['hi'], { selectableAudio: false, audio: [{ language: 'und', name: 'Director Commentary' }, { language: 'te' }] });
    expect(sourceAudioLanguages(probe)).toEqual(['Telugu']);
  });
  it('skips a languages[] value that is not a real language', async () => {
    const { sourceAudioLanguages } = await import('../lib/player/languageSources');
    expect(sourceAudioLanguages(source('Q', ['Director Commentary', 'te'], { selectableAudio: false, audio: [] }))).toEqual(['Telugu']);
  });
});

describe('codec and channel words are not languages (post-review)', () => {
  it('a full language name beats codec words that look like codes', async () => {
    const { languageFromTrackName } = await import('../lib/player/languageSources');
    expect(languageFromTrackName('HE-AAC Telugu')).toBe('Telugu');
    expect(languageFromTrackName('5.1 CH Telugu')).toBe('Telugu');
    expect(languageFromTrackName('2CH Telugu')).toBe('Telugu');
    expect(languageFromTrackName('HE-AAC Stereo')).toBe('HE-AAC Stereo');
    expect(languageFromTrackName('TEL - Stereo')).toBe('Telugu');
  });
});
