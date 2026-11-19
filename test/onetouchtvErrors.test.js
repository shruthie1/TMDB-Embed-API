'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createCipheriv } = require('crypto');

// Prod 2026-11-19 08:28 UTC: api3.devcorp.me answered 404 on the episode
// endpoint for ~40s. OneTouchTV turned that into [], the fan-out cached the
// empty for 3 minutes, and OneTouchTV vanished from every result. An upstream
// failure must reject; only "search has no match" is an empty result.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', {
    getDetails: async () => ({ title: 'Test Film', release_date: '2024-01-01' }),
    resolveImdbId: async () => null,
});
stub('utils/cinemetaEpisodes.js', { getEpisodesPerSeason: async () => [] });
stub('utils/tmdbTitleToImdb.js', { tmdbTitleToImdbId: async () => null });

const { getOnetouchtvStreams, _internal } = require('../providers/onetouchtv');

const KEY = Buffer.from('im72charPasswordofdInitVectorStm', 'utf8');
const IV = Buffer.from('im72charPassword', 'utf8');
const enc = (result) => {
    const c = createCipheriv('aes-256-cbc', KEY, IV);
    return Buffer.concat([c.update(JSON.stringify({ result })), c.final()]).toString('base64');
};
const ok = (result) => ({ ok: true, status: 200, text: async () => enc(result) });
const fail = (status) => ({ ok: false, status, text: async () => '' });

const SEARCH_HIT = [{ id: 7, title: 'Test Film', year: '2024', type: 'movie' }];
const DETAIL = { episodes: [{ episode: '1', playId: 'p1' }] };
const EPISODE = { sources: [{ url: 'https://cdn.example/a.m3u8', quality: '1080p', type: 'hls' }] };

let calls;
function route(handlers) {
    global.fetch = async (url) => {
        const u = String(url);
        const kind = u.includes('/vod/search') ? 'search' : u.includes('/detail') ? 'detail' : 'episode';
        calls[kind] = (calls[kind] || 0) + 1;
        const h = handlers[kind];
        if (h instanceof Error) throw h;
        return typeof h === 'function' ? h() : h;
    };
}
beforeEach(() => { calls = {}; _internal.cache.clear(); });

test('a full hit still returns streams', async () => {
    route({ search: ok(SEARCH_HIT), detail: ok(DETAIL), episode: ok(EPISODE) });
    const out = await getOnetouchtvStreams(1, 'movie');
    assert.equal(out.length, 1);
});

test('episode 404 after a search hit rejects, and is not retried', async () => {
    route({ search: ok(SEARCH_HIT), detail: ok(DETAIL), episode: fail(404) });
    await assert.rejects(getOnetouchtvStreams(1, 'movie'), /HTTP 404/);
    assert.equal(calls.episode, 1, '4xx must not be retried');
});

test('detail 404 after a search hit rejects', async () => {
    route({ search: ok(SEARCH_HIT), detail: fail(404), episode: ok(EPISODE) });
    await assert.rejects(getOnetouchtvStreams(1, 'movie'), /HTTP 404/);
    assert.equal(calls.detail, 1);
});

test('search with no match is a real empty, not an error', async () => {
    route({ search: ok([{ id: 9, title: 'Something Else Entirely', year: '1990', type: 'movie' }]) });
    assert.deepEqual(await getOnetouchtvStreams(1, 'movie'), []);
});

test('search 404 is a real empty (the endpoint 404s some spellings)', async () => {
    route({ search: fail(404) });
    assert.deepEqual(await getOnetouchtvStreams(1, 'movie'), []);
    assert.equal(calls.search, 1, 'one plain-ASCII spelling, no retry');
});

test('search 5xx is retried, then rejects', async () => {
    route({ search: fail(503) });
    await assert.rejects(getOnetouchtvStreams(1, 'movie'), /HTTP 503/);
    assert.equal(calls.search, 3, '1 try + 2 retries');
});

test('a network error on the episode endpoint is retried, then rejects', async () => {
    route({ search: ok(SEARCH_HIT), detail: ok(DETAIL), episode: new TypeError('fetch failed') });
    await assert.rejects(getOnetouchtvStreams(1, 'movie'), /fetch failed/);
    assert.equal(calls.episode, 3);
});

test('isRetryable: network and 5xx yes, 4xx no', () => {
    assert.equal(_internal.isRetryable(new TypeError('fetch failed')), true);
    assert.equal(_internal.isRetryable(Object.assign(new Error('x'), { status: 502 })), true);
    assert.equal(_internal.isRetryable(Object.assign(new Error('x'), { status: 404 })), false);
    assert.equal(_internal.isRetryable(Object.assign(new Error('x'), { status: 403 })), false);
});
