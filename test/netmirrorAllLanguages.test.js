'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Audit 2026-11-20 (docs/PENDING-WORK.md N1-N4). Kalki 801688: Prime post.php
// lists Kannada/Malayalam/Tamil/Telugu, but NetMirror returned the labelled
// Telugu Netflix mp4 only, because a labelled mp4 stopped every catalogue
// lookup (N2), the Netflix newtv catalogue was never resolved (N3), and the
// prod VM got `403 Page Not Found` from every search, which was cached as
// "no rows" (N1). disney asked the same `hs` catalogue twice (N4).
process.env.NETMIRROR_PLATFORM_GAP_MS = '1';
process.env.NETMIRROR_BUDGET_CALLS = '1000';
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('utils/tmdb.js', { getDetails: async () => ({ title: 'Kalki 2898 AD', release_date: '2024-06-27' }) });
// The embed-tmdb mp4 carries one labelled Telugu track.
stub('lib/media/mp4AudioProbe.js', {
    probeAudioTracks: async () => [{ language: 'Telugu', codec: 'aac', channels: 2 }],
});

const { getNetmirrorStreams } = require('../providers/netmirror');

// N7: the NetMirror guard is process-wide; each test starts from a clean one.
const { guard } = require('../utils/netmirrorGuard');
beforeEach(() => guard.reset());

const resp = (status, text) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => JSON.parse(text), text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0), headers: new Map(),
});
const json = (body) => resp(200, JSON.stringify(body));
const BLOCKED = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body>Page Not Found</body></html>';

const LANGS = {
    nf: ['Telugu', 'Hindi'],
    pv: ['Kannada', 'Malayalam', 'Tamil', 'Telugu'],
};
const master = (langs) => ['#EXTM3U',
    ...langs.map((l, i) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="${l.slice(0, 3).toLowerCase()}",NAME="[${i}] ${l}",URI="https://cdn.example/a/${i}.m3u8"`),
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="aud"',
    'https://cdn.example/v/1080.m3u8', ''].join('\n');

let calls;
function route(opts = {}) {
    calls = { checknewtv: 0, search: [], post: [], player: [] };
    global.fetch = async (url, init) => {
        const u = String(url);
        const ott = init && init.headers && init.headers.Ott;
        if (u.includes('/api/embed-tmdb/')) {
            return json({ ok: true, streams: [{ url: 'https://cdn.example/nf/1080.mp4', resolution: 1080, size: 100 }] });
        }
        if (u.includes('/checknewtv.php')) {
            calls.checknewtv++;
            return json({ token_hash: Buffer.from('https://newtv.example').toString('base64') });
        }
        if (u.includes('/newtv/ott.php')) return json({ ott: ['nf', 'pv', 'hs'].map(value => ({ value })) });
        if (u.includes('/newtv/search.php')) {
            calls.search.push(ott);
            if (opts.blocked && opts.blocked.includes(ott)) return resp(403, BLOCKED);
            if (!LANGS[ott]) return json({ searchResult: [] });
            return json({ searchResult: [{ id: `${ott}-1`, t: 'Kalki 2898 AD' }] });
        }
        if (u.includes('/newtv/post.php')) {
            calls.post.push(ott);
            return json({ type: 'm', year: '2024', main_id: `${ott}-1`,
                lang: LANGS[ott].map((l) => ({ l, s: l.slice(0, 3).toLowerCase() })) });
        }
        if (u.includes('/newtv/player.php')) {
            calls.player.push(ott);
            return json({ status: 'ok', video_link: `https://cdn.example/hls/${ott}/master.m3u8`, referer: 'https://newtv.example/' });
        }
        const m = u.match(/^https:\/\/cdn\.example\/hls\/(\w+)\/master\.m3u8$/);
        if (m) return resp(200, master(LANGS[m[1]]));
        if (u.startsWith('https://cdn.example/')) return resp(206, '');
        throw new Error(`unexpected fetch ${u}`);
    };
}

test('a labelled Netflix mp4 no longer stops the catalogues; every language comes back', async () => {
    route();
    const out = await getNetmirrorStreams(801688, 'movie');
    assert.equal(out.upstreamError, undefined);

    // N2: Prime is asked although the mp4 is already labelled Telugu.
    const prime = out.find((s) => s.name.endsWith('| Prime Video'));
    assert.ok(prime, 'Prime row returned');
    assert.equal(prime.selectableAudio, true);
    assert.deepEqual(prime.audio.map((a) => a.language), ['Kannada', 'Malayalam', 'Tamil', 'Telugu']);

    // N3: the Netflix catalogue HLS master is resolved, and the mp4 stays as
    // its own picture-quality row.
    const nfHls = out.find((s) => s.url === 'https://cdn.example/hls/nf/master.m3u8');
    assert.ok(nfHls, 'Netflix HLS row returned');
    assert.equal(nfHls.selectableAudio, true);
    assert.deepEqual(nfHls.audio.map((a) => a.language), ['Telugu', 'Hindi']);
    const mp4 = out.find((s) => s.url === 'https://cdn.example/nf/1080.mp4');
    assert.ok(mp4, 'Netflix mp4 row kept');
    assert.equal(mp4.quality, '1080p');

    // N4: each catalogue asked once; disney (same hs) is gone.
    assert.deepEqual(calls.search, ['nf', 'pv', 'hs']);
    assert.deepEqual(calls.player, ['nf', 'pv']);
});

test('an unlabelled mp4 reuses the Netflix search and post for the catalogue row', async () => {
    // Re-stub the probe for this case: no language in the file.
    const probe = require.cache[require.resolve(path.join(__dirname, '..', 'lib/media/mp4AudioProbe.js'))].exports;
    const orig = probe.probeAudioTracks;
    probe.probeAudioTracks = async () => [{ language: null, codec: 'aac', channels: 2 }];
    try {
        route();
        const out = await getNetmirrorStreams(801689, 'movie');
        assert.ok(out.find((s) => s.url === 'https://cdn.example/hls/nf/master.m3u8'));
        assert.equal(calls.search.filter((o) => o === 'nf').length, 1, 'one nf search, not two');
        assert.equal(calls.post.filter((o) => o === 'nf').length, 1, 'one nf post, not two');
    } finally {
        probe.probeAudioTracks = orig;
    }
});

test('a 403 Page Not Found search blocks newtv (N7): the rest are not asked, rows kept', async () => {
    route({ blocked: ['pv', 'hs'] });
    const out = await getNetmirrorStreams(801690, 'movie');
    assert.ok(out.find((s) => s.url === 'https://cdn.example/nf/1080.mp4'), 'Netflix rows kept');
    assert.ok(out.find((s) => s.url === 'https://cdn.example/hls/nf/master.m3u8'), 'nf catalogue row kept');
    assert.deepEqual(calls.search, ['nf', 'pv'], 'hs is not asked after the pv refusal');
    assert.ok(guard.newtvBlockedMs() > 0);

    // The next lookup sends no newtv request at all.
    route({ blocked: ['pv', 'hs'] });
    await getNetmirrorStreams(801691, 'movie').catch(() => {});
    assert.deepEqual(calls.search, []);
    assert.equal(calls.checknewtv, 0);
});
