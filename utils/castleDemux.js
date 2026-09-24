// CastleTV ships one MPEG-TS carrying H.264 plus FIVE muxed AAC tracks, each
// with a real ISO language tag (measured: hin/tam/tel/mal/kan on PIDs
// 0x101-0x105). MSE plays only the first of those and gives the browser no way
// to reach the rest, which is why a Castle stream labelled
// "[Telugu/Hindi/Tamil/Malayalam/Kannada]" offers no audio menu at all.
//
// Splitting the tracks apart server-side turns that single file into a proper
// HLS master: one video-only variant plus one audio rendition per language.
// This supersedes the CastleTV+NetMirror merge for any title Castle can play -
// same cut by construction, so no duration matching and no cross-provider
// drift - and it needs nothing from NetMirror.
//
// Demuxing is `ffmpeg -map 0:N -c copy`: a stream copy, no re-encode. Measured
// at ~0.05-0.25s per segment. It still cannot run upfront - a 3,141 segment
// playlist times six outputs is 18,846 ffmpeg runs for a film the viewer may
// watch five minutes of - so it runs per segment, on demand.
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// ISO 639-2 -> display name for the menu. Castle tags with three-letter codes.
const LANG_NAMES = {
    hin: 'Hindi', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam',
    kan: 'Kannada', eng: 'English', ben: 'Bengali', mar: 'Marathi',
    guj: 'Gujarati', pan: 'Punjabi', urd: 'Urdu', ori: 'Odia',
    asm: 'Assamese', und: 'Unknown',
};

function langName(code) {
    if (!code) return null;
    const c = String(code).toLowerCase();
    return LANG_NAMES[c] || c.toUpperCase();
}

// Probing costs a segment fetch plus an ffprobe run, and the answer is a
// property of the title, not of the segment. Cache it per playlist URL.
const probeCache = new Map();
const PROBE_TTL_MS = 30 * 60 * 1000;

// Reads the elementary streams out of one segment. Returns the video stream
// index plus an ordered list of audio tracks with their language tags.
async function probeTracks(segmentBuffer) {
    const tmp = path.join(os.tmpdir(), `castle-probe-${crypto.randomBytes(8).toString('hex')}.ts`);
    try {
        await fs.writeFile(tmp, segmentBuffer);
        const { stdout } = await execFileAsync(FFPROBE, [
            '-v', 'error',
            '-show_entries', 'stream=index,codec_name,codec_type,sample_rate,channels,width,height:stream_tags=language',
            '-of', 'json', tmp,
        ], { maxBuffer: 4 * 1024 * 1024 });
        const streams = (JSON.parse(stdout).streams || []);
        const video = streams.find(s => s.codec_type === 'video');
        const audio = streams
            .filter(s => s.codec_type === 'audio')
            .map(s => ({
                index: s.index,
                codec: s.codec_name,
                sampleRate: Number(s.sample_rate) || 0,
                channels: Number(s.channels) || 2,
                language: (s.tags && s.tags.language) || null,
            }));
        // Carry the video dimensions through so the republished master can
        // advertise RESOLUTION. Without it our own demux master was the one
        // manifest a probe could not read a quality out of.
        return {
            videoIndex: video ? video.index : 0,
            videoWidth: video && Number(video.width) ? Number(video.width) : null,
            videoHeight: video && Number(video.height) ? Number(video.height) : null,
            audio,
        };
    } finally {
        fs.unlink(tmp).catch(() => {});
    }
}

// Pulls one elementary stream out of a segment. `-c copy` so this is a remux,
// not a transcode. ffmpeg needs a real file for TS input seeking, so the
// segment lands in tmp for the duration of the call.
// The PTS a segment actually starts at, in seconds, for one track type.
//
// Needed because a hybrid pairs two providers whose timelines do not start at
// the same place, and the shift must be MEASURED per title rather than
// hardcoded: 1.478556s is what Devara happens to carry, not a constant of the
// provider. Returns null when the segment cannot be probed, so a caller can
// fall back to no shift rather than to a wrong one.
async function probeStartPts(segmentBuffer, kind = 'a') {
    const tmp = path.join(os.tmpdir(), `castle-pts-${crypto.randomBytes(8).toString('hex')}.ts`);
    try {
        await fs.writeFile(tmp, segmentBuffer);
        const { stdout } = await execFileAsync(FFPROBE, [
            '-v', 'error',
            '-select_streams', `${kind}:0`,
            '-show_entries', 'stream=start_time',
            '-of', 'json', tmp,
        ], { maxBuffer: 1024 * 1024 });
        const v = Number(((JSON.parse(stdout).streams || [])[0] || {}).start_time);
        return Number.isFinite(v) ? v : null;
    } catch {
        return null;
    } finally {
        fs.unlink(tmp).catch(() => {});
    }
}

// `ptsOffsetSeconds` rebases the output onto a DIFFERENT stream's timeline.
//
// Only a hybrid needs it. A Castle stream played on its own is already
// self-consistent - measured on Devara (811941), its own segment 0 carries
// video at 1.525s and audio at 1.478556s, 47ms apart and imperceptible - so
// the default of 0 leaves standalone demux playback byte-identical.
//
// A hybrid is the problem case: showsst video segment 0 starts at PTS 0.000
// while Castle audio segment 0 starts at 1.478556. hls.js aligns the two by
// PTS, so without a shift the borrowed audio runs ~1.48s late for the whole
// film. Measured constant, not drift: the gap between playlist position and
// real PTS held at 1.478/1.401/1.422/1.406/1.413s across segments
// 1/500/1500/2500/3370 of a 170-minute film.
async function extractTrack(segmentBuffer, streamIndex, ptsOffsetSeconds = 0) {
    const id = crypto.randomBytes(8).toString('hex');
    const inFile = path.join(os.tmpdir(), `castle-in-${id}.ts`);
    const outFile = path.join(os.tmpdir(), `castle-out-${id}.ts`);
    try {
        await fs.writeFile(inFile, segmentBuffer);
        await execFileAsync(FFMPEG, [
            '-v', 'error',
            '-i', inFile,
            '-map', `0:${streamIndex}`,
            '-c', 'copy',
            // Keeping the original timestamps is what lets hls.js line the
            // separated audio and video back up. Letting ffmpeg regenerate
            // them would slide the tracks apart across segment boundaries.
            '-copyts',
            // Applied on top of -copyts, which preserves the source timestamps
            // and keeps the track self-consistent across segment boundaries.
            // This shifts that whole preserved timeline by a constant so it
            // lines up with the video provider's baseline.
            ...(ptsOffsetSeconds
                ? ['-output_ts_offset', String(ptsOffsetSeconds)]
                : []),
            '-muxdelay', '0', '-muxpreload', '0',
            '-f', 'mpegts', outFile, '-y',
        ], { maxBuffer: 64 * 1024 * 1024 });
        return await fs.readFile(outFile);
    } finally {
        fs.unlink(inFile).catch(() => {});
        fs.unlink(outFile).catch(() => {});
    }
}

function getProbe(playlistUrl) {
    const hit = probeCache.get(playlistUrl);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    probeCache.delete(playlistUrl);
    return null;
}

function setProbe(playlistUrl, value) {
    probeCache.set(playlistUrl, { value, expiresAt: Date.now() + PROBE_TTL_MS });
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of probeCache) if (v.expiresAt < now) probeCache.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = {
    FFMPEG, FFPROBE, LANG_NAMES, langName,
    probeTracks, probeStartPts, extractTrack, getProbe, setProbe,
};
