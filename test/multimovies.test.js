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

test('RRR bridge: source "Original" takes TMDB original_language, else stays unlabelled', () => {
    const withTmdb = normaliseStream(streamFromMaster({ language: 'Original' }, RRR_BRIDGE, RRR_URL, null, 'te'));
    assert.deepEqual(withTmdb.languages, ['Telugu']);
    const without = normaliseStream(streamFromMaster({ language: 'Original' }, RRR_BRIDGE, RRR_URL, null, null));
    assert.ok(!without.languages.includes('Telugu'));
});

// Round 2 N2: a hung TMDB call is capped (default 2 s) and never drops the row.
test('getMultimoviesStreams: TMDB hangs on an "Original" source, row survives unlabelled', async () => {
    const mm = require('../providers/multimovies');
    const realFetch = global.fetch;
    const realDeps = { ...mm._deps };
    const realCfg = { ...mm._config };
    assert.equal(mm._config.tmdbWaitMs, 2000);
    mm._config.tmdbWaitMs = 100;
    mm._deps.originalLanguage = () => new Promise(() => {});
    global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/resolve')) {
            return { ok: true, status: 200, json: async () => ({ stream: { server: 'x', sources: [{ url: RRR_URL, kind: 'hls', quality: '1080p', language: 'Original' }] } }) };
        }
        if (u === RRR_URL) return { ok: true, status: 200, text: async () => RRR_BRIDGE };
        return { ok: true, status: 200, text: async () => '#EXTM3U\n', body: null, arrayBuffer: async () => new ArrayBuffer(16) };
    };
    try {
        const t0 = Date.now();
        const rows = await mm.getMultimoviesStreams('579974', 'movie');
        assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
        assert.equal(rows.length, 1);
        assert.ok(!normaliseStream(rows[0]).languages.includes('Telugu'));
        mm._deps.originalLanguage = async () => 'te';
        const again = await mm.getMultimoviesStreams('579974', 'movie');
        assert.deepEqual(normaliseStream(again[0]).languages, ['Telugu']);
    } finally {
        global.fetch = realFetch;
        Object.assign(mm._deps, realDeps);
        Object.assign(mm._config, realCfg);
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

test('all servers: plain resolve gives luna, callisto still adds both Telugu rows', async (t) => {
    const mm = freshMM(t);
    const calls = stubVidbolt(t, rrrVidbolt());
    const rows = (await mm.getMultimoviesStreams('579974', 'movie')).map(normaliseStream);
    assert.deepEqual(rows.map((r) => r.languages.join('/')), ['', 'Telugu', 'Telugu']);
    assert.equal(rows.filter((r) => r.languages.includes('Telugu')).length, 2);
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
