'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { streamFromMaster, audioFromMaster, looksLikeImage, STREAM_HEADERS } = require('../providers/multimovies');
const { normaliseStream } = require('../utils/streamSchema');

// Recorded 2026-11-20: vidbolt.xyz/api/resolve?type=movie&id=784572 (Krack).
// One master, four dubbed languages as AUDIO renditions, letterboxed 1920x800.
const KRACK_URL = 'https://img.rousav.tech/media/830010a43bd0e6cc32f9/index.m3u8?api_key=k';
const KRACK = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English  [CC]",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en-us.[CC]",URI="subtitles_englishcc.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="kan",NAME="[1] Kannada",DEFAULT=NO,URI="track_kannada.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="mal",NAME="[2] Malayalam",DEFAULT=NO,URI="track_malayalam.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tam",NAME="[3] Tamil",DEFAULT=NO,URI="track_tamil.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tel",NAME="[4] Telugu",DEFAULT=NO,URI="track_telugu.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aac",RESOLUTION=1920x800,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'tiles.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac",DEFAULT=YES,RESOLUTION=1280x528,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'video_720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aac",RESOLUTION=960x400,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'video_480p.m3u8', '',
].join('\n');

// Recorded 2026-11-20: same api, Inception (27205).
const INCEPTION = [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="eng",NAME="1. English",DEFAULT=YES,URI="track_english.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="hin",NAME="2. Hindi",DEFAULT=NO,URI="track_hindi.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aac",RESOLUTION=1920x1080', 'tiles.m3u8', '',
].join('\n');

test('Krack: every AUDIO rendition is listed, Telugu first, selectable', () => {
    const row = streamFromMaster({ quality: '1080p' }, KRACK, KRACK_URL);
    assert.deepEqual(row.audio.map((a) => a.language), ['kan', 'mal', 'tam', 'tel']);
    assert.equal(row.selectableAudio, true);
    const n = normaliseStream(row);
    assert.deepEqual(n.languages, ['Telugu', 'Kannada', 'Malayalam', 'Tamil']);
    assert.deepEqual(n.audio.map((a) => a.language), ['Kannada', 'Malayalam', 'Tamil', 'Telugu']);
    assert.equal(n.selectableAudio, true);
});

test('Krack: letterboxed 1920x800 reads as 1080p, the real master URL is kept', () => {
    const n = normaliseStream(streamFromMaster({}, KRACK, KRACK_URL));
    assert.equal(n.quality, '1080p');
    assert.equal(n.url, KRACK_URL);
    assert.equal(n.container, 'hls');
    assert.deepEqual(n.levels.map((l) => l.height), [800, 528, 400]);
});

test('stream carries VidBolt Referer/Origin for /m3u8-proxy', () => {
    const row = streamFromMaster({}, INCEPTION, 'https://x/index.m3u8');
    assert.equal(row.headers.Referer, 'https://vidbolt.xyz/');
    assert.equal(row.headers.Origin, 'https://vidbolt.xyz');
    assert.deepEqual(STREAM_HEADERS, row.headers);
});

test('Inception: English + Hindi, no Telugu invented', () => {
    const n = normaliseStream(streamFromMaster({}, INCEPTION, 'https://x/index.m3u8'));
    assert.deepEqual(n.languages, ['English', 'Hindi']);
    assert.equal(n.selectableAudio, true);
});

test('a master with no AUDIO renditions is not selectable and claims no language', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv.m3u8\n';
    const n = normaliseStream(streamFromMaster({}, text, 'https://x/m.m3u8'));
    assert.equal(n.selectableAudio, false);
    assert.deepEqual(n.languages, []);
    assert.deepEqual(n.audio, []);
});

test('an untagged rendition keeps its NAME as the language', () => {
    const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="und",NAME="[1] Telugu",URI="t.m3u8"\n'
        + '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a",RESOLUTION=1920x1080\nv.m3u8\n';
    assert.deepEqual(audioFromMaster(text, 'https://x/m.m3u8').map((a) => a.language), ['Telugu']);
});

test('a master with no variants yields no row', () => {
    assert.equal(streamFromMaster({}, '#EXTM3U\n#EXTINF:4,\na.ts\n', 'https://x/m.m3u8'), null);
});

test('image-header segments are detected; MPEG-TS is not', () => {
    assert.equal(looksLikeImage([0x89, 0x50, 0x4e, 0x47, 0x0d]), true);
    assert.equal(looksLikeImage([0xff, 0xd8, 0xff]), true);
    assert.equal(looksLikeImage([0x47, 0x49, 0x46, 0x38]), true);
    // Krack's ".png" segments are real TS: sync byte 0x47 then PID bytes.
    assert.equal(looksLikeImage([0x47, 0x40, 0x11, 0x10]), false);
});

// Network fixtures for getMultimoviesStreams. `hang` URLs never answer until
// their AbortSignal fires, like Krack's kan/mal/tam playlists (2026-11-20:
// three of four timed out at 30s, Telugu answered in 593ms).
function stubFetch(t, routes) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = (url, opts = {}) => {
        const u = String(url);
        calls.push(u);
        const route = routes.find(([re]) => re.test(u));
        if (!route) return Promise.resolve(new Response('', { status: 404 }));
        const body = route[1];
        if (body === 'hang') {
            return new Promise((_, reject) => {
                const s = opts.signal;
                if (s) s.addEventListener('abort', () => reject(s.reason || new Error('aborted')));
            });
        }
        return Promise.resolve(typeof body === 'function' ? body(u) : new Response(body, { status: 200 }));
    };
    t.after(() => { global.fetch = realFetch; });
    return calls;
}

const KRACK_API = JSON.stringify({ stream: { server: 'vidbolt', sources: [{ url: KRACK_URL, kind: 'hls', quality: '1080p' }] } });

test('P6a: audio renditions whose playlist does not answer are dropped; Telugu kept', async (t) => {
    const mm = require('../providers/multimovies');
    mm._config.audioTimeoutMs = 100;
    mm._clearDisguiseCache();
    t.after(() => { mm._config.audioTimeoutMs = 8000; });
    stubFetch(t, [
        [/\/api\/resolve/, KRACK_API],
        [/index\.m3u8/, KRACK],
        [/track_telugu/, '#EXTM3U\n#EXTINF:4,\na.aac\n'],
        [/track_(kannada|malayalam|tamil)/, 'hang'],
        [/tiles\.m3u8/, '#EXTM3U\n#EXTINF:4,\ns0.png\n'],
        [/s0\.png/, () => new Response(Buffer.from([0x47, 0x40, 0x11, 0x10]), { status: 206 })],
    ]);
    const rows = await mm.getMultimoviesStreams('784572', 'movie');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].audio.map((a) => a.language), ['tel']);
    assert.deepEqual(rows[0].languages, ['tel']);
    assert.equal(rows[0].selectableAudio, true);
    await mm._disguiseSettled();
});

