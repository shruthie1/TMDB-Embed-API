'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

// The castle-demux master listed its variant as CODECS="avc1.640032", video
// only. ExoPlayer then could not prepare the audio renditions from the master
// and loaded all 5 audio playlists plus the first segment of all 5 languages
// before the first frame (apk-playback.md, 2026-11-22). The audio codec is now
// added from the probe: ffprobe codec_name + profile of the Castle track, and
// the demux is `-c copy`, so the served segment carries that same codec.
// Unknown profile (a probe stored before this change) keeps today's
// video-only CODECS: filled from facts, never guessed. EXT-X-MEDIA unchanged.
const castleDemux = require('../utils/castleDemux');
const republish = require('../lib/media/republish');
const runtime = require('../lib/runtime/environment');

let dir;
let muxedTs;
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'castle-codecs-'));
    execFileSync(castleDemux.FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
        '-c:a', 'aac', '-f', 'mpegts', 'muxed.ts', '-y'], { cwd: dir });
    muxedTs = fs.readFileSync(path.join(dir, 'muxed.ts'));
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
    });
}

test('probeTracks reads the AAC profile of each audio track (real ffprobe)', async () => {
    const p = await castleDemux.probeTracks(muxedTs);
    assert.equal(p.audio.length, 1);
    assert.equal(p.audio[0].codec, 'aac');
    assert.equal(p.audio[0].profile, 'LC');
});

test('the demuxed audio segment (-c copy) keeps the probed codec and profile', async () => {
    const p = await castleDemux.probeTracks(muxedTs);
    const out = await castleDemux.extractTrack(muxedTs, p.audio[0].index);
    const again = await castleDemux.probeTracks(out);
    assert.equal(again.audio.length, 1);
    assert.equal(again.audio[0].codec, 'aac');
    assert.equal(again.audio[0].profile, 'LC');
    assert.equal(castleDemux.audioCodecString(again.audio[0]), 'mp4a.40.2');
});

test('audioCodecString maps only known codec + profile pairs; anything unknown is null', () => {
    const f = castleDemux.audioCodecString;
    assert.equal(f({ codec: 'aac', profile: 'LC' }), 'mp4a.40.2');
    assert.equal(f({ codec: 'aac', profile: 'HE-AAC' }), 'mp4a.40.5');
    assert.equal(f({ codec: 'aac', profile: 'HE-AACv2' }), 'mp4a.40.29');
    assert.equal(f({ codec: 'aac' }), null, 'a probe from before this change has no profile');
    assert.equal(f({ codec: 'aac', profile: null }), null);
    assert.equal(f({ codec: 'aac', profile: 'Main' }), null);
    assert.equal(f({ codec: 'ac3', profile: null }), null);
    assert.equal(f(null), null);
});

async function masterFor(audio, t) {
    const feat = runtime.features.castleDemux;
    Object.defineProperty(runtime.features, 'castleDemux', { value: true, configurable: true, writable: true });
    t.after(() => { runtime.features.castleDemux = feat; });
    const segs = ['https://cdn.example/c0.ts'];
    const id = republish.storeCastleDemux({
        segments: segs, playlistLines: ['#EXTM3U', '#EXTINF:2.0,', ...segs, '#EXT-X-ENDLIST'],
        headers: {}, videoIndex: 0, videoWidth: 1920, videoHeight: 1080,
        audio, videoCodec: 'avc1.640032',
    });
    const app = express();
    republish.registerCastleDemuxRoutes(app);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(() => srv.close());
    const r = await get(`http://127.0.0.1:${srv.address().port}/castle-demux/${id}/master.m3u8`);
    assert.equal(r.status, 200);
    return r.body.replace(/127\.0\.0\.1:\d+/g, 'HOST');
}
const FIVE = ['kan', 'hin', 'tam', 'mal', 'tel'];
const tracks = (profile) => FIVE.map((language, i) => ({ index: i + 1, language, codec: 'aac', channels: 2,
    sampleRate: 48000, ...(profile === undefined ? {} : { profile }) }));
