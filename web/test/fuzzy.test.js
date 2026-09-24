import { describe, it, expect } from 'vitest';
import { skeleton, similarity, searchKey, searchScore, editDistance, variants, typoFixes } from '../lib/fuzzy';

describe('skeleton', () => {
  it('collapses every romanisation of Geetha Govindam', () => {
    const forms = ['Geetha Govindam', 'gita govindam', 'githa govindham',
                   'geeta govindham', 'Geetha Govindham', 'GEETHA  GOVINDAM'];
    const keys = new Set(forms.map(skeleton));
    expect(keys.size).toBe(1);
  });

  it('strips diacritics so Bāhubali matches Baahubali', () => {
    expect(skeleton('Bāhubali')).toBe(skeleton('Baahubali'));
  });

  it('keeps genuinely different titles apart', () => {
    const titles = ['Kantara', 'Kalki', 'Pushpa', 'Irumudi', 'Salaar', 'Devara'];
    expect(new Set(titles.map(skeleton)).size).toBe(titles.length);
  });

  it('is empty for empty input rather than throwing', () => {
    expect(skeleton(null)).toBe('');
    expect(skeleton('')).toBe('');
  });
});

describe('similarity', () => {
  it('scores a misspelling of the same title as an exact match', () => {
    expect(similarity('gita govindam', 'Geetha Govindam')).toBe(1);
    expect(similarity('githa govindham', 'Geetha Govindam')).toBe(1);
  });

  it('scores an unrelated title at zero', () => {
    expect(similarity('kantara', 'Geetha Govindam')).toBe(0);
    expect(similarity('pushpa', 'Baahubali')).toBe(0);
  });

  it('ranks a prefix match high', () => {
    expect(similarity('kalki', 'Kalki 2898-AD')).toBeGreaterThan(0.85);
  });

  it('tolerates a single typo', () => {
    expect(similarity('kantera', 'Kantara')).toBeGreaterThan(0.5);
  });

  it('does not match on one shared letter', () => {
    expect(similarity('a', 'Baahubali')).toBeLessThan(0.5);
  });
});

describe('searchKey', () => {
  it('does not penalise an exact title for year and type qualifiers', () => {
    expect(searchKey('Leo 2023 movie')).toBe('leo');
  });
  it('preserves meaningful title words', () => {
    expect(searchKey('The Last Film')).toBe('the last');
  });
});

describe('searchScore', () => {
  it('prefers a relevant regional multi-word title over an old generic exact match', () => {
    const query = 'vishwanath';
    const generic = searchScore(query, { title: 'Vishwanath', original_language: 'hi', release_date: '1978-01-01' });
    const relevant = searchScore(query, { title: 'Vishwanath & Sons', original_language: 'ta', release_date: '2026-01-01' });
    expect(relevant).toBeGreaterThan(generic);
  });
});

describe('editDistance', () => {
  it('is zero for identical strings', () => {
    expect(editDistance('kantara', 'kantara')).toBe(0);
  });
  it('counts single edits', () => {
    expect(editDistance('kantara', 'kantera')).toBe(1);
  });
  it('bails past the budget instead of scanning the whole matrix', () => {
    expect(editDistance('a'.repeat(40), 'b'.repeat(40), 3)).toBeGreaterThan(3);
  });
});

describe('variants', () => {
  it('offers a spelling TMDB is likely to know', () => {
    expect(variants('gita govindam')).toContain('geetha govindam');
  });
  it('returns nothing for empty input', () => {
    expect(variants('')).toEqual([]);
  });
  it('stays capped so a search cannot fan out', () => {
    expect(variants('geetha govindham thootha').length).toBeLessThanOrEqual(4);
  });
});


describe('subtitles', () => {
  it('matches the main title through a subtitle', () => {
    // "Pushpa: The Rise - Part 1" scored 0 before the main title was compared.
    expect(similarity('pushpa', 'Pushpa: The Rise - Part 1')).toBeGreaterThan(0.9);
    expect(similarity('salaar', 'Salaar: Part 1 - Ceasefire')).toBeGreaterThan(0.9);
    expect(similarity('kalki', 'Kalki 2898-AD')).toBeGreaterThan(0.85);
  });

  it('still rejects an unrelated title that has a subtitle', () => {
    expect(similarity('kantara', 'Pushpa: The Rise - Part 1')).toBe(0);
  });
});

describe('sh/s equivalence', () => {
  it('treats pusspa and pushpa as the same word', () => {
    expect(skeleton('pusspa')).toBe(skeleton('pushpa'));
  });
});

describe('typoFixes', () => {
  it('repairs a doubled letter', () => {
    expect(typoFixes('pusspa')).toContain('pushpa');
  });
  it('repairs a y/i ending', () => {
    expect(typoFixes('kalky')).toContain('kalki');
  });
  it('repairs a v/b slip', () => {
    expect(typoFixes('bahuvali')).toContain('bahubali');
  });
  it('repairs v/w transliteration', () => {
    expect(typoFixes('vishvanath')).toContain('vishwanath');
  });
  it('repairs a wrong final vowel', () => {
    expect(typoFixes('kantera')).toContain('kantara');
  });
  it('ignores very short queries rather than fanning out', () => {
    expect(typoFixes('rrr')).toEqual([]);
  });
  it('stays capped so one query cannot become many requests', () => {
    expect(typoFixes('bahuvali').length).toBeLessThanOrEqual(4);
  });
});

describe('word boundaries, not skeleton coincidences', () => {
  it('ranks a title containing the word above a boundary collision', () => {
    // skeleton() strips spaces, so "Rama Madhav" becomes "ramamadav" - which
    // startsWith("ramam") purely by where the words meet. That scored 0.92,
    // above Sita Ramam's 0.84, and pushed the film the viewer wanted to third.
    expect(similarity('ramam', 'Sita Ramam'))
      .toBeGreaterThan(similarity('ramam', 'Rama Madhav'));
    expect(similarity('ramam', 'Amrutha Ramam'))
      .toBeGreaterThan(similarity('ramam', 'Rama Madhav'));
  });

  it('folds diacritics before splitting into words', () => {
    // "Bāhubali" split on [^a-z0-9] gives ["b","hubali"] because the macron is
    // not in a-z, so the word check failed on exactly the titles it serves.
    // Every spelling of the name must score the same.
    const plain = similarity('bahub', 'Baahubali: The Beginning');
    for (const t of ['Bāhubali 2: The Conclusion', 'Bāhubali: The Epic']) {
      expect(similarity('bahub', t), t).toBeCloseTo(plain, 2);
    }
  });

  it('still matches a real prefix strongly', () => {
    // The guard against over-correcting: ordinary prefix search must not
    // regress while fixing the collision case.
    for (const [q, t] of [['pushp', 'Pushpa: The Rise'], ['kanta', 'Kantara'],
                          ['salaar', 'Salaar: Part 1 - Ceasefire']]) {
      expect(similarity(q, t), `${q} / ${t}`).toBeGreaterThanOrEqual(0.9);
    }
  });
});
