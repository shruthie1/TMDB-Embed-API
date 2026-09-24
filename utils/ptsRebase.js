'use strict';

// Rebasing an audio timeline onto a video timeline, for ANY provider.
//
// A hybrid binds one provider's video to another's audio. Nothing guarantees
// the two agree on where zero is, and hls.js aligns them BY PTS - so a
// mismatched baseline plays the audio early or late for the whole film. It
// reads as bad lip sync, not as an error, and no amount of buffer tuning
// touches it.
//
// Measured 2026-09-22 on Devara (811941):
//   showsst  video segment 0   start_pts 0.000000
//   CastleTV audio segment 0   start_pts 1.478556   -> audio 1.48s late
//
// The offset is CONSTANT, not cumulative. Playlist position minus real PTS
// held at 1.478 / 1.401 / 1.422 / 1.406 / 1.413 s across segments 1, 500,
// 1500, 2500 and 3370 of a 170-minute film, so one measurement at the head
// corrects the entire timeline.
//
// WHY THIS MODULE EXISTS SEPARATELY FROM castleDemux
//
// The first fix lived in the castle-demux route, which meant only Castle audio
// could be rebased. But describeStream() classifies an audio source by MEASURED
// renditions, not by provider name - so NetMirror, or anything else shipping
// EXT-X-MEDIA renditions, gets paired too and would then desync silently,
// because its segments go through m3u8-proxy where no rebase existed.
//
// This module is the provider-agnostic half: given a raw MPEG-TS segment and
// an offset, it returns the same segment on a shifted timeline. It does not
// know or care which provider produced the bytes.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

// One frame at 24fps is 41ms, and a provider's own tracks routinely sit a few
// tens of ms apart - Castle's own video and audio are 47ms apart in the source
// and nobody notices. Below this, a rebase costs an ffmpeg run per segment to
// correct something no viewer can see.
const NEGLIGIBLE_SECONDS = 0.05;

/** The PTS a segment's first frame carries, in seconds. null when unreadable. */
async function startPts(segmentBuffer, kind = 'a') {
    const tmp = path.join(os.tmpdir(), `pts-${crypto.randomBytes(8).toString('hex')}.ts`);
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

/**
 * The shift that puts `audioPts` onto `videoPts`, or 0 when unknown.
 *
 * Returns 0 rather than guessing when either side could not be probed: an
 * unshifted stream is merely as wrong as it was before, while a wrong shift
 * breaks a pairing that might have been fine.
 */
function offsetFor(videoPts, audioPts) {
    if (!Number.isFinite(videoPts) || !Number.isFinite(audioPts)) return 0;
    const delta = Number((videoPts - audioPts).toFixed(6));
    return Math.abs(delta) < NEGLIGIBLE_SECONDS ? 0 : delta;
}

/**
 * Return `segmentBuffer` with every timestamp shifted by `offsetSeconds`.
 *
 * A zero offset returns the input untouched - no ffmpeg run, no temp files -
 * so putting this on a path that does not need it costs nothing.
 *
 * `-copyts` preserves the source timestamps, which is what keeps the track
 * self-consistent across segment boundaries; `-output_ts_offset` then shifts
 * that whole preserved timeline by a constant. Stream copy, never a re-encode.
 */
async function rebaseSegment(segmentBuffer, offsetSeconds) {
    if (!offsetSeconds) return segmentBuffer;
    const id = crypto.randomBytes(8).toString('hex');
    const inFile = path.join(os.tmpdir(), `reb-in-${id}.ts`);
    const outFile = path.join(os.tmpdir(), `reb-out-${id}.ts`);
    try {
        await fs.writeFile(inFile, segmentBuffer);
        await execFileAsync(FFMPEG, [
            '-v', 'error',
            '-i', inFile,
            '-c', 'copy',
            '-copyts',
            '-output_ts_offset', String(offsetSeconds),
            '-muxdelay', '0', '-muxpreload', '0',
            '-f', 'mpegts', outFile, '-y',
        ], { maxBuffer: 64 * 1024 * 1024 });
        return await fs.readFile(outFile);
    } catch {
        // A segment we cannot shift is still a segment. Serving it unshifted
        // keeps playback going with bad sync; failing the request stalls it.
        return segmentBuffer;
    } finally {
        fs.unlink(inFile).catch(() => {});
        fs.unlink(outFile).catch(() => {});
    }
}

/** Stamp a measured offset onto a url so the segment route can honour it. */
function withPts(url, offsetSeconds) {
    if (!offsetSeconds) return url;
    return `${url}${String(url).includes('?') ? '&' : '?'}pts=${offsetSeconds}`;
}

/** Read a `?pts=` back off a request. 0 when absent or malformed. */
function ptsFromQuery(query) {
    const v = Number(query && query.pts);
    return Number.isFinite(v) ? v : 0;
}

module.exports = {
    NEGLIGIBLE_SECONDS,
    startPts, offsetFor, rebaseSegment, withPts, ptsFromQuery,
};
