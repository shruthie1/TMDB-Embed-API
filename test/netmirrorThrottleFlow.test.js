'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// N7: getNetmirrorStreams spends as few NetMirror calls as it can, backs off
// when throttled, and reuses every good answer while it is valid.
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '50';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Kalki 2898 AD', release_date: '2024-06-27' }) });
stub('lib/media/mp4AudioProbe.js', { probeAudioTracks: async () => [{ language: 'Telugu', codec: 'aac', channels: 2 }] });

const { getNetmirrorStreams } = require('../providers/netmirror');
const { guard } = require('../utils/netmirrorGuard');

const MIN = 60 * 1000;
let t = 2_000_000_000_000;
guard._setNow(() => t);

const resp = (status, text) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(text), text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0), headers: new Map(),
});

const MASTER_REAL = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="tel",NAME="Telugu",URI="https://cdn.nm/files/81726031/a/0.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.nm/files/81726031/1080p/1080p.m3u8\n';
const MASTER_CLIP = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.nm/files/220884/1080p/1080p.m3u8?in=unknown::ni\n';

// opts: embed (rows or 429), search: 'refuse' | 'ok', playerStatus, master,
// videoLink.
function install(opts) {
    const calls = { embed: 0, checknewtv: 0, search: 0, post: 0, player: 0, master: 0, newtv: 0 };
    global.fetch = async (url, init = {}) => {
        const u = String(url);
        // dropThrottled's ranged CDN probe of each row, not a master read.
        if (init.headers && init.headers.Range) return resp(206, '');
        if (u.includes('/api/embed-tmdb/')) {
            calls.embed++;
            if (opts.embed === 429) return resp(429, 'Too Many Requests');
            return resp(200, JSON.stringify({ ok: true, streams: [{ url: 'https://mp4.nm/kalki/360.mp4', resolution: 360, size: 1 }] }));
        }
        if (u.includes('/checknewtv.php')) {
            calls.checknewtv++; calls.newtv++;
            return resp(200, JSON.stringify({ token_hash: Buffer.from('https://newtv.example').toString('base64') }));
        }
        if (u.includes('/newtv/ott.php')) { calls.newtv++; return resp(200, JSON.stringify({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) })); }
        if (u.includes('/newtv/search.php')) {
            calls.search++; calls.newtv++;
            if (opts.search === 'refuse') return resp(403, '﻿<html><title>Page Not Found</title></html>');
            return resp(200, JSON.stringify({ searchResult: [{ id: '81726031', t: 'Kalki 2898 AD' }] }));
        }
        if (u.includes('/newtv/post.php')) {
            calls.post++; calls.newtv++;
            return resp(200, JSON.stringify({ type: 'm', year: '2024', main_id: '81726031', runtime: '2h 55m',
                lang: [{ l: 'Telugu', s: 'tel' }], episodes: [null], suggest: [{ id: 'big' }] }));
        }
        if (u.includes('/newtv/player.php')) {
            calls.player++; calls.newtv++;
            if (opts.player === 429) return resp(429, 'Too Many Requests');
            return resp(200, JSON.stringify({ status: opts.playerStatus || 'ok',
                video_link: opts.videoLink || 'https://cdn.nm/hls/nf/81726031.m3u8', referer: 'https://newtv.example/' }));
        }
        if (u.startsWith('https://cdn.nm/hls/')) { calls.master++; return resp(200, opts.master || MASTER_REAL); }
        if (u.startsWith('https://mp4.nm/') || u.startsWith('https://cdn.nm/')) return resp(206, '');
        throw new Error(`unexpected fetch ${u}`);
    };
    return calls;
}

async function quietly(fn) {
    const logs = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };
    try { return { out: await fn().catch((e) => e), logs }; } finally { console.log = orig; console.error = origErr; }
}

beforeEach(() => { t += 24 * 60 * MIN; guard.reset(); });

test('VM refusal: one refused search blocks newtv; the next lookup makes zero newtv calls', async () => {
    const calls = install({ search: 'refuse' });
    const first = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.equal(calls.search, 1, 'one refused search, not three');
    assert.equal(calls.checknewtv, 1);
    assert.ok(first.logs.some((l) => /^\[netmirror\] newtv-block reason=page-not-found for=21600s/.test(l)), first.logs.join('\n'));
    assert.ok(Array.isArray(first.out) && first.out.length === 1, 'embed row still served');
    assert.equal(first.out.upstreamError, undefined, 'a known block is not a blip: the reachable answer is complete');

    // Past the rows cache, still inside the 6h block.
    t += 30 * MIN;
    const before = calls.newtv;
    const second = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.equal(calls.newtv - before, 0, 'zero newtv calls while blocked');
    assert.equal(second.out.length, 1);

    // After 6h: one re-probe, refused again, blocked again.
    t += 6 * 60 * MIN;
    const at = calls.search;
    await quietly(() => getNetmirrorStreams(801689, 'movie'));
    assert.equal(calls.search - at, 1, 'exactly one re-probe search');
});

