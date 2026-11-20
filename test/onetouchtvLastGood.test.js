'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createCipheriv } = require('crypto');

// Prod audit 2026-11-20: api3.devcorp.me answers 200 for a title, then 404 on
// the same episode URL minutes later. The 404 used to reject, count as a
// breaker miss, and trip OneTouchTV for every title. The rows from the 200
// are still playable, so the 404 must serve them and count as a hit.
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
const metricsMod = require.resolve('../lib/runtime/metrics');

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
let episodeReply;
function route() {
    global.fetch = async (url) => {
        const u = String(url);
        const kind = u.includes('/vod/search') ? 'search' : u.includes('/detail') ? 'detail' : 'episode';
        calls[kind] = (calls[kind] || 0) + 1;
        if (kind === 'search') return ok(SEARCH_HIT);
        if (kind === 'detail') return ok(DETAIL);
        return episodeReply();
    };
}
beforeEach(() => {
    calls = {};
    _internal.cache.clear();
    _internal.lastGood.clear();
    _internal.timing.notFoundRetryMs = 0;
    route();
});

test('200 then 404 on the same title returns the last good rows, no retry', async () => {
    episodeReply = () => ok(EPISODE);
    const first = await getOnetouchtvStreams(1, 'movie');
    assert.equal(first.length, 1);

    episodeReply = () => fail(404);
    const second = await getOnetouchtvStreams(1, 'movie');
    assert.deepEqual(second.map((s) => s.url), ['https://cdn.example/a.m3u8']);
    assert.equal(calls.episode, 2, 'one 200, one 404, no extra retry when last-good exists');
});

test('last-good is per title: another title 404 with no history still rejects', async () => {
    episodeReply = () => ok(EPISODE);
    await getOnetouchtvStreams(1, 'movie');
    episodeReply = () => fail(404);
    await assert.rejects(getOnetouchtvStreams(2, 'movie'), /HTTP 404/);
});

test('404 with no last-good retries once and returns the retry answer', async () => {
    let n = 0;
    episodeReply = () => (++n === 1 ? fail(404) : ok(EPISODE));
    const out = await getOnetouchtvStreams(3, 'movie');
    assert.equal(out.length, 1);
    assert.equal(calls.episode, 2);
});

test('an expired last-good row is not served', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    episodeReply = () => ok({ sources: [{ url: `https://cdn.example/a.m3u8?expire=${past}`, quality: '1080p', type: 'hls' }] });
    await getOnetouchtvStreams(4, 'movie');
    episodeReply = () => fail(404);
    await assert.rejects(getOnetouchtvStreams(4, 'movie'), /HTTP 404/);
});

// The fan-out (apiServer fetchProviderShared) records n > 0 rows as 'hit' and
// a throw as 'error'. Replaying that rule: 404s after a good answer, across
// more titles than the breaker threshold, must leave the breaker closed.
test('404 after a good answer does not trip the breaker', async () => {
    delete require.cache[metricsMod];
    const m = require('../lib/runtime/metrics');
    const titles = Array.from({ length: m.BREAKER_THRESHOLD + 2 }, (_, i) => 100 + i);

    episodeReply = () => ok(EPISODE);
    for (const id of titles) await getOnetouchtvStreams(id, 'movie');

    episodeReply = () => fail(404);
    for (const id of titles) {
        let outcome;
        try {
            const r = await getOnetouchtvStreams(id, 'movie');
            outcome = r.length > 0 ? 'hit' : 'empty';
        } catch {
            outcome = 'error';
        }
        assert.equal(outcome, 'hit', `title ${id}`);
        m.recordProviderOutcome('onetouchtv_lastgood_test', outcome, 10, 1, true, `movie:${id}::`);
    }
    assert.equal(m.breakerOpen('onetouchtv_lastgood_test'), false);
    assert.equal(m.metrics.providerHealth.onetouchtv_lastgood_test.consecutiveMisses, 0);
});