test('P6b: the disguised-segment check does not hold up the resolve, and is cached per host', async (t) => {
    const mm = require('../providers/multimovies');
    mm._clearDisguiseCache();
    let segHits = 0;
    stubFetch(t, [
        [/\/api\/resolve/, KRACK_API],
        [/index\.m3u8/, KRACK],
        [/track_/, '#EXTM3U\n#EXTINF:4,\na.aac\n'],
        [/tiles\.m3u8/, '#EXTM3U\n#EXTINF:4,\ns0.png\n'],
        [/s0\.png/, () => {
            segHits += 1;
            // A slow host: answers an image header after 300ms.
            return new Promise((res) => setTimeout(() => res(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 206 })), 300));
        }],
    ]);
    const t0 = Date.now();
    const first = await mm.getMultimoviesStreams('784572', 'movie');
    assert.ok(Date.now() - t0 < 250, `resolve waited for the check: ${Date.now() - t0}ms`);
    assert.equal(first.length, 1, 'unknown host fails open');
    await mm._disguiseSettled();
    const second = await mm.getMultimoviesStreams('784572', 'movie');
    assert.equal(second.length, 0, 'cached disguised host drops the row');
    await mm._disguiseSettled();
    assert.equal(segHits, 1, 'one check per host');
});

// Recorded 2026-11-21: RRR (579974) VidBolt Telugu bridge master, signature
// redacted. AUDIO is NAME="Audio" with no LANGUAGE; vidbolt /api/resolve says
// language "Telugu" for this source. Before: languages ['Audio'].
const RRR_BRIDGE = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'multimovies', 'rrr-bridge-telugu.m3u8'), 'utf8');
const RRR_URL = 'https://dash-hls-bridge.johndoesdmc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5820588283537016992_0_0_1080_h265_795%2Fmaster.m3u8';

test('RRR bridge: generic "Audio" rendition takes VidBolt source language, Telugu', () => {
    const n = normaliseStream(streamFromMaster({ quality: '1080p', language: 'Telugu' }, RRR_BRIDGE, RRR_URL));
    assert.deepEqual(n.languages, ['Telugu']);
    assert.deepEqual(n.audio.map((a) => a.language), ['Telugu']);
    assert.equal(n.selectableAudio, true);
    assert.equal(n.videoCodec, 'hevc');
});

test('RRR bridge: a master that states a real LANGUAGE still wins over the source', () => {
    const tagged = RRR_BRIDGE.replace('NAME="Audio"', 'NAME="Audio",LANGUAGE="hin"');
    const n = normaliseStream(streamFromMaster({ language: 'Telugu' }, tagged, RRR_URL));
    assert.deepEqual(n.languages, ['Hindi']);
});

test('RRR bridge: no source language keeps the old fallback, nothing dropped', () => {
    const n = normaliseStream(streamFromMaster({}, RRR_BRIDGE, RRR_URL));
    assert.deepEqual(n.audio.map((a) => a.name), ['Audio']);
    assert.equal(n.audio.length, 1);
});

test('RRR bridge: "Arabic sub" is a subtitle label, not an audio language', () => {
    const n = normaliseStream(streamFromMaster({ language: 'Arabic sub' }, RRR_BRIDGE, RRR_URL));
    assert.ok(!n.languages.includes('Arabic'));
    assert.equal(n.audio.length, 1);
});

test('RRR bridge: a named (non-generic) rendition is not overridden by the source', () => {
    const named = RRR_BRIDGE.replace('NAME="Audio"', 'NAME="Tamil"');
    const n = normaliseStream(streamFromMaster({ language: 'Telugu' }, named, RRR_URL));
    assert.deepEqual(n.languages, ['Tamil']);
});

test('RRR bridge: two generic renditions are left as the master states (no stamp)', () => {
    const two = RRR_BRIDGE.replace(/(#EXT-X-MEDIA:TYPE=AUDIO[^\n]*NAME=)"Audio"([^\n]*)/, '$1"Audio 1"$2\n$1"Audio 2"$2');
    const n = normaliseStream(streamFromMaster({ language: 'Telugu' }, two, RRR_URL));
    assert.equal(n.audio.length, 2);
    assert.ok(!n.audio.some((a) => a.language === 'Telugu'), 'no Telugu stamped on two renditions');
});

test('RRR bridge: an unrecognised source label ("Hindi Dubbed") does not replace "Audio"', () => {
    const n = normaliseStream(streamFromMaster({ language: 'Hindi Dubbed' }, RRR_BRIDGE, RRR_URL));
    assert.deepEqual(n.audio.map((a) => a.name), ['Audio']);
    assert.ok(!n.languages.some((l) => /dub/i.test(l)), n.languages.join(','));
});

test('RRR bridge: source "Original" never takes the TMDB language; the row reads Original', () => {
    for (const tmdb of ['te', null]) {
        const row = streamFromMaster({ language: 'Original' }, RRR_BRIDGE, RRR_URL, null, tmdb);
        assert.ok(!normaliseStream(row).languages.includes('Telugu'));
        assert.match(row.name, /\| Original$/);
    }
});

test('getMultimoviesStreams: an "Original" source asks TMDB nothing and stays unlabelled', async () => {
    const mm = require('../providers/multimovies');
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/api/resolve')) {
            return { ok: true, status: 200, json: async () => ({ stream: { server: 'x', sources: [{ url: RRR_URL, kind: 'hls', quality: '1080p', language: 'Original' }] } }) };
        }
        if (u === RRR_URL) return { ok: true, status: 200, text: async () => RRR_BRIDGE };
        return { ok: true, status: 200, text: async () => '#EXTM3U\n', body: null, arrayBuffer: async () => new ArrayBuffer(16) };
    };
    try {
        const rows = await mm.getMultimoviesStreams('579974', 'movie');
        assert.equal(rows.length, 1);
        assert.ok(!normaliseStream(rows[0]).languages.includes('Telugu'));
        assert.match(rows[0].title, /Original/);
        assert.ok(!calls.some((u) => /themoviedb|tmdb\.org/.test(u)), 'no TMDB call');
        assert.equal(mm._config.tmdbWaitMs, undefined, 'no TMDB wait');
    } finally {
        global.fetch = realFetch;
        await mm._disguiseSettled();
    }
});