test('cache hit: search and post are reused for days; player until the link expires', async () => {
    const exp = Math.floor((t + 3 * 60 * MIN) / 1000);
    const calls = install({ videoLink: `https://cdn.nm/hls/nf/81726031.m3u8?e=${exp}` });
    const first = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.ok(first.out.some((r) => /Netflix/.test(r.name) && r.selectableAudio), first.logs.join('\n'));
    const searches = calls.search; const posts = calls.post; const players = calls.player; const masters = calls.master;
    assert.ok(searches >= 1 && posts >= 1 && players >= 1);

    // Rows cache expired (26 min), player link still valid (3h): no newtv call at all.
    t += 26 * MIN;
    const second = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.equal(calls.search - searches, 0, 'search from cache');
    assert.equal(calls.post - posts, 0, 'post from cache');
    assert.equal(calls.player - players, 0, 'player from cache until expiry');
    assert.equal(calls.master - masters, 0, 'master already verified');
    assert.deepEqual(second.out.map((r) => r.url), first.out.map((r) => r.url));

    // Past the link expiry, inside 7 days: only player.php (+ master) again.
    t += 4 * 60 * MIN;
    await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.equal(calls.search - searches, 0);
    assert.equal(calls.post - posts, 0);
    assert.equal(calls.player - players, players, 'one player.php per catalogue hit (nf, pv, hs)');
});

test('throttle: otp + clip master opens the cool-down; then zero NetMirror calls, rows from cache', async () => {
    // A good answer first, so there is something to serve.
    let calls = install({});
    const good = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.ok(good.out.length >= 2);

    t += 26 * MIN; // rows cache expired; player cache expired too (no ?e=)
    calls = install({ playerStatus: 'otp', master: MASTER_CLIP });
    const hit = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.ok(hit.logs.some((l) => /^\[netmirror\] throttle-open reason=clip for=600s/.test(l)), hit.logs.join('\n'));
    assert.equal(calls.player, 1, 'the first clip stops the remaining catalogues');
    assert.ok(!hit.out.some((r) => /220884/.test(r.url)), 'clip never served');

    // Inside the cool-down: zero NetMirror calls of any kind.
    t += 2 * MIN;
    calls = install({});
    const cooled = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.equal(calls.embed + calls.newtv + calls.master, 0, 'zero calls during cool-down');
    assert.equal(cooled.out.upstreamError, 'netmirror-throttled');
    assert.ok(cooled.out.length >= 1, 'cached rows served');

    // After it: a real master closes it.
    t += 10 * MIN;
    const closed = await quietly(() => getNetmirrorStreams(801688, 'movie'));
    assert.ok(closed.logs.some((l) => /^\[netmirror\] throttle-close reason=real-master/.test(l)), closed.logs.join('\n'));
    assert.equal(guard.coolingMs(), 0);
});

test('HTTP 429 from embed-tmdb opens the NetMirror-wide cool-down', async () => {
    const calls = install({ embed: 429 });
    const r = await quietly(() => getNetmirrorStreams(811941, 'movie'));
    assert.ok(r.logs.some((l) => /throttle-open reason=http-429/.test(l)), r.logs.join('\n'));
    assert.equal(calls.newtv, 0, 'no newtv call after the 429');
    assert.ok(guard.coolingMs() > 0);
});

test('budget: an empty bucket skips newtv at once and answers embed rows + netmirror-budget', async () => {
    while (guard.take()) { /* drain */ }
    const calls = install({});
    const t0 = Date.now();
    const r = await quietly(() => getNetmirrorStreams(811941, 'movie'));
    assert.ok(Date.now() - t0 < 2000, 'does not wait for tokens');
    assert.equal(calls.newtv, 0);
    assert.equal(calls.embed, 1, 'embed path is exempt');
    assert.equal(r.out.upstreamError, 'netmirror-budget');
    assert.equal(r.out.length, 1);
});
