'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Prod audit 2026-11-20: newtv answered every primevideo/hotstar search from
// the VM with `403 text/html Page Not Found`, while the Mac got JSON for the
// same request: an IP block, not an empty catalogue. It was read as "no rows"
// and cached; it is now an upstream failure that counts toward rediscovering
// the newtv base. Netflix rows are still returned with it.
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Test Film', release_date: '2024-01-01' }) });
// No audio language from the probe, so every platform catalogue is asked.
stub('lib/media/mp4AudioProbe.js', { probeAudioTracks: async () => [] });

const { getNetmirrorStreams } = require('../providers/netmirror');

// N7: the NetMirror guard is process-wide; each test starts from a clean one.
const { guard } = require('../utils/netmirrorGuard');
beforeEach(() => guard.reset());

const PAGE_NOT_FOUND = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body><h1>Page Not Found</h1></body></html>';
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() });
const html = (status, body) => ({ ok: status < 400, status, json: async () => JSON.parse(body), text: async () => body, arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() });

let calls;
function route(newtvSearch) {
    calls = { embed: 0, search: 0, checknewtv: 0, cdn: 0 };
    global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/embed-tmdb/')) {
            calls.embed++;
            return json({ ok: true, streams: [{ url: 'https://cdn.example/nf/1080.mp4', resolution: 1080, size: 100 }] });
        }
        if (u.includes('/checknewtv.php')) {
            calls.checknewtv++;
            return json({ token_hash: Buffer.from('https://newtv.example').toString('base64') });
        }
        if (u.includes('/newtv/ott.php')) return json({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) });
        if (u.includes('/newtv/search.php')) { calls.search++; return newtvSearch(); }
        if (u.startsWith('https://cdn.example/')) { calls.cdn++; return html(206, ''); }
        throw new Error(`unexpected fetch ${u}`);
    };
}

test('a catalogue answering Page Not Found blocks newtv; Netflix rows kept and cached', async () => {
    route(() => html(200, PAGE_NOT_FOUND));
    const out = await getNetmirrorStreams(5001, 'movie');
    // N7: a refusal is an IP block, not "no rows" and not a blip: newtv is
    // not asked again for 6h, and the reachable rows are the answer.
    assert.ok(guard.newtvBlockedMs() > 0, 'newtv blocked');
    assert.equal(out.upstreamError, undefined);
    assert.deepEqual(out.map((s) => s.url), ['https://cdn.example/nf/1080.mp4']);
    assert.equal(calls.search, 1, 'one refused search, not one per catalogue');

    // Backed off for 90s with the Netflix rows: no upstream request.
    const before = { ...calls };
    const again = await getNetmirrorStreams(5001, 'movie');
    assert.deepEqual(again.map((s) => s.url), ['https://cdn.example/nf/1080.mp4']);
    assert.deepEqual(calls, before, 'second call served from cache');
});

test('a 404 HTML catalogue answer is also no rows', async () => {
    route(() => html(404, '<html>not here</html>'));
    const out = await getNetmirrorStreams(5002, 'movie');
    assert.equal(out.upstreamError, undefined);
    assert.equal(out.length, 1);
});

test('a non-JSON 5xx catalogue answer is still an upstream error, Netflix rows kept', async () => {
    route(() => html(502, '<html>Bad Gateway</html>'));
    const out = await getNetmirrorStreams(5003, 'movie');
    assert.match(String(out.upstreamError), /HTTP 502/);
    assert.equal(out.length, 1, 'Netflix rows still returned');
});