// Old APKs (1.2.40) sideload row.subtitles as VTT; a .m3u8 playlist there
// blocked start on a phone. The master already carries the HLS subtitle track.
test('subtitles: HLS playlist URLs are not emitted, real vtt/srt are kept', () => {
    const krack = streamFromMaster({}, KRACK, KRACK_URL);
    assert.deepEqual(krack.subtitles, []);
    const mixed = KRACK.replace('URI="subtitles_englishcc.m3u8"', 'URI="subs/en.vtt"')
        + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Telugu",LANGUAGE="tel",URI="subs/te.srt?x=1"\n'
        + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Hindi",LANGUAGE="hin",URI="https://b.example/?url=https%3A%2F%2Fx%2Fhi.m3u8"\n';
    const row = streamFromMaster({}, mixed, KRACK_URL);
    assert.deepEqual(row.subtitles.map((s) => s.url.replace(/^.*\//, '')), ['en.vtt', 'te.srt?x=1']);
});

// ---- Every VidBolt server (2026-11-21). The plain resolve picked `luna` for
// RRR (one 720p source, language null) while `only=callisto` had the Telugu
// bridge masters. Every server is asked and the rows are merged.
const LUNA_URL = 'https://stream.vidbolt.xyz/v/luna-rrr.m3u8';
const LUNA_MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n/v/l720.m3u8\n';
const RRR_TE2 = RRR_URL.replace('5820588283537016992_0_0_1080_h265_795', '5355663801620775816_0_0_1080_h265_623');
const sign = (u, n) => `${u}%26Signature%3Dsig${n}`; // rotating signature, same master
const resolveBody = (server, sources) => JSON.stringify({ stream: sources ? { server, sources } : null });
const serverOf = (u) => (/[?&]only=([^&]+)/.exec(u) || [])[1] || null;

// VidBolt as measured for RRR: plain -> luna, callisto -> 2 Telugu + Arabic sub, others null.
function rrrVidbolt({ embed = '', slow = [], fail = [] } = {}) {
    return [
        [/\/api\/resolve/, (u) => {
            const s = serverOf(u);
            if (fail.includes(s || 'default')) return new Response('nope', { status: fail.status || 500 });
            if (s === 'callisto') {
                return new Response(resolveBody('callisto', [
                    { url: sign(RRR_URL, 1), kind: 'hls', quality: '1080p', language: 'Telugu' },
                    { url: sign(RRR_TE2, 1), kind: 'hls', quality: '1080p', language: 'Telugu' },
                    { url: 'https://proxy.vidbolt.xyz/f/x.mp4', kind: 'mp4', quality: '1080p', language: 'Russian' },
                ]), { status: 200 });
            }
            if (s === 'luna' || s === null) {
                return new Response(resolveBody('luna', [{ url: LUNA_URL, kind: 'hls', quality: '720p', language: null }]), { status: 200 });
            }
            if (slow.includes(s)) return 'hang';
            return new Response(resolveBody(s, null), { status: 200 });
        }],
        [/vidbolt\.xyz\/movie\//, embed],
        [/luna-rrr\.m3u8/, LUNA_MASTER],
        [/dash-hls-bridge/, (u) => new Response(RRR_BRIDGE, { status: 200 })],
    ];
}

// stubFetch with function routes that may answer 'hang'.
function stubVidbolt(t, routes) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = (url, opts = {}) => {
        const u = String(url);
        calls.push(u);
        const route = routes.find(([re]) => re.test(u));
        if (!route) return Promise.resolve(new Response('', { status: 404 }));
        let body = route[1];
        if (typeof body === 'function') body = body(u);
        if (body === 'hang') {
            return new Promise((_, reject) => {
                const s = opts.signal;
                if (s) s.addEventListener('abort', () => reject(s.reason || new Error('aborted')));
            });
        }
        return Promise.resolve(body instanceof Response ? body : new Response(body, { status: 200 }));
    };
    t.after(() => { global.fetch = realFetch; });
    return calls;
}

function freshMM(t, cfg = {}) {
    const mm = require('../providers/multimovies');
    const saved = { ...mm._config };
    Object.assign(mm._config, { audioTimeoutMs: 200 }, cfg);
    mm._clearServerList();
    mm._clearDisguiseCache();
    t.after(async () => { Object.assign(mm._config, saved); mm._clearServerList(); await mm._disguiseSettled(); });
    return mm;
}

test('all servers: plain resolve gives luna, callisto adds its two "Telugu" rows; only the later one stays Telugu', async (t) => {
    const mm = freshMM(t);
    const calls = stubVidbolt(t, rrrVidbolt());
    const rows = (await mm.getMultimoviesStreams('579974', 'movie')).map(normaliseStream);
    // The dropped claim's rendition is NAME "Audio", no LANGUAGE: unknown,
    // never the language "Audio" (VM 2026-11-24 shipped languages ["Audio"]).
    assert.deepEqual(rows.map((r) => r.languages.join('/')), ['', '', 'Telugu']);
    assert.equal(rows.filter((r) => r.languages.includes('Telugu')).length, 1);
    assert.match(rows.find((r) => r.languages.includes('Telugu')).url, /5355663801620775816/);
    assert.ok(rows.every((r) => r.container === 'hls'), 'mp4 sources stay out');
    const asked = calls.filter((u) => u.includes('/api/resolve')).map((u) => serverOf(u) || 'default');
    assert.deepEqual(asked.sort(), ['callisto', 'default', 'luna', 'orion', 'quantum', 'quasar', 'vega']);
});

test('all servers: the same master from two servers (other signature) is one row', async (t) => {
    const mm = freshMM(t);
    const routes = rrrVidbolt();
    const inner = routes[0][1];
    routes[0][1] = (u) => (serverOf(u) === 'orion'
        ? new Response(resolveBody('orion', [{ url: sign(RRR_URL, 2), kind: 'hls', quality: '1080p', language: 'Telugu' }]), { status: 200 })
        : inner(u));
    stubVidbolt(t, routes);
    const rows = await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(rows.length, 3);
    assert.equal(mm.masterKey(sign(RRR_URL, 1)), '5820588283537016992');
    assert.equal(mm.masterKey(sign(RRR_URL, 1)), mm.masterKey(sign(RRR_URL, 2)));
});

test('all servers: the embed page server list is used, a new server is asked, and the list is cached', async (t) => {
    const mm = freshMM(t);
    const embed = '<script>var C={"servers":[{"id":"callisto","name":"Callisto"},{"id":"nova","name":"Nova"}],"name":"RRR"}</script>';
    const calls = stubVidbolt(t, rrrVidbolt({ embed }));
    await mm.getMultimoviesStreams('579974', 'movie');
    assert.ok(calls.some((u) => serverOf(u) === 'nova'), 'new server from the embed page is asked');
    calls.length = 0;
    await mm.getMultimoviesStreams('579974', 'movie');
    const asked = calls.filter((u) => u.includes('/api/resolve')).map((u) => serverOf(u) || 'default').sort();
    // luna is not on the page but the plain resolve named it, so it is asked too.
    assert.deepEqual(asked, ['callisto', 'default', 'luna', 'nova'], 'cached list replaces the fallback list');
    assert.ok(!calls.some((u) => /vidbolt\.xyz\/movie\//.test(u)), 'embed page not fetched again');
});

test('all servers: an unreadable embed page keeps the fallback list', async (t) => {
    const mm = freshMM(t);
    assert.deepEqual(mm.parseServerIds('<html>no config</html>'), null);
    assert.deepEqual(mm.parseServerIds('"servers":[{"id":"orion"},{"id":"bad id!"},{"id":"luna"}]'), ['orion', 'luna']);
    const calls = stubVidbolt(t, rrrVidbolt({ embed: '<html></html>' }));
    await mm.getMultimoviesStreams('579974', 'movie');
    const asked = calls.filter((u) => u.includes('/api/resolve')).map((u) => serverOf(u)).filter(Boolean).sort();
    assert.deepEqual(asked, [...mm.FALLBACK_SERVERS].sort());
});

test('all servers: a server that never answers does not hold the result past settleMs', async (t) => {
    const mm = freshMM(t, { settleMs: 100, resolveStepMs: 2000 });
    stubVidbolt(t, rrrVidbolt({ slow: ['vega', 'quantum'] }));
    const t0 = Date.now();
    const rows = await mm.getMultimoviesStreams('579974', 'movie');
    const ms = Date.now() - t0;
    assert.ok(ms < 600, `took ${ms}ms`);
    assert.equal(rows.length, 3);
    // vega/quantum may hold the only Telugu master: partial, so it is not cached.
    assert.match(rows.upstreamError, /not heard: vega\(cut\),quantum\(cut\)/);
});

test('all servers: every server hangs -> the step cap ends the call and it throws', async (t) => {
    const mm = freshMM(t, { settleMs: 50, resolveStepMs: 150 });
    stubVidbolt(t, [[/\/api\/resolve/, 'hang'], [/vidbolt\.xyz\/movie\//, 'hang']]);
    const t0 = Date.now();
    await assert.rejects(mm.getMultimoviesStreams('579974', 'movie'), /vidbolt resolve failed/);
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms`);
});

test('all servers: plain resolve 2xx with no stream is a trusted empty; all HTTP errors throw', async (t) => {
    const mm = freshMM(t);
    stubVidbolt(t, [[/\/api\/resolve/, (u) => new Response(resolveBody(serverOf(u), null), { status: 200 })]]);
    const empty = await mm.getMultimoviesStreams('1', 'movie');
    assert.deepEqual(empty, []);
    assert.equal(empty.upstreamError, undefined, 'every server answered: a complete, cacheable empty');
    mm._clearServerList();
    stubVidbolt(t, [[/\/api\/resolve/, () => new Response('x', { status: 500 })]]);
    await assert.rejects(mm.getMultimoviesStreams('1', 'movie'), /HTTP 500/);
});

test('all servers: one server erroring keeps the rows and marks the result partial', async (t) => {
    const mm = freshMM(t);
    stubVidbolt(t, rrrVidbolt({ fail: ['orion'] }));
    const rows = await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(rows.length, 3);
    assert.match(rows.upstreamError, /orion/);
});

test('all servers: HTTP 429 pauses the fan-out, next call asks only the plain resolve', async (t) => {
    const mm = freshMM(t);
    const fail = ['quasar']; fail.status = 429;
    const calls = stubVidbolt(t, rrrVidbolt({ fail }));
    const first = await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(first.length, 3);
    calls.length = 0;
    const second = await mm.getMultimoviesStreams('579974', 'movie');
    assert.deepEqual(calls.filter((u) => u.includes('/api/resolve')).map(serverOf), [null]);
    assert.equal(second.length, 1, 'cooldown: luna only, as before this change');
});

test('all servers: tv asks only=<server> with season and episode, Referer is the embed path', async (t) => {
    const mm = freshMM(t);
    const seen = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/api/resolve')) seen.push([u, opts.headers && opts.headers.Referer]);
        return new Response(u.includes('/api/resolve') ? resolveBody(null, null) : '', { status: 200 });
    };
    t.after(() => { global.fetch = realFetch; });
    await mm.getMultimoviesStreams('1399', 'tv', 2, 3);
    const callisto = seen.find(([u]) => serverOf(u) === 'callisto');
    assert.match(callisto[0], /type=tv&id=1399&season=2&episode=3&only=callisto$/);
    assert.equal(callisto[1], 'https://vidbolt.xyz/tv/1399/2/3');
});

test('all servers: a complete answer is not partial; a 429 or its back-off is partial', async (t) => {
    const mm = freshMM(t);
    stubVidbolt(t, rrrVidbolt());
    const full = await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(full.upstreamError, undefined, 'all servers answered: cacheable');
    mm._clearServerList();
    const fail = ['quasar']; fail.status = 429;
    stubVidbolt(t, rrrVidbolt({ fail }));
    const hit = await mm.getMultimoviesStreams('579974', 'movie');
    assert.match(hit.upstreamError, /quasar\(HTTP 429\)/);
    const backoff = await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(backoff.length, 1);
    assert.match(backoff.upstreamError, /429 back-off/);
});

// Owner ruling 2026-11-21: per-server cooldown. quantum was unheard on every
// counted run, which made every answer partial and uncached.
test('cooldown: 3 unheard asks in a row cool a server for an hour; then one probe; 2xx clears', async (t) => {
    const mm = freshMM(t, { settleMs: 50, resolveStepMs: 1000, cooldownMs: 60 * 60 * 1000 });
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    t.after(() => { console.log = realLog; });
    let quantumAnswers = false;
    const routes = rrrVidbolt();
    const inner = routes[0][1];
    routes[0][1] = (u) => (serverOf(u) === 'quantum' && !quantumAnswers ? 'hang' : inner(u));
    const calls = stubVidbolt(t, routes);
    for (let i = 0; i < 3; i++) {
        const rows = await mm.getMultimoviesStreams('579974', 'movie');
        assert.match(rows.upstreamError, /quantum\(cut\)/, `ask ${i + 1}: quantum outside cooldown and unheard -> partial`);
    }
    assert.ok(logs.includes('multimovies: server-cooldown quantum on streak=3'), logs.join('\n'));
    calls.length = 0;
    const cooledRows = await mm.getMultimoviesStreams('579974', 'movie');
    assert.ok(!calls.some((u) => serverOf(u) === 'quantum'), 'a cooled server is not asked');
    assert.equal(cooledRows.upstreamError, undefined, 'a cooled server does not make the result partial');
    assert.equal(cooledRows.length, 3);
    // The hour is over: one probe; it answers 2xx, the streak clears.
    mm._config.cooldownMs = 0;
    mm._serverHealthSet('quantum', { until: 0 });
    quantumAnswers = true;
    calls.length = 0;
    const probed = await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(calls.filter((u) => serverOf(u) === 'quantum').length, 1);
    assert.equal(probed.upstreamError, undefined);
    assert.ok(logs.includes('multimovies: server-cooldown quantum off streak=0'), logs.join('\n'));
    assert.equal(mm._serverHealth('quantum').streak, 0);
});

test('cooldown: a failed probe cools the server for another hour', async (t) => {
    const mm = freshMM(t);
    const routes = rrrVidbolt({ fail: ['vega'] });
    const calls = stubVidbolt(t, routes);
    for (let i = 0; i < 3; i++) await mm.getMultimoviesStreams('579974', 'movie');
    mm._serverHealthSet('vega', { until: 0 });
    const probe = await mm.getMultimoviesStreams('579974', 'movie');
    assert.match(probe.upstreamError, /vega\(HTTP 500\)/, 'the probe was asked and unheard -> partial');
    assert.equal(mm._serverHealth('vega').streak, 4);
    assert.ok(mm._serverHealth('vega').until > Date.now() + 59 * 60 * 1000);
    calls.length = 0;
    await mm.getMultimoviesStreams('579974', 'movie');
    assert.ok(!calls.some((u) => serverOf(u) === 'vega'));
});

test('cooldown: callisto (Telugu) is never cooled and its absence always marks partial', async (t) => {
    const mm = freshMM(t);
    const calls = stubVidbolt(t, rrrVidbolt({ fail: ['callisto'] }));
    for (let i = 0; i < 5; i++) {
        calls.length = 0;
        const rows = await mm.getMultimoviesStreams('579974', 'movie');
        assert.ok(calls.some((u) => serverOf(u) === 'callisto'), `ask ${i + 1}: callisto asked`);
        assert.match(rows.upstreamError, /callisto\(HTTP 500\)/);
    }
    assert.equal(mm._serverHealth('callisto').until, 0);
});

test('cooldown: a 429 neither adds to nor clears a server streak', async (t) => {
    const mm = freshMM(t);
    stubVidbolt(t, rrrVidbolt({ fail: ['vega'] }));
    await mm.getMultimoviesStreams('579974', 'movie');
    await mm.getMultimoviesStreams('579974', 'movie');
    assert.equal(mm._serverHealth('vega').streak, 2);
    const fail = ['vega']; fail.status = 429;
    stubVidbolt(t, rrrVidbolt({ fail }));
    const limited = await mm.getMultimoviesStreams('579974', 'movie');
    assert.match(limited.upstreamError, /vega\(HTTP 429\)/, 'a 429 still marks partial');
    assert.equal(mm._serverHealth('vega').streak, 2, '429 does not add');
    assert.equal(mm._serverHealth('vega').until, 0, 'not cooled');
});

test('teluguClaimWinner: the last Telugu claim in the first list with two; none when never listed together', () => {
    const { teluguClaimWinner, masterKey } = require('../providers/multimovies');
    const src = (n, language) => ({ url: id(n), language });
    const A = '5820588283537016992_0_0_1080_h265_795'; const B = '5355663801620775816_0_0_1080_h265_623';
    assert.equal(teluguClaimWinner([[src(A, 'Telugu'), src(B, 'Telugu')]]), masterKey(id(B)));
    assert.equal(teluguClaimWinner([[src(B, 'Telugu'), src(A, 'tel')]]), masterKey(id(A)));
    assert.equal(teluguClaimWinner([[src(A, 'Telugu'), src(B, 'Hindi')]]), null, 'one claim: nothing to drop');
    assert.equal(teluguClaimWinner([[src(A, 'Telugu'), src(B, 'Telugu Sub')]]), null, 'a sub source is no claim');
    assert.equal(teluguClaimWinner([[src(A, 'Telugu'), src(B, 'Original')]]), null, 'Original is no claim');
    assert.equal(teluguClaimWinner([[src(A, 'Telugu')], [src(B, 'Telugu')]]), '', 'never listed together: none kept');
    // The same master twice (another signature) is one claim.
    assert.equal(teluguClaimWinner([[src(A, 'Telugu'), { url: id(A) + '%26Signature%3Dx', language: 'Telugu' }]]), null);
});

test('getMultimoviesStreams: "Original" stays unlabelled beside the callisto Telugu pair; one Telugu row', async (t) => {
    const mm = freshMM(t);
    const routes = rrrVidbolt();
    const inner = routes[0][1];
    // The plain resolve (luna) now lists an "Original" bridge master; callisto lists two Telugu.
    const ORIG = RRR_URL.replace('5820588283537016992_0_0_1080_h265_795', '604320274028317248_0_0_1080_h265_174');
    routes[0][1] = (u) => (serverOf(u) === null
        ? new Response(resolveBody('luna', [{ url: ORIG, kind: 'hls', quality: '1080p', language: 'Original' }]), { status: 200 })
        : inner(u));
    stubVidbolt(t, routes);
    const rows = await mm.getMultimoviesStreams('1261763', 'movie');
    const orig = rows.find((r) => r.url === ORIG);
    assert.ok(orig, 'Original row kept');
    assert.ok(!normaliseStream(orig).languages.includes('Telugu'), JSON.stringify(orig.languages));
    assert.equal(rows.map(normaliseStream).filter((r) => r.languages.includes('Telugu')).length, 1);
});

test('getMultimoviesStreams: "Original" is not Telugu even when no source lists Telugu', async (t) => {
    const mm = freshMM(t);
    const ORIG = RRR_URL.replace('5820588283537016992_0_0_1080_h265_795', '604320274028317248_0_0_1080_h265_174');
    stubVidbolt(t, [
        [/\/api\/resolve/, (u) => new Response(resolveBody('luna', serverOf(u) === null
            ? [{ url: ORIG, kind: 'hls', quality: '1080p', language: 'Original' }]
            : null), { status: 200 })],
        [/vidbolt\.xyz\/movie\//, ''],
        [/dash-hls-bridge/, () => new Response(RRR_BRIDGE, { status: 200 })],
    ]);
    const rows = await mm.getMultimoviesStreams('1261763', 'movie');
    const row = rows.find((r) => r.url === ORIG);
    assert.ok(!normaliseStream(row).languages.includes('Telugu'), JSON.stringify(row.languages));
    assert.match(row.title, /Original/);
});

// Soak 1: VidBolt answered 2xx with no source for the title while a server
// went unheard. Partial (not cached), but marked titleEmpty so the registry
// never counts it toward a host move.
test('soak 1: no source from VidBolt (2xx) with a server unheard: [] partial and titleEmpty', async (t) => {
    const mm = freshMM(t, { settleMs: 100, resolveStepMs: 2000 });
    stubVidbolt(t, [[/\/api\/resolve/, (u) => (serverOf(u) === 'vega' ? 'hang' : new Response(resolveBody(serverOf(u), null), { status: 200 }))],
        [/vidbolt\.xyz\/movie\//, '']]);
    const rows = await mm.getMultimoviesStreams('1496785', 'movie');
    assert.equal(rows.length, 0);
    assert.match(rows.upstreamError || '', /not heard: vega/);
    assert.equal(rows.titleEmpty, true);
});

test('soak 1: VidBolt 5xx on every ask: thrown, not titleEmpty', async (t) => {
    const mm = freshMM(t, { settleMs: 50, resolveStepMs: 500 });
    stubVidbolt(t, [[/\/api\/resolve/, () => new Response('bad', { status: 502 })], [/vidbolt\.xyz\/movie\//, '']]);
    await assert.rejects(mm.getMultimoviesStreams('1496785', 'movie'), (e) => !e.titleEmpty);
});

// Live 2026-11-22 (telugu-label.md): VidBolt /api/resolve for RRR (579974),
// default and only=callisto, both list two sources with language "Telugu".
// Speech ID on 40 s of each: 5820588283537016992 reads ta 0.60 / 0.37 / 0.52
// (Tamil), 5355663801620775816 reads te 1.00 at the same point of the film.
// The owner hears the same: first "Telugu" plays Tamil, the second is Telugu.
// Two Telugu claims from one provider cannot both stand: only the last listed
// keeps Telugu, the other keeps its listed label in the title, unlabelled.
const id = (n) => RRR_URL.replace('5820588283537016992_0_0_1080_h265_795', n);
const RRR_LIVE_DEFAULT = [
    ['7067694354684856232_0_0_1080_h265_745', 'Bengali'], ['5820588283537016992_0_0_1080_h265_795', 'Telugu'],
    ['2848239607093808728_0_0_1080_h265_905', 'English'], ['7499853135079687472_0_0_1080_h265_956', 'Hindi'],
    ['3648827707632354536_0_0_1080_h265_341', 'Arabic sub'], ['5355663801620775816_0_0_1080_h265_623', 'Telugu'],
];
const RRR_LIVE_CALLISTO = [1, 2, 4, 0, 3, 5].map((i) => RRR_LIVE_DEFAULT[i]);
const liveBody = (list) => resolveBody('callisto', list.map(([n, language]) => ({ url: id(n), kind: 'hls', quality: '1080p', language })));

test('live 11-22 RRR: two sources say Telugu; only the last listed keeps Telugu', async (t) => {
    const mm = freshMM(t);
    stubVidbolt(t, [
        [/\/api\/resolve/, (u) => {
            const s = serverOf(u);
            if (s === null) return new Response(liveBody(RRR_LIVE_DEFAULT), { status: 200 });
            if (s === 'callisto') return new Response(liveBody(RRR_LIVE_CALLISTO), { status: 200 });
            return new Response(resolveBody(s, null), { status: 200 });
        }],
        [/vidbolt\.xyz\/movie\//, ''],
        [/dash-hls-bridge/, () => new Response(RRR_BRIDGE, { status: 200 })],
    ]);
    const rows = await mm.getMultimoviesStreams('579974', 'movie');
    const te = rows.map(normaliseStream).filter((r) => r.languages.includes('Telugu'));
    assert.equal(te.length, 1, JSON.stringify(rows.map((r) => r.languages)));
    assert.match(te[0].url, /5355663801620775816/);
    const first = rows.find((r) => r.url.includes('5820588283537016992'));
    assert.ok(first, 'the demoted row is kept');
    assert.ok(!normaliseStream(first).languages.includes('Telugu'));
    assert.ok(!normaliseStream(first).audio.some((a) => a.language === 'Telugu'));
    assert.match(first.title, /duplicate listing/);
    assert.doesNotMatch(`${first.name} ${first.title}`, /telugu/i);
    // The other explicit languages stay as listed.
    const langs = rows.map(normaliseStream).flatMap((r) => r.languages);
    for (const l of ['Bengali', 'English', 'Hindi']) assert.ok(langs.includes(l), l);
});

test('dropLabel: a Telugu claim that lost to a later one is not stamped on the lone rendition', () => {
    const row = normaliseStream(streamFromMaster({ language: 'Telugu' }, RRR_BRIDGE, RRR_URL, null, { dropLabel: true }));
    assert.ok(!row.languages.includes('Telugu'));
    assert.match(row.title, /duplicate listing/);
    // A master LANGUAGE tag is its own evidence and still wins.
    const tagged = RRR_BRIDGE.replace('NAME="Audio"', 'NAME="Audio",LANGUAGE="tel"');
    assert.deepEqual(normaliseStream(streamFromMaster({ language: 'Telugu' }, tagged, RRR_URL, null, { dropLabel: true })).languages, ['Telugu']);
});

test('live 11-22: "Original" never takes the TMDB language (te or ta)', () => {
    for (const lang of ['te', 'ta']) {
        const row = streamFromMaster({ language: 'Original' }, RRR_BRIDGE, RRR_URL, null, lang);
        const n = normaliseStream(row);
        assert.ok(!n.languages.includes('Telugu') && !n.languages.includes('Tamil'), JSON.stringify(n.languages));
        assert.ok(!n.audio.some((a) => a.language === 'Telugu' || a.language === 'Tamil'));
        assert.match(row.title, /Original/);
    }
});

// Live 2026-11-22: Jailer (937020) orion master, every rendition LANGUAGE-tagged
// (speech ID on each: hi 0.98, kn 0.97, ml 1.00, ta 1.00, te 0.99).
test('live 11-22 Jailer multi-audio master: every tagged language kept, Telugu first, nothing invented', () => {
    const JAILER = [
        '#EXTM3U', '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en-us",URI="subtitles_english.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="hin",NAME="[1] Hindi",DEFAULT=NO,URI="track_hindi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="kan",NAME="[2] Kannada",DEFAULT=NO,URI="track_kannada.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="mal",NAME="[3] Malayalam",DEFAULT=NO,URI="track_malayalam.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tam",NAME="[4] Tamil",DEFAULT=NO,URI="track_tamil.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="tel",NAME="[5] Telugu",DEFAULT=NO,URI="track_telugu.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="aac",RESOLUTION=1920x1040,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'tiles.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="aac",DEFAULT=YES,RESOLUTION=1280x688,SUBTITLES="subs",CLOSED-CAPTIONS=NONE', 'video_720p.m3u8', '',
    ].join('\n');
    const n = normaliseStream(streamFromMaster({ quality: '1080p' }, JAILER, 'https://img.rousav.tech/media/fce9ee51fc8ce1cc4e1b/index.m3u8'));
    assert.deepEqual(n.languages, ['Telugu', 'Hindi', 'Kannada', 'Malayalam', 'Tamil']);
    assert.deepEqual(n.audio.map((a) => a.language), ['Hindi', 'Kannada', 'Malayalam', 'Tamil', 'Telugu']);
});

// ---- MPD audio lang rule (2026-11-22). Real resolve answers for 6 titles,
// signatures redacted (fixtures/multimovies/mpd-lang-titles.json), and the
// real Salaar index.mpd shape with each source's measured `lang` put in.
// Speech ID (telugu-rule-check.md): tel 6 of 6, tam/kan/hin 4 of 4.
const MPD_FIX = require('./fixtures/multimovies/mpd-lang-titles.json');
const MPD_TEMPLATE = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'multimovies', 'salaar-7844085959171131184-index.mpd'), 'utf8');
const mpdWith = (lang) => MPD_TEMPLATE.replace(' lang="tel"', lang ? ` lang="${lang}"` : '');
// Bridge rows name the sacdn folder; dash-direct rows (/mm/hls/<id>/) its id.
const sacdnId = (u) => (/\/dash\/(\d+)_/.exec(decodeURIComponent(String(u))) || /\/mm\/hls\/(\d+)\//.exec(String(u)) || [])[1];

// VidBolt answers as captured; every bridge master is the RRR single "Audio"
// master; orion masters are Krack's tagged multi master. `mpd`: 'fixture'
// serves the measured lang, or a function (url) -> Response|'hang'.
function capturedVidbolt(id, { mpd = 'fixture' } = {}) {
    const answers = MPD_FIX.titles[id].answers;
    return [
        [/\/api\/resolve/, (u) => {
            const label = serverOf(u) || 'default';
            const a = answers.find((x) => x.ask === label) || (label === 'default' ? answers[0] : null);
            return new Response(resolveBody(a ? a.server : label, a && a.sources.length ? a.sources : null), { status: 200 });
        }],
        [/vidbolt\.xyz\/movie\//, ''],
        [/sacdn\.hakunaymatata\.com\/.*index\.mpd/, (u) => (mpd === 'fixture'
            ? new Response(mpdWith(MPD_FIX.mpdAudioLang[sacdnId(u)]), { status: 200 })
            : mpd(u))],
        // Bridge hosts vary (dash-hls-bridge, hakunamatata.rousav.tech, *.workers.dev).
        [/\/\?url=https%3A%2F%2Fsacdn/, () => new Response(RRR_BRIDGE, { status: 200 })],
        [/img\.rousav\.tech/, () => new Response(KRACK, { status: 200 })],
    ];
}

function logLines(t) {
    const lines = [];
    t.mock.method(console, 'log', (...a) => { lines.push(a.join(' ')); });
    return lines;
}

async function mpdResolve(t, id, opts) {
    const mm = freshMM(t, { mpdTimeoutMs: 300 });
    const lines = logLines(t);
    const calls = stubVidbolt(t, capturedVidbolt(id, opts));
    const rows = await mm.getMultimoviesStreams(id, 'movie');
    const by = new Map(rows.map((r) => [sacdnId(r.url) || r.url, r]));
    const langs = (key) => normaliseStream(by.get(key)).languages;
    return { rows, by, langs, lines, calls, summary: lines.find((l) => l.startsWith(`[multimovies] mpd-lang ${id} `)) };
}

test('mpd-lang RRR: the first "Telugu" (MPD und, Tamil speech) is not Telugu; the second (tel) is', async (t) => {
    const r = await mpdResolve(t, '579974');
    assert.ok(!r.langs('5820588283537016992').includes('Telugu'), JSON.stringify(r.langs('5820588283537016992')));
    assert.deepEqual(r.langs('5355663801620775816'), ['Telugu']);
    assert.equal(r.rows.map(normaliseStream).filter((x) => x.languages.includes('Telugu')).length, 1);
    assert.equal(r.summary, '[multimovies] mpd-lang 579974 claims=2 tel=1 fixed=1 fallback=0');
});

test('mpd-lang Pushpa: the single "Telugu" source tagged tam is not Telugu, and no language word is added', async (t) => {
    const r = await mpdResolve(t, '690957');
    const row = r.by.get('1120489025439157848');
    assert.ok(!r.langs('1120489025439157848').includes('Telugu'));
    assert.ok(!/Telugu|Tamil/.test(row.title + row.name), row.title);
    assert.ok(!normaliseStream(row).languages.includes('Tamil'));
    assert.match(row.title, /unverified/);
    assert.equal(r.summary, '[multimovies] mpd-lang 690957 claims=1 tel=0 fixed=1 fallback=0');
});

test('mpd-lang Hanu-Man: the "Telugu" source (MPD und, Hindi speech) is not Telugu; Hindi stays Hindi', async (t) => {
    const r = await mpdResolve(t, '869760');
    assert.ok(!r.langs('5646656895621416016').includes('Telugu'));
    assert.deepEqual(r.langs('5669817185716291008'), ['Hindi']);
    assert.equal(r.summary, '[multimovies] mpd-lang 869760 claims=1 tel=0 fixed=1 fallback=0');
});

test('mpd-lang Devara: "Kurdish sub" tagged tel becomes Telugu; the listed Telugu stays', async (t) => {
    const r = await mpdResolve(t, '811941');
    assert.deepEqual(r.langs('6176354059575264600'), ['Telugu']);
    assert.deepEqual(r.langs('5096152864070746064'), ['Telugu']);
    assert.equal(r.summary, '[multimovies] mpd-lang 811941 claims=1 tel=2 fixed=1 fallback=0');
});

test('mpd-lang Salaar: the tel source keeps Telugu; the und claim loses it; one MPD GET per sacdn source, signed', async (t) => {
    const r = await mpdResolve(t, '770906');
    assert.deepEqual(r.langs('7844085959171131184'), ['Telugu']);
    assert.ok(!r.langs('891921665641332688').includes('Telugu'));
    assert.equal(r.summary, '[multimovies] mpd-lang 770906 claims=2 tel=1 fixed=1 fallback=0');
    const mpds = r.calls.filter((u) => /index\.mpd/.test(u));
    assert.equal(mpds.length, 8, 'the 8 callisto sources, once each; orion has no MPD');
    assert.ok(mpds.every((u) => /^https:\/\/sacdn\.hakunaymatata\.com\/dash\/\d+_[^/]+\/index\.mpd\?Policy=REDACTED&Signature=REDACTED&Key-Pair-Id=REDACTED$/.test(u)), mpds[0]);
});

test('mpd-lang KGF2: the Kannada claims follow the tag (kan stays Kannada, und is no evidence); Telugu tel stays', async (t) => {
    const r = await mpdResolve(t, '587412');
    assert.deepEqual(r.langs('940721918355932584'), ['Kannada']);
    assert.deepEqual(r.langs('2871208402850570248'), ['Kannada'], 'und carries no information');
    assert.deepEqual(r.langs('68264836194533344'), ['Telugu']);
    assert.equal(r.summary, '[multimovies] mpd-lang 587412 claims=1 tel=1 fixed=0 fallback=0');
});

test('mpd-lang rule: tam/kan/hin/mal that contradicts a listed language wins; eng and und never do', () => {
    const { mpdLanguagePlan, masterKey } = require('../providers/multimovies');
    const kgf = MPD_FIX.titles['587412'].answers.map((a) => a.sources);
    // Synthetic: KGF2's measured tags, except position 0 ("Kannada", Hindi
    // speech, measured und) is given `hin` to exercise the override.
    const tags = { '2871208402850570248': 'hin', '940721918355932584': 'kan', '3461436953068011736': 'eng', '1207594074979664368': 'und', '68264836194533344': 'tel' };
    const mpd = new Map(kgf.flat().map((s) => [masterKey(s.url), { ok: true, lang: tags[masterKey(s.url)] || null }]));
    const plan = mpdLanguagePlan(kgf, mpd);
    assert.equal(plan.fallback, false);
    assert.equal(plan.sources.get('2871208402850570248').language, 'Hindi', 'Kannada label, hin tag');
    assert.equal(plan.sources.get('940721918355932584').language, 'Kannada');
    assert.equal(plan.sources.get('3461436953068011736').language, 'Bengali', 'eng is ignored');
    assert.equal(plan.sources.get('1207594074979664368').language, 'Hindi', 'und is ignored');
    assert.equal(plan.fixed, 1);
});

test('mpd-lang: an MPD failure falls back to last-listed-wins for the title, and says so', async (t) => {
    let n = 0;
    const r = await mpdResolve(t, '579974', { mpd: () => (++n === 1 ? 'hang' : new Response('no', { status: 503 })) });
    assert.ok(!r.langs('5820588283537016992').includes('Telugu'));
    assert.match(r.by.get('5820588283537016992').title, /duplicate listing, unverified/);
    assert.deepEqual(r.langs('5355663801620775816'), ['Telugu']);
    assert.equal(r.summary, '[multimovies] mpd-lang 579974 claims=2 tel=0 fixed=0 fallback=1');
    assert.ok(r.lines.some((l) => /^\[multimovies\] mpd-lang fallback for 579974: /.test(l)), r.lines.join('\n'));
});

test('mpd-lang: index.mpd URL from any wrapper keeps the signed query; unsigned or non-sacdn has none; tag parse', () => {
    const { mpdUrlOf, mpdAudioLang } = require('../providers/multimovies');
    const inner = 'https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5355663801620775816_0_0_1080_h265_623%2Fmaster.m3u8';
    assert.equal(mpdUrlOf(`https://old-mode-b611.fykko14.workers.dev/?url=${inner}&Policy=P_&Signature=S~x&Key-Pair-Id=K`),
        'https://sacdn.hakunaymatata.com/dash/5355663801620775816_0_0_1080_h265_623/index.mpd?Policy=P_&Signature=S~x&Key-Pair-Id=K');
    assert.equal(mpdUrlOf(`https://h/?url=${inner}`), null, 'unsigned');
    assert.equal(mpdUrlOf('https://img.rousav.tech/media/031fe7b1d27fd6aa800d/index.m3u8?Policy=a&Signature=b&Key-Pair-Id=c'), null);
    assert.equal(mpdAudioLang(mpdWith('tel')), 'tel');
    assert.equal(mpdAudioLang(mpdWith(null)), null);
    assert.equal(mpdAudioLang(mpdWith('TAM')), 'tam');
});

// ---- dash-direct (P21, 2026-11-22): the dash-hls-bridge answers 429 (Cloudflare
// 1027, out of quota). /dash/ sources play from VM playlists built from their
// index.mpd; /hls/ sources (no MPD) keep the bridge. Real KGF 2 MPD (tel).
const NATIVE_FETCH = global.fetch;
const KGF2_MPD = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'multimovies', 'kgf2-68264836194533344-index.mpd'), 'utf8');
const DASH_SRC = {
    language: 'Telugu', kind: 'hls', quality: '1080p',
    url: 'https://dash-hls-bridge.johndoesemc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F68264836194533344_0_0_1080_h265_168%2Fmaster.m3u8&Policy=eyJTdGF0ZW1lbnQiOlt7IkNvbmRpdGlvbiI6eyJEYXRlTGVzc1RoYW4iOnsiQVdTOkVwb2NoVGltZSI6NDEwMjQ0NDgwMH19fV19&Signature=SIGd&Key-Pair-Id=KP',
};
const HLS_SRC = {
    language: 'English', kind: 'hls', quality: '720p',
    url: 'https://dash-hls-bridge.john1mc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fhls%2F330483265830305744-0-0-720-982%2Fmaster.m3u8&Policy=P&Signature=SIGh&Key-Pair-Id=KP',
};
function dashVidbolt({ mpd = () => new Response(KGF2_MPD, { status: 200 }), dashBridge = () => new Response('error code: 1027', { status: 429 }) } = {}) {
    return [
        [/\/api\/resolve/, (u) => new Response(resolveBody(serverOf(u) || 'callisto', serverOf(u) ? null : [DASH_SRC, HLS_SRC]), { status: 200 })],
        [/vidbolt\.xyz\/movie\//, ''],
        [/sacdn\.hakunaymatata\.com\/.*index\.mpd/, mpd],
        [/\?url=https%3A%2F%2Fsacdn\.hakunaymatata\.com%2Fdash%2F/, dashBridge],
        [/\?url=https%3A%2F%2Fsacdn\.hakunaymatata\.com%2Fhls%2F/, () => new Response(RRR_BRIDGE, { status: 200 })],
    ];
}
function withBase(t, base) {
    const saved = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = base;
    t.after(() => { if (saved === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved; });
}

test('dash-direct: a /dash/ source becomes a VM /mm/hls/ row (no bridge GET, bridge 429 irrelevant); /hls/ keeps the bridge', async (t) => {
    withBase(t, 'https://vm.test');
    const mm = freshMM(t, { mpdTimeoutMs: 300 });
    const lines = logLines(t);
    const calls = stubVidbolt(t, dashVidbolt());
    const rows = await mm.getMultimoviesStreams('587412', 'movie');
    assert.equal(rows.length, 2, lines.join('\n'));
    const dash = rows.find((r) => r.url.includes('/mm/hls/'));
    const hls = rows.find((r) => r !== dash);
    assert.match(dash.url, /^https:\/\/vm\.test\/mm\/hls\/68264836194533344\/master\.m3u8\?s=[\w-]+&e=4102444800&l=Telugu$/);
    assert.deepEqual(dash.headers, {}, 'VM route and sacdn need no request headers');
    assert.equal(dash.__noProxy, true, 'never wrapped in /m3u8-proxy');
    assert.equal(dash.videoCodec, 'hevc');
    assert.equal(dash.codecs, null, 'no bare hev1 CODECS on the row (web codecSupport probes the family)');
    assert.deepEqual(dash.levels.map((l) => l.height), [1080, 720, 480]);
    const n = normaliseStream(dash);
    assert.deepEqual(n.languages, ['Telugu']);
    assert.equal(n.selectableAudio, true);
    assert.equal(hls.url, HLS_SRC.url, '/hls/ source: the bridge master, as before');
    assert.equal(calls.filter((u) => /%2Fdash%2F68264836194533344/.test(u) && /workers\.dev/.test(u)).length, 0, 'the dash bridge is never asked');
    assert.equal(calls.filter((u) => /index\.mpd/.test(u)).length, 1, 'one MPD GET, for the /dash/ source only');
    assert.ok(lines.includes('[multimovies] dash-direct 587412 sources=1 bridge=1'), lines.join('\n'));
    assert.ok(lines.includes('[multimovies] mpd-lang 587412 claims=1 tel=1 fixed=0 fallback=0'), lines.join('\n'));
    assert.ok(!lines.join('\n').includes('SIGd'), 'no signature in logs');
});

test('dash-direct liveness is the MPD GET: 403 or no video Representation -> bridge path (here 429 -> dropped)', async (t) => {
    withBase(t, 'https://vm.test');
    for (const [label, mpd] of [
        ['403', () => new Response('denied', { status: 403 })],
        ['audio only', () => new Response(KGF2_MPD.replace(/<AdaptationSet[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/, ''), { status: 200 })],
    ]) {
        await t.test(label, async (st) => {
            const mm = freshMM(st, { mpdTimeoutMs: 300 });
            const lines = logLines(st);
            const calls = stubVidbolt(st, dashVidbolt({ mpd }));
            const rows = await mm.getMultimoviesStreams('587412', 'movie');
            assert.deepEqual(rows.map((r) => r.url), [HLS_SRC.url], lines.join('\n'));
            assert.equal(calls.filter((u) => /%2Fdash%2F68264836194533344/.test(u) && /workers\.dev/.test(u)).length, 1, 'bridge tried once');
            assert.ok(lines.some((l) => /^\[multimovies\] mpd unreadable for 587412 68264836194533344: .* - bridge path$/.test(l)), lines.join('\n'));
            assert.ok(lines.some((l) => /master unreadable for 587412, dropped: HTTP 429/.test(l)));
            assert.ok(lines.includes('[multimovies] dash-direct 587412 sources=0 bridge=1'));
        });
    }
});

test('dash-direct row passes segment verify: master -> lowest variant -> sacdn init, through the VM route', async (t) => {
    const express = require('express');
    const mmDash = require('../lib/media/mmDash');
    const { verifyOne, verifiable } = require('../lib/media/segmentVerify');
    const app = express();
    mmDash.registerMmDashRoutes(app);
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    withBase(t, base);
    const savedDeps = mmDash._deps.fetch;
    const init = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'multimovies', 'kgf2-init-stream0.m4s'));
    mmDash._deps.fetch = async (u) => (/init-stream/.test(u) ? new Response(init, { status: 200 }) : new Response(KGF2_MPD, { status: 200 }));
    t.after(() => { mmDash._deps.fetch = savedDeps; mmDash._clear(); server.close(); });
    const mm = freshMM(t, { mpdTimeoutMs: 300 });
    logLines(t);
    stubVidbolt(t, dashVidbolt());
    const dash = (await mm.getMultimoviesStreams('587412', 'movie')).find((r) => r.url.includes('/mm/hls/'));
    assert.ok(verifiable(dash, base), 'own /mm/hls/ rows are verified, other own routes are skipped');
    assert.ok(!verifiable({ url: `${base}/castle-demux/x/master.m3u8` }, base));
    // The VM route is real; sacdn is stubbed (init segment bytes).
    global.fetch = async (u, o) => (String(u).startsWith(base) ? NATIVE_FETCH(u, o)
        : new Response(init, { status: 206 }));
    const v = await verifyOne(dash);
    assert.equal(v.ok, true, JSON.stringify(v));
});
