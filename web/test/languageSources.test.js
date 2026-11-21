import { describe, it, expect } from 'vitest';
import { languageSourceIndex, languageCandidates } from '../lib/player/languageSources';
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
