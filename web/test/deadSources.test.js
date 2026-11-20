import { describe, it, expect } from 'vitest';
import { markDead, nextAlive } from '../lib/player/deadSources';

// GET /api/streams/movie/811941 (Devara), 2026-11-16: five CastleTV rows.
const CASTLE = [0, 1, 2, 3, 4].map((i) => ({
  id: `CastleTV-${i}`, provider: 'CastleTV', masterUrl: `https://x/${i}.m3u8`,
}));

describe('dead sources are tracked per row', () => {
  it('one CastleTV row failing does not mark the others dead', () => {
    const dead = markDead(new Set(), { id: 'CastleTV-0', provider: 'CastleTV' });
    expect(nextAlive(CASTLE, dead)?.id).toBe('CastleTV-1');
  });

  it('walks the remaining rows of the same provider before giving up', () => {
    const dead = new Set();
    const seen = [];
    let cur = CASTLE[0];
    while (cur) {
      markDead(dead, cur);
      cur = nextAlive(CASTLE, dead);
      if (cur) seen.push(cur.id);
    }
    expect(seen).toEqual(['CastleTV-1', 'CastleTV-2', 'CastleTV-3', 'CastleTV-4']);
  });

  it('falls back to the provider name for a row with no id', () => {
    const dead = markDead(new Set(), { provider: 'vidking' });
    expect(nextAlive([{ provider: 'vidking', masterUrl: 'https://a' },
                      { provider: 'mapple', masterUrl: 'https://b' }], dead)?.provider)
      .toBe('mapple');
  });
});

// RRR (movie/579974): providers differ in audio language for one title.
// List order puts Hindi first, as the server sort can when both carry a
// preferred language.
const RRR = [
  { id: 'A-hi-1080', provider: 'A', quality: '1080p', languages: ['Hindi'], masterUrl: 'https://a' },
  { id: 'B-te-480', provider: 'B', quality: '480p', languages: ['Telugu'], masterUrl: 'https://b' },
  { id: 'C-te-1080', provider: 'C', quality: '1080p', languages: ['te'], masterUrl: 'https://c' },
  { id: 'D-none', provider: 'D', quality: '1080p', languages: [], masterUrl: 'https://d' },
  { id: 'E-te-720', provider: 'E', quality: '720p', languages: ['Telugu'], masterUrl: 'https://e' },
];

describe('a failover keeps the spoken language', () => {
  it('a non-manual switch from Telugu stays in Telugu, not the first alive Hindi row', () => {
    const dead = markDead(new Set(), { id: 'E-te-720' });
    const alt = nextAlive(RRR, dead, { lang: 'Telugu', height: 720 });
    expect(alt.languages.map((l) => l.toLowerCase())).not.toContain('hindi');
    expect(alt.id).toBe('B-te-480'); // 240 away beats C at 360 away
  });

  it('matches a language code against a language name', () => {
    const dead = new Set(['E-te-720', 'B-te-480']);
    expect(nextAlive(RRR, dead, { lang: 'Telugu', height: 1080 })?.id).toBe('C-te-1080');
  });

  it('within the language, the nearest height wins', () => {
    expect(nextAlive(RRR, new Set(), { lang: 'Telugu', height: 1080 })?.id).toBe('C-te-1080');
    expect(nextAlive(RRR, new Set(), { lang: 'Telugu', height: 720 })?.id).toBe('E-te-720');
  });

  it('a hybrid row whose paired audio is the language counts as same-language', () => {
    const rows = [RRR[0], { id: 'hy', provider: 'A+B', hybrid: true, quality: '1080p',
                           languages: ['Telugu'], masterUrl: 'https://h' }];
    expect(nextAlive(rows, new Set(), { lang: 'Telugu', height: 1080 })?.id).toBe('hy');
  });

  it('with no Telugu row left, an undeclared row beats a known Hindi row', () => {
    const dead = new Set(['B-te-480', 'C-te-1080', 'E-te-720']);
    expect(nextAlive(RRR, dead, { lang: 'Telugu', height: 1080 })?.id).toBe('D-none');
  });

  it('still fails over to another language when nothing else is alive', () => {
    const dead = new Set(['B-te-480', 'C-te-1080', 'D-none', 'E-te-720']);
    expect(nextAlive(RRR, dead, { lang: 'Telugu' })?.id).toBe('A-hi-1080');
  });

  it('a manual language pick crosses languages: the picked language leads', () => {
    // switchSource(src, 'Hindi') sets wantLang, so the next failover asks for Hindi.
    const dead = markDead(new Set(), { id: 'E-te-720' });
    expect(nextAlive(RRR, dead, { lang: 'Hindi', height: 720 })?.id).toBe('A-hi-1080');
  });

  it('with no playing language, keeps the old first-alive order', () => {
    expect(nextAlive(RRR, new Set())?.id).toBe('A-hi-1080');
  });
});
