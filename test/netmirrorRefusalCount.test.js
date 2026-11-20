'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Prod 2026-11-20 17:43Z (673392): one refused nf search was counted twice,
// once by netflix-lang and once when the nf catalogue replayed the memoised
// refusal, so the newtv base was rediscovered after ONE real failure. Only a
// real request counts.
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Radhe Shyam', release_date: '2022-03-11' }) });
stub('lib/media/mp4AudioProbe.js', { probeAudioTracks: async () => [{ language: null, codec: 'aac', channels: 2 }] });

const { getNetmirrorStreams } = require('../providers/netmirror');

// N7: the NetMirror guard is process-wide; each test starts from a clean one.
const { guard } = require('../utils/netmirrorGuard');
beforeEach(() => guard.reset());

const resp = (status, text) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(text), text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0), headers: new Map(),
});

test('a memoised refusal is not counted a second time', async () => {
    const calls = { checknewtv: 0, search: 0 };
    global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/embed-tmdb/')) {
            return resp(200, JSON.stringify({ ok: true, streams: [{ url: 'https://cdn.example/nf/1080.mp4', resolution: 1080, size: 1 }] }));
        }
        if (u.includes('/checknewtv.php')) {
            calls.checknewtv++;
            return resp(200, JSON.stringify({ token_hash: Buffer.from('https://newtv.example').toString('base64') }));
        }
        if (u.includes('/newtv/ott.php')) return resp(200, JSON.stringify({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) }));
        if (u.includes('/newtv/search.php')) { calls.search++; return resp(403, '<html>Page Not Found</html>'); }
        if (u.startsWith('https://cdn.example/')) return resp(206, '');
        throw new Error(`unexpected fetch ${u}`);
    };
    const logs = [];
    const orig = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try {
        await getNetmirrorStreams(673392, 'movie');
    } finally {
        console.log = orig;
    }
    // N7: the first refusal blocks newtv, so it is the only one: no second
    // count, no rediscovery, one checknewtv.
    assert.equal(calls.search, 1);
    assert.equal(logs.filter((l) => /rediscovering on next resolve/.test(l)).length, 0);
    assert.equal(calls.checknewtv, 1);
});
