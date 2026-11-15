import { describe, it, expect } from 'vitest';
import { matchTier, prepName, prepQuery, rankScore, TIER } from '../lib/searchRank';
import { lookupIndex, indexSize } from '../lib/searchIndex';

const tier = (q, name) => matchTier(prepQuery(q), prepName(name));

describe('matchTier', () => {
  it('orders exact, title prefix, then inner word prefix', () => {
    expect(tier('rrr', 'RRR')).toBe(TIER.EXACT);
    expect(tier('push', 'Pushpa: The Rise')).toBe(TIER.PREFIX);
    expect(tier('og', 'They Call Him OG')).toBe(TIER.WORD_PREFIX);
  });

  it('matches loose romanisation through the skeleton', () => {
    expect(tier('bahubali', 'Bāhubali: The Beginning')).toBe(TIER.PREFIX);
    expect(tier('bahubali', 'Baahubali 2')).toBe(TIER.SKEL_PREFIX);
    expect(tier('salar', 'Salaar: Part 1 - Ceasefire')).toBe(TIER.SKEL_PREFIX);
    expect(tier('puspa', 'Pushpa 2 - The Rule')).toBe(TIER.SKEL_PREFIX);
  });

  it('allows one typo against a whole word', () => {
    expect(tier('kalky', 'Kalki 2898-AD')).toBe(TIER.TYPO);
    expect(tier('devra', 'Devara: Part 1')).toBe(TIER.TYPO);
    expect(tier('manjumal', 'Manjummel Boys')).toBe(TIER.TYPO);
  });

  it('does not treat a one-edit prefix of a longer word as a typo', () => {
    // "ramam" vs "ramay..." pulled Ramayana above Sita Ramam.
    expect(tier('ramam', 'Ramayana: Rise of a Legend')).toBe(0);
    expect(tier('ramam', 'Sita Ramam')).toBe(TIER.WORD_PREFIX);
  });

  it('rejects unrelated titles', () => {
    expect(tier('pushpa', 'Interstellar')).toBe(0);
    expect(tier('kan', '')).toBe(0);
  });
});

describe('rankScore', () => {
  const base = { votes: 500, popularity: 10, year: 2024 };
  it('lets a preferred-language prefix beat a same-tier foreign title', () => {
    const te = rankScore({ ...base, tier: TIER.PREFIX, lang: 'te' }, ['te']);
    const en = rankScore({ ...base, tier: TIER.PREFIX, lang: 'en', votes: 5000 }, ['te']);
    expect(te).toBeGreaterThan(en);
  });
  it('still lets a far better match win over the language boost', () => {
    const exactEn = rankScore({ ...base, tier: TIER.EXACT, lang: 'en' }, ['te']);
    const typoTe = rankScore({ ...base, tier: TIER.TYPO, lang: 'te' }, ['te']);
    expect(exactEn).toBeGreaterThan(typoTe);
  });
});

describe('search index', () => {
  it('loads the committed index', () => {
    expect(indexSize()).toBeGreaterThan(1000);
  });
  it('finds Pushpa, Salaar and Kalki from short prefixes', () => {
    const titles = (q) => lookupIndex(q).map(x => x.m.title || x.m.name);
    expect(titles('pu').some(t => /^Pushpa/.test(t))).toBe(true);
    expect(titles('sala').some(t => /^Salaar/.test(t))).toBe(true);
    expect(titles('kalk').some(t => /^Kalki 2898/.test(t))).toBe(true);
  });
  // 'rrr' is not here: the local index misses it and the TMDB half of
  // searchAll supplies it (rank 1 on /api/search).
  it('ranks every prefix query target in the top five', () => {
    const top5 = (q) => lookupIndex(q).slice(0, 5).map(x => x.m.title || x.m.name);
    for (const [q, re] of [['pu', /^Pushpa/], ['push', /^Pushpa/], ['kal', /^Kalki 2898/],
      ['dev', /^Devara/], ['sal', /^Salaar/], ['bah', /^Baahubali|^Bāhubali/],
      ['manjum', /^Manjummel/], ['kan', /^Kantara/]]) {
      expect(top5(q).some(t => re.test(t)), `${q} -> ${top5(q).join(' | ')}`).toBe(true);
    }
  });
  it('finds the title through a one-letter typo or loose romanisation', () => {
    const top5 = (q) => lookupIndex(q).slice(0, 5).map(x => x.m.title || x.m.name);
    for (const [q, re] of [['puspa', /^Pushpa/], ['bahubali', /^Baahubali|^Bāhubali/],
      ['salar', /^Salaar/], ['kalky', /^Kalki/], ['devra', /^Devara/], ['manjumal', /^Manjummel/]]) {
      expect(top5(q).some(t => re.test(t)), `${q} -> ${top5(q).join(' | ')}`).toBe(true);
    }
  });
});
