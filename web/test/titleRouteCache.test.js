import { describe, it, expect, vi, beforeEach } from 'vitest';

// The title routes build as "ƒ (Dynamic)", so `revalidate` alone left Vercel
// at max-age=0 (MISS on every hit). They must send s-maxage themselves.
const cat = vi.hoisted(() => ({ title: null, full: null, similar: [], episodes: [], person: null }));
vi.mock('../lib/catalog', () => ({
  getTitle: vi.fn(async () => cat.title),
  getTitleFull: vi.fn(async () => cat.full),
  similarTitles: vi.fn(async () => cat.similar),
  seasonEpisodes: vi.fn(async () => cat.episodes),
  personInfo: vi.fn(async () => cat.person),
  personCredits: vi.fn(async () => ({ titles: [] })),
}));

const title = await import('../app/api/title/[type]/[id]/route.js');
const full = await import('../app/api/title/[type]/[id]/full/route.js');
const similar = await import('../app/api/similar/[type]/[id]/route.js');
const season = await import('../app/api/season/[id]/[season]/route.js');
const person = await import('../app/api/person/[id]/route.js');

const cc = r => r.headers.get('cache-control');
const WEEK = 'public, s-maxage=604800, stale-while-revalidate=86400';
const SHORT = 'public, s-maxage=300, stale-while-revalidate=300';

beforeEach(() => { Object.assign(cat, { title: null, full: null, similar: [], episodes: [], person: null }); });

describe('catalog route edge cache', () => {
  it('/api/title caches a found title for a week at the edge', async () => {
    cat.title = { tmdbId: 579974, title: 'RRR' };
    const r = await title.GET(new Request('http://x/api/title/movie/579974'), { params: { type: 'movie', id: '579974' } });
    expect(r.status).toBe(200);
    expect(cc(r)).toBe(WEEK);
    expect(await r.json()).toEqual(cat.title);
  });
  it('/api/title never caches a 404 or a 400', async () => {
    const r = await title.GET(new Request('http://x'), { params: { type: 'movie', id: '1' } });
    expect(r.status).toBe(404);
    expect(cc(r)).toBe('no-store');
    const b = await title.GET(new Request('http://x'), { params: { type: 'person', id: '1' } });
    expect(b.status).toBe(400);
    expect(cc(b)).toBe('no-store');
  });
  it('/full caches an enriched record for a week, a fast-only one for 5 min', async () => {
    cat.full = { tmdbId: 1, enriched: true, logo: '/l.png' };
    const r = await full.GET(new Request('http://x'), { params: { type: 'movie', id: '1' } });
    expect(cc(r)).toBe(WEEK);
    expect((await r.json()).logo).toBe('/l.png');
    cat.full = { tmdbId: 1, source: 'cinemeta' };
    expect(cc(await full.GET(new Request('http://x'), { params: { type: 'movie', id: '1' } }))).toBe(SHORT);
  });
  it('similar and season keep an empty answer only briefly', async () => {
    expect(cc(await similar.GET(new Request('http://x'), { params: { type: 'movie', id: '1' } }))).toBe(SHORT);
    cat.similar = [{ tmdbId: 2 }];
    expect(cc(await similar.GET(new Request('http://x'), { params: { type: 'movie', id: '1' } }))).toBe(WEEK);
    cat.episodes = [{ episode: 1 }];
    expect(cc(await season.GET(new Request('http://x'), { params: { id: '1', season: '1' } }))).toBe(WEEK);
  });
  it('person: week when found, no-store on 404', async () => {
    expect(cc(await person.GET(new Request('http://x'), { params: { id: '1' } }))).toBe('no-store');
    cat.person = { id: 1 };
    expect(cc(await person.GET(new Request('http://x'), { params: { id: '1' } }))).toBe(WEEK);
  });
});