const mediaLines = (m) => m.split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA'));
const streamInf = (m) => m.split('\n').find((l) => l.startsWith('#EXT-X-STREAM-INF'));

test('master: five AAC-LC renditions -> variant CODECS gains mp4a.40.2; EXT-X-MEDIA byte-identical', async (t) => {
    const withProfile = await masterFor(tracks('LC'), t);
    const old = await masterFor(tracks(undefined), t);
    assert.match(streamInf(withProfile), /CODECS="avc1\.640032,mp4a\.40\.2",AUDIO="castle-audio"/);
    assert.match(streamInf(old), /CODECS="avc1\.640032",AUDIO="castle-audio"/, 'no profile known: video only, as before');
    assert.deepEqual(mediaLines(withProfile.replace(/castle-demux\/[0-9a-f]+/g, 'ID')),
        mediaLines(old.replace(/castle-demux\/[0-9a-f]+/g, 'ID')));
    assert.equal(mediaLines(withProfile).length, 5);
    assert.match(mediaLines(withProfile)[4], /NAME="Telugu",LANGUAGE="tel",DEFAULT=YES/);
});

test('master: one track with an unknown profile -> video-only CODECS; mixed known profiles -> both listed', async (t) => {
    const one = tracks('LC'); one[2] = { ...one[2], profile: null };
    assert.match(streamInf(await masterFor(one, t)), /CODECS="avc1\.640032",AUDIO=/);
    const mixed = tracks('LC'); mixed[0] = { ...mixed[0], profile: 'HE-AAC' };
    assert.match(streamInf(await masterFor(mixed, t)), /CODECS="avc1\.640032,mp4a\.40\.5,mp4a\.40\.2",AUDIO=/);
});

test('a stored probe without profiles is served as before and re-probed once in the background', async (t) => {
    const feat = runtime.features.castleDemux;
    Object.defineProperty(runtime.features, 'castleDemux', { value: true, configurable: true, writable: true });
    t.after(() => { runtime.features.castleDemux = feat; });
    let segHits = 0;
    const cdn = express();
    cdn.get('/pl.m3u8', (req, res) => res.type('application/vnd.apple.mpegurl')
        .send('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nc0.ts\n#EXT-X-ENDLIST\n'));
    cdn.get('/c0.ts', (req, res) => { segHits++; res.type('video/mp2t').send(muxedTs); });
    const srv = await new Promise((r) => { const s = cdn.listen(0, '127.0.0.1', () => r(s)); });
    t.after(() => srv.close());
    const url = `http://127.0.0.1:${srv.address().port}/pl.m3u8`;
    // A probe as stored before this change: no `profile` key.
    const real = await castleDemux.probeTracks(muxedTs);
    castleDemux.setProbe(url, { ...real, audio: real.audio.map(({ profile, ...rest }) => ({ ...rest, language: 'tel' })) });
    const row = { provider: 'CastleTV', name: 'CastleTV [Telugu]', url, quality: '1080p' };
    const first = await republish.buildCastleDemuxEntry([row], 'http://me');
    assert.ok(first, 'demux entry built');
    const id1 = first.url.match(/castle-demux\/([0-9a-f]+)\//)[1];
    assert.equal(republish.castleDemuxJobs.get(id1).audio[0].profile, undefined, 'served with the stored probe');
    for (let i = 0; i < 50 && !(castleDemux.getProbe(url).audio[0].profile); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(castleDemux.getProbe(url).audio[0].profile, 'LC', 'background re-probe stored the profile');
    assert.equal(castleDemux.getProbe(url).audio[0].language, 'tel');
    const second = await republish.buildCastleDemuxEntry([row], 'http://me');
    const id2 = second.url.match(/castle-demux\/([0-9a-f]+)\//)[1];
    assert.equal(id2, id1, 'same job id: the profile is not part of the fingerprint');
    assert.equal(castleDemux.audioCodecString(republish.castleDemuxJobs.get(id2).audio[0]), 'mp4a.40.2');
    const hits = segHits;
    await republish.buildCastleDemuxEntry([row], 'http://me');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(segHits, hits, 'no further re-probe once the profile is known');
});
