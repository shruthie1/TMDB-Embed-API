'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Krack 784572: embed-tmdb gives the full-length Netflix mp4 (9033s) with its
// one audio track tagged `und`, so it shipped languages:[] and lost to a
// truncated labelled Castle file. Netflix's post.php names the language.
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Krack', release_date: '2021-01-09' }) });
// One untagged (und) track: the probe drops `und` to null.
stub('lib/media/mp4AudioProbe.js', {
    probeAudioTracks: async () => [{ language: null, codec: 'aac', channels: 2 }],
});

const { getNetmirrorStreams } = require('../providers/netmirror');

// N7: the NetMirror guard is process-wide; each test starts from a clean one.
const { guard } = require('../utils/netmirrorGuard');
beforeEach(() => guard.reset());
const { getStore, mediaIdentityOf } = require('../utils/store');

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() });

let calls;
function route(postLang) {
    calls = { search: [], post: [], player: 0 };
    global.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('/api/embed-tmdb/')) {
            return json({ ok: true, streams: [{ url: `https://cdn.example/nf/${postLang.length}/1080.mp4`, resolution: 1080, size: 100 }] });
        }
        if (u.includes('/checknewtv.php')) return json({ token_hash: Buffer.from('https://newtv.example').toString('base64') });
        if (u.includes('/newtv/ott.php')) return json({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) });
        if (u.includes('/newtv/search.php')) {
            const ott = init && init.headers && init.headers.Ott;
            calls.search.push(ott);
            // Only Netflix carries the title; other catalogues have nothing.
            return ott === 'nf' ? json({ searchResult: [{ id: '81000001', t: 'Krack' }] }) : json({ searchResult: [] });
        }
        if (u.includes('/newtv/post.php')) {
            calls.post.push(u);
            return json({ type: 'm', year: '2021', lang: postLang.map((l) => ({ l, s: l.slice(0, 3).toLowerCase() })) });
        }
        if (u.includes('/newtv/player.php')) { calls.player++; return json({}); }
        if (u.startsWith('https://cdn.example/')) return { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
        throw new Error(`unexpected fetch ${u}`);
    };
}

test('post.php with exactly one language labels the row and writes provider evidence', async () => {
    route(['Telugu']);
    const out = await getNetmirrorStreams(784572, 'movie');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].languages, ['Telugu']);
    assert.equal(out[0].audio[0].language, 'Telugu', 'the single und track carries it');
    // Every catalogue is asked even once labelled (N2); the nf catalogue row
    // reuses netflix-lang's search and post (N3), so nf is searched once.
    assert.equal(calls.search.filter((o) => o === 'nf').length, 1, 'one Netflix search');
    assert.ok(calls.search.includes('pv') && calls.search.includes('hs'), 'each other catalogue asked');
    assert.equal(calls.post.length, 1, 'one post.php');
    assert.equal(calls.player, 1, 'one player.php, for the nf catalogue row');
    const ev = getStore().audioEvidenceFor(mediaIdentityOf(out[0].url));
    assert.ok(ev.some((r) => r.source === 'provider' && r.lang === 'Telugu'), 'provider evidence stored');
});

test('post.php listing several languages leaves the row unlabelled', async () => {
    route(['Telugu', 'Hindi', 'Tamil']);
    const out = await getNetmirrorStreams(784573, 'movie');
    assert.equal(out.length, 1);
    assert.equal(out[0].languages, undefined, 'no guess');
    assert.equal(out[0].audio[0].language, null);
    assert.equal(calls.post.length, 1, 'still one post.php, no retry');
    assert.equal(calls.player, 1, 'nf catalogue row only');
    assert.equal(calls.search.filter((o) => o === 'nf').length, 1, 'one Netflix search');
    const ev = getStore().audioEvidenceFor(mediaIdentityOf(out[0].url));
    assert.equal(ev.filter((r) => r.source === 'provider').length, 0, 'no evidence written');
});
