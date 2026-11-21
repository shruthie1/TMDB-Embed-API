import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt, findTitleMatch, searchSpellings, resolveOneTouchRows, splitTitleYear } from '../lib/oneTouchClient';
import { resolveLive, sourcesFromResponse } from '../lib/backend';

// Recorded 2026-11-21: /vod/search?keyword=RRR, exactly as api3.devcorp.me sent it.
const RRR_SEARCH = readFileSync(fileURLToPath(new URL('../../android/app/src/test/resources/fixtures/onetouchtv/rrr-search.enc', import.meta.url)), 'utf8');

const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });
const notFound = { ok: false, status: 404, text: async () => '', json: async () => ({}) };
const enc = async (result) => ok(await encrypt({ result }));

function fake(routes) {
  const calls = [];
  const fetchImpl = vi.fn(async (url) => {
    calls.push(url);
    for (const [prefix, answer] of routes) if (url.startsWith(prefix)) return typeof answer === 'function' ? answer(url) : answer;
    return notFound;
  });
  return { fetchImpl, calls };
}

const SQUID = [
  { id: '446345-squid-game-season-3-2025', title: 'Squid Game Season 3 (2025)', type: 'drama', year: '2025' },
  { id: '978626-squid-game-2021', title: 'Squid Game (2021)', type: 'drama', year: '2021' },
];

async function squidRoutes(extra = []) {
  return [
    ...extra,
    ['/api/title/tv/93405/full', ok(JSON.stringify({ title: 'Squid Game', year: 2021, imdbId: 'tt10919420' }))],
    ['/api/search', ok(JSON.stringify({ titles: [{ tmdbId: 93405, mediaType: 'tv', title: 'Squid Game', year: 2021 }] }))],
    ['B/vod/search?keyword=Squid%20Game', await enc(SQUID)],
    ['B/vod/978626-squid-game-2021/detail', await enc({ episodes: [{ episode: '2', playId: '2' }, { episode: '1', playId: '1' }] })],
    ['B/vod/978626-squid-game-2021/episode/1', await enc({
      sources: [
        { type: 'hls', quality: 'auto', name: 'loklok', url: 'https://akm-cdn-play.hitv.ltd/a/sd.mp4.m3u8?hdnts=exp=1' },
        { type: 'hls', quality: 'auto', name: 'loklok', url: 'https://akm-cdn-play.hitv.ltd/a/sd.mp4.m3u8?hdnts=exp=1' },
        { type: 'hls', quality: '1080p', name: 'myasiantv.es', url: 'https://kisscloud.online/m.m3u8' },
      ],
      track: [{ file: 'https://aapanel.devcorp.me/en.vtt', name: 'English' }, { file: '', name: 'Empty' }],
    })],
  ];
}

