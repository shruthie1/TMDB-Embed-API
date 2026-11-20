'use strict';
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// FFPROBE_PATH and the TTL are read at module load, so they must be set before
// the require. The fake binary stands in for ffprobe: no network, no real mp4,
// but the real execFile/JSON/cache path still runs.
const FAKE = path.join(__dirname, 'fixtures', 'fake-ffprobe.js');
process.env.FFPROBE_PATH = FAKE;
const LOG = path.join(os.tmpdir(), `fake-ffprobe-${process.pid}.log`);
process.env.FAKE_FFPROBE_LOG = LOG;

const { probeAudioTracks, cachedAudioTracks, _cache } = require('../lib/media/mp4AudioProbe');

const probeCount = () => {
    try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).length; }
    catch { return 0; }
};
const lastArgs = () => {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
};

beforeEach(() => { _cache.clear(); try { fs.unlinkSync(LOG); } catch { /* first run */ } });

test('reads language, codec and channels off the audio streams only', async () => {
    const tracks = await probeAudioTracks('https://cdn.test/a.mp4#multi');
    // The video stream is tagged eng too; it must not appear as an audio track.
    assert.deepStrictEqual(tracks, [
        { language: 'tel', codec: 'aac', channels: 6 },
        { language: 'hin', codec: 'aac', channels: 2 },
        { language: null, codec: 'ac3', channels: 2 },
    ]);
});

// `und` is the muxer default, not a language. Passed through, it became
// languages:["und"] in NetMirror, which looked labelled and skipped the
// platform path that carries the real language list.
test('a track tagged und is reported as untagged', async () => {
    const tracks = await probeAudioTracks('https://cdn.test/a.mp4#und');
    assert.deepStrictEqual(tracks, [{ language: null, codec: 'aac', channels: 2 }]);
});

test('an untagged track stays null rather than being invented into a language', async () => {
    const tracks = await probeAudioTracks('https://cdn.test/a.mp4#multi');
    const untagged = tracks.filter((t) => t.language === null);
    assert.strictEqual(untagged.length, 1);
    // Raw ISO codes are passed through; normaliseStream owns display names.
    assert.deepStrictEqual(tracks.map((t) => t.language), ['tel', 'hin', null]);
});

test('a video-only file yields no audio tracks', async () => {
    assert.deepStrictEqual(await probeAudioTracks('https://cdn.test/a.mp4#noaudio'), []);
});

test('a probe failure returns [] rather than throwing or returning null', async () => {
    // [] means "nothing known" - the caller carries on with what the provider
    // said. Null would force every call site to branch.
    assert.deepStrictEqual(await probeAudioTracks('https://cdn.test/a.mp4#fail'), []);
});

test('no url short-circuits without spawning a probe', async () => {
    assert.deepStrictEqual(await probeAudioTracks(''), []);
    assert.deepStrictEqual(await probeAudioTracks(null), []);
    assert.strictEqual(probeCount(), 0);
});

test('a repeat call is served from cache instead of re-probing', async () => {
    await probeAudioTracks('https://cdn.test/a.mp4#multi');
    await probeAudioTracks('https://cdn.test/a.mp4#multi');
    assert.strictEqual(probeCount(), 1);
});

test('a differently-signed url for the same file hits the same cache entry', async () => {
    // The whole point of keying on hostname+path: re-resolving a title issues a
    // fresh signature, and that must not cost another probe.
    await probeAudioTracks('https://cdn.test/f/a.mp4#multi?sign=AAA');
    await probeAudioTracks('https://cdn.test/f/a.mp4#multi?sign=BBB');
    assert.strictEqual(probeCount(), 1);
});

test('a different path is a different entry', async () => {
    await probeAudioTracks('https://cdn.test/one.mp4');
    await probeAudioTracks('https://cdn.test/two.mp4');
    assert.strictEqual(probeCount(), 2);
});

test('a failed probe is cached too, so one dead url cannot re-probe every resolve', async () => {
    await probeAudioTracks('https://cdn.test/a.mp4#fail');
    await probeAudioTracks('https://cdn.test/a.mp4#fail');
    assert.strictEqual(probeCount(), 1);
});

test('cachedAudioTracks distinguishes never-probed from probed-and-empty', async () => {
    assert.strictEqual(cachedAudioTracks('https://cdn.test/a.mp4#noaudio'), undefined);
    await probeAudioTracks('https://cdn.test/a.mp4#noaudio');
    assert.deepStrictEqual(cachedAudioTracks('https://cdn.test/a.mp4#noaudio'), []);
});

test('cachedAudioTracks never starts a probe', async () => {
    assert.strictEqual(cachedAudioTracks('https://cdn.test/cold.mp4'), undefined);
    assert.strictEqual(probeCount(), 0);
});

test('cachedAudioTracks with no url is undefined', () => {
    assert.strictEqual(cachedAudioTracks(''), undefined);
});

test('request headers are passed to ffprobe as one CRLF-joined blob', async () => {
    // These origins answer 429 to a bare request, so losing the headers here
    // silently costs the language tags.
    await probeAudioTracks('https://cdn.test/a.mp4', {
        Referer: 'https://ref.test/', 'User-Agent': 'UA/1',
    });
    const args = lastArgs();
    const blob = args[args.indexOf('-headers') + 1];
    assert.strictEqual(blob, 'Referer: https://ref.test/\r\nUser-Agent: UA/1\r\n');
});

test('no headers means no -headers flag at all', async () => {
    await probeAudioTracks('https://cdn.test/a.mp4');
    assert.ok(!lastArgs().includes('-headers'));
});

test('an unparseable url still caches under its raw string', async () => {
    await probeAudioTracks('not a url#multi');
    await probeAudioTracks('not a url#multi');
    assert.strictEqual(probeCount(), 1);
});
