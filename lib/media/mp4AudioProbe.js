// Read the audio-track languages out of a remote MP4, without downloading it.
//
// WHY THIS EXISTS
//
// NetMirror's /api/embed-tmdb/ endpoint returns bare files - {url, resolution,
// size} and nothing else. No language list, no audio array. Its other path
// (post.php, providers/netmirror.js) DOES carry `lang: [{l:"Telugu"}...]`, but
// that path is frequently rejected as a placeholder master, so for many titles
// the language-less mp4 is all we get.
//
// The languages are not actually missing - they are in the file. Measured
// 2026-09-23:
//
//   movie/628241 Ala Vaikunthapurramuloo, NetMirror 720p
//     stream 0  h264  language=eng
//     stream 1  aac   language=tel      <- Telugu, and we reported languages:[]
//
//   movie/912649 Venom: The Last Dance, NetMirror 1080p
//     stream 1  aac   language=eng      <- genuinely single-track English
//
// So the audio menu had nothing to offer and the canonical language sort could
// not rank a Telugu track above an English one, purely because nobody read the
// tag.
//
// ffprobe over http seeks to the moov atom itself and reads a few hundred KB,
// so this does NOT fetch the film. Measured well under a second per file.
// It is still a subprocess plus network, hence the cache and the timeout.

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const PROBE_TIMEOUT_MS = Number(process.env.MP4_PROBE_TIMEOUT_MS) || 12000;
const CACHE_TTL_MS = Number(process.env.MP4_PROBE_TTL_MS) || 30 * 60 * 1000;
const MAX_ENTRIES = 500;

// Signed CDN urls differ per issue but address the same file, so cache on the
// path and ignore the query - otherwise every re-resolve is a fresh probe.
function cacheKey(url) {
    try { const u = new URL(String(url)); return `${u.hostname}${u.pathname}`; }
    catch { return String(url); }
}

const cache = new Map(); // key -> { at, value }

function fromCache(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
    return hit.value;
}

function store(key, value) {
    cache.set(key, { at: Date.now(), value });
    if (cache.size > MAX_ENTRIES) {
        let n = 0;
        for (const k of cache.keys()) { cache.delete(k); if (++n >= Math.ceil(MAX_ENTRIES / 5)) break; }
    }
}

// ffprobe takes request headers as one CRLF-joined blob.
function headerBlob(headers) {
    const entries = Object.entries(headers || {});
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
}

/**
 * Audio tracks declared by a remote MP4.
 *
 * @returns {Promise<Array<{language: string|null, codec: string|null,
 *   channels: number|null}>>} [] when the probe fails or the file has no audio.
 *   Deliberately NOT null-on-failure: a caller that cannot probe should carry
 *   on with what the provider said, and [] is already "nothing known".
 */
async function probeAudioTracks(url, headers) {
    if (!url) return [];
    const key = cacheKey(url);
    const cached = fromCache(key);
    if (cached !== undefined) return cached;

    const args = ['-v', 'error'];
    const blob = headerBlob(headers);
    // Referer/UA matter: these origins answer 429 to a bare request - see
    // lib/media/streamHeaders.js.
    if (blob) args.push('-headers', blob);
    args.push(
        '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language',
        '-of', 'json', String(url),
    );

    try {
        const { stdout } = await execFileAsync(FFPROBE, args,
            { timeout: PROBE_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
        const tracks = (JSON.parse(stdout).streams || [])
            .filter((s) => s && s.codec_type === 'audio')
            .map((s) => ({
                // Raw ISO code. normaliseStream() in utils/streamSchema.js owns
                // the mapping to a display name, so it is not duplicated here;
                // `und` is dropped there rather than invented into a language.
                language: (s.tags && s.tags.language) || null,
                codec: s.codec_name || null,
                channels: Number(s.channels) || null,
            }));
        store(key, tracks);
        return tracks;
    } catch (e) {
        // A probe failure is not evidence about the file. Cache the empty
        // answer briefly anyway so one unreachable url does not re-probe on
        // every resolve.
        store(key, []);
        console.warn(`[mp4probe] ${cacheKey(url)} failed: ${String(e.message).split('\n')[0]}`);
        return [];
    }
}

/**
 * The cached answer for a url, WITHOUT starting a probe.
 *
 * Lets a caller on a latency budget decide for itself: serve the tags when we
 * already have them, otherwise return immediately and warm the cache in the
 * background. Returns undefined when nothing is cached, which is distinct from
 * [] meaning "probed, found no audio".
 */
function cachedAudioTracks(url) {
    if (!url) return undefined;
    return fromCache(cacheKey(url));
}

module.exports = { probeAudioTracks, cachedAudioTracks, _cache: cache };