describe('oneTouchClient', () => {
  it('decrypts the real upstream alphabet', async () => {
    const d = await decrypt(RRR_SEARCH);
    expect(d.result.map((r) => r.id)).toContain('mk-rrr-2022');
    expect(await decrypt(await encrypt({ a: '/+?' }))).toEqual({ a: '/+?' });
  });

  it('matches like utils/titleMatch.js', () => {
    // "RRR" is under 4 letters: only an exact title matches, as on the server.
    expect(findTitleMatch([{ title: 'RRR (2022)', year: 2022 }], 'RRR', 2022)).toBeNull();
    expect(findTitleMatch(SQUID.map((r) => ({ title: r.title, year: +r.year })), 'Squid Game', 2021).title).toBe('Squid Game (2021)');
    expect(searchSpellings('Bāhubali: The Beginning').slice(0, 2)).toEqual(['Bāhubali: The Beginning', 'Bahubali: The Beginning']);
  });

  it('strips a trailing "(YYYY)" before matching OneTouchTV rows: RRR (2022) yes, RRR (1999) and short wrong titles no', async () => {
    expect(splitTitleYear('RRR (2022)')).toEqual({ title: 'RRR', year: 2022 });
    expect(splitTitleYear('RRR')).toEqual({ title: 'RRR', year: null });
    const rrr = async (search) => {
      const { fetchImpl, calls } = fake([
        ['/api/title/movie/579974/full', ok(JSON.stringify({ title: 'RRR', year: 2022, imdbId: 'tt8178634' }))],
        ['/api/search', (u) => { calls.push(`q=${decodeURIComponent(u.split('q=')[1])}`); return ok(JSON.stringify({ titles: [{ tmdbId: 579974, mediaType: 'movie', title: 'RRR', year: 2022 }] })); }],
        ['B/vod/search', search],
        ['B/vod/mk-rrr-2022/detail', await enc({ episodes: [{ episode: '1', playId: '7' }] })],
        ['B/vod/mk-rrr-2022/episode/7', await enc({ sources: [{ type: 'hls', quality: 'auto', name: 'loklok', url: 'https://akm-cdn-play.hitv.ltd/r.m3u8' }] })],
      ]);
      const rows = await resolveOneTouchRows({ type: 'movie', tmdbId: 579974, fetchImpl, base: 'B' });
      return { rows, calls };
    };
    // Recorded upstream search: "RRR (2022)", id mk-rrr-2022.
    const hit = await rrr(ok(RRR_SEARCH));
    expect(hit.rows.map((r) => r.url)).toEqual(['https://akm-cdn-play.hitv.ltd/r.m3u8']);
    expect(hit.calls).toContain('q=RRR'); // cross-check asks the bare title
    const miss = await rrr(await enc([
      { id: 'mk-rrr-2022', title: 'RRR (1999)', type: 'movie' },
      { id: 'mk-rrr-2022', title: 'RRRR (2022)', type: 'movie' },
      { id: 'mk-rrr-2022', title: 'RX 100 (2022)', type: 'movie' },
    ]));
    expect(miss.rows).toEqual([]);
    expect(miss.calls.some((u) => u.includes('/detail'))).toBe(false);
  });

  it('gives deduped server-shaped rows with no language, played direct', async () => {
    const { fetchImpl } = fake(await squidRoutes());
    const rows = await resolveOneTouchRows({ type: 'tv', tmdbId: 93405, season: 1, episode: 1, fetchImpl, base: 'B' });
    expect(rows.map((r) => r.quality)).toEqual(['Auto', '1080p']);
    expect(rows[0]).toMatchObject({ provider: 'OneTouchTV', container: 'hls', languages: [], audio: [], title: 'Squid Game (2021)\nAuto · HLS' });
    expect(rows[0].subtitles).toEqual([{ url: 'https://aapanel.devcorp.me/en.vtt', lang: 'English' }]);
    const sources = sourcesFromResponse({ streams: rows });
    expect(sources[0].webDirectUrl).toBe(rows[0].url);
    expect(sources.every((s) => !s.progressive && s.languages.length === 0)).toBe(true);
  });

  it('rejects a match that is another TMDB title', async () => {
    const { fetchImpl, calls } = fake(await squidRoutes([
      ['/api/search', ok(JSON.stringify({ titles: [{ tmdbId: 1, mediaType: 'tv', title: 'Squid Game', year: 2021 }] }))],
    ]));
    expect(await resolveOneTouchRows({ type: 'tv', tmdbId: 93405, season: 1, episode: 1, fetchImpl, base: 'B' })).toEqual([]);
    expect(calls.some((u) => u.includes('/detail'))).toBe(false);
  });

  it('treats a search 404 as the next spelling and a 5xx as a failure', async () => {
    const { fetchImpl } = fake([
      ['/api/title/movie/256040/full', ok(JSON.stringify({ title: 'Bāhubali: The Beginning', year: 2015 }))],
      ['/api/search', ok(JSON.stringify({ titles: [] }))],
      ['B/vod/search?keyword=B%C4%81hubali', notFound],
      ['B/vod/search?keyword=Bahubali', await enc([{ id: 'b1', title: 'Bahubali: The Beginning', type: 'movie', year: '2015' }])],
      ['B/vod/b1/detail', await enc({ episodes: [{ episode: '1', playId: '1' }] })],
      ['B/vod/b1/episode/1', await enc({ sources: [{ type: 'hls', url: 'https://x/b.m3u8' }] })],
    ]);
    const rows = await resolveOneTouchRows({ type: 'movie', tmdbId: 256040, fetchImpl, base: 'B' });
    expect(rows.map((r) => r.url)).toEqual(['https://x/b.m3u8']);

    const down = fake([
      ['/api/title/movie/1/full', ok(JSON.stringify({ title: 'Parasite', year: 2019 }))],
      ['B/', { ok: false, status: 503, text: async () => '' }],
    ]);
    await expect(resolveOneTouchRows({ type: 'movie', tmdbId: 1, fetchImpl: down.fetchImpl, base: 'B', retryDelayMs: 1 })).rejects.toThrow('HTTP 503');
    expect(down.calls.filter((u) => u.startsWith('B/')).length).toBe(3);
  });

  it('uses Cinemeta for a later season the entry does not name', async () => {
    const { fetchImpl } = fake([
      ['/api/title/tv/1429/full', ok(JSON.stringify({ title: 'Attack on Titan', year: 2013, imdbId: 'tt2560140' }))],
      ['/api/search', ok(JSON.stringify({ titles: [] }))],
      ['B/vod/search', await enc([{ id: 'aot', title: 'Attack on Titan', type: 'anime', year: '2013' }])],
      ['B/vod/aot/detail', await enc({ episodes: [{ episode: '27', playId: '27' }] })],
      ['B/vod/aot/episode/27', await enc({ sources: [{ type: 'hls', url: 'https://x/s2e2.m3u8' }] })],
      ['C/meta/series/tt2560140.json', ok(JSON.stringify({ meta: { videos: [{ season: 1, number: 25 }, { season: 2, number: 1 }] } }))],
    ]);
    const rows = await resolveOneTouchRows({ type: 'tv', tmdbId: 1429, season: 2, episode: 2, fetchImpl, base: 'B', cinemeta: 'C' });
    expect(rows.map((r) => r.url)).toEqual(['https://x/s2e2.m3u8']);
  });
});

describe('resolveLive clientFallback', () => {
  const run = (id, fallback) => new Promise((resolve) => {
    resolveLive('movie', id, {
      clientFallback: fallback,
      onDone: (s) => resolve({ ok: s }),
      onFail: (e) => resolve({ err: e }),
    });
  });

  it('serves browser rows when the VM fails, and the VM error when there are none', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => '' }));
    try {
      const got = await run(987654321, async () => [{ provider: 'OneTouchTV', url: 'https://x/m.m3u8', container: 'hls', languages: [] }]);
      expect(got.ok?.provider).toBe('OneTouchTV');
      expect(got.ok.sources).toHaveLength(1);
      const none = await run(987654322, async () => []);
      expect(none.err).toBeTruthy();
      const threw = await run(987654323, async () => { throw new Error('upstream down'); });
      expect(threw.err?.message).not.toBe('upstream down');
    } finally {
      globalThis.fetch = real;
    }
  }, 60000);
});
