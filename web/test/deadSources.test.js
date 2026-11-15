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
