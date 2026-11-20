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

const { getStore, mediaIdentityOf, resolveAudioEvidence } = require('../../utils/store');
const { canonicalLanguage } = require('../../utils/streamSchema');

const execFileAsync = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const PROBE_TIMEOUT_MS = Number(process.env.MP4_PROBE_TIMEOUT_MS) || 12000;
const CACHE_TTL_MS = Number(process.env.MP4_PROBE_TTL_MS) || 30 * 60 * 1000;
// A probe FAILURE (timeout, unreachable url) is not evidence about the file, so
// it is cached only briefly: long enough to stop a re-probe on every resolve in
// the same burst, short enough that a Telugu tag is not hidden for 30 min when
// the probe simply could not run. A genuine "probed, no audio tags" keeps the
// full TTL above.
const PROBE_FAIL_TTL_MS = Number(process.env.MP4_PROBE_FAIL_TTL_MS) || 60 * 1000;
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
    if (Date.now() - hit.at > (hit.ttl || CACHE_TTL_MS)) { cache.delete(key); return undefined; }
    return hit.value;
}

function store(key, value, ttl) {
    cache.set(key, { at: Date.now(), value, ttl: ttl || CACHE_TTL_MS });
    if (cache.size > MAX_ENTRIES) {
        let n = 0;
        for (const k of cache.keys()) { cache.delete(k); if (++n >= Math.ceil(MAX_ENTRIES / 5)) break; }
    }
}

// `und` is ISO 639-2 for "undetermined": the muxer's default when nobody set
// a tag, so it says nothing about the audio. Passing it through made NetMirror
// ship languages:["und"], a non-empty array that counted as "already labelled"
// and skipped the platform path whose post.php carries the real language list.
// Measured 2026-11-20: movie/579974 RRR and movie/869760 Hanu-Man both probe
// as a single aac track tagged und, and returned one unlabelled row.
const NOT_A_LANGUAGE = new Set(['und', 'unk', 'unknown', 'mis', 'mul', 'zxx', 'qaa']);
function realLanguage(tag) {
    const value = String(tag || '').trim();
    return value && !NOT_A_LANGUAGE.has(value.toLowerCase()) ? value : null;
}

// Persisted evidence (audio_evidence, utils/store.js) for this file, keyed on
// the media identity - host+path, the same thing cacheKey() uses - never on
// the signed url. A stored ffprobe answer means the probe already ran on this
// exact file, in this or an earlier process, so it is not run again.
function evidenceFor(url) {
    try { return resolveAudioEvidence(getStore().audioEvidenceFor(mediaIdentityOf(url)), 'mp4'); }
    catch (e) {
        console.warn(`[mp4probe] evidence read failed: ${e.message}`);
        return { probe: null, positive: new Set(), refuted: new Set() };
    }
}

function rememberProbe(url, tracks) {
    try {
        getStore().putAudioEvidence({ mediaIdentity: mediaIdentityOf(url), source: 'ffprobe', lang: '',
            detail: { kind: 'mp4', value: tracks } });
    } catch (e) { console.warn(`[mp4probe] evidence write failed: ${e.message}`); }
}

const sameLang = (a, b) => {
    const x = canonicalLanguage(a); const y = canonicalLanguage(b);
    return Boolean(x && y && x.toLowerCase() === y.toLowerCase());
};

// Layer what viewers and providers said over what the file's tags say.
//   - A language a viewer said is NOT what played loses its label on that
//     track. The track itself stays: nothing is dropped.
//   - When exactly one track is untagged (`und`) and exactly one confirmed
//     language is missing from the tags, that track carries it. A viewer or
//     provider saying Telugu beats a muxer default that says nothing.
function applyEvidence(tracks, ev) {
    if (!Array.isArray(tracks) || (!ev.positive.size && !ev.refuted.size)) return tracks;
    const out = tracks.map((t) => (t.language && [...ev.refuted].some((r) => sameLang(r, t.language))
        ? { ...t, language: null } : t));
    const missing = [...ev.positive].filter((l) => !out.some((t) => t.language && sameLang(l, t.language)));
    const untagged = out.filter((t) => !t.language);
    if (untagged.length === 1 && missing.length === 1) {
        const i = out.indexOf(untagged[0]);
        out[i] = { ...out[i], language: canonicalLanguage(missing[0]) };
    }
    return out;
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
    const ev = evidenceFor(url);
    const cached = fromCache(key);
    if (cached !== undefined) return applyEvidence(cached, ev);
    if (ev.probe) {
        store(key, ev.probe);
        return applyEvidence(ev.probe, ev);
    }

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
                language: realLanguage(s.tags && s.tags.language),
                codec: s.codec_name || null,
                channels: Number(s.channels) || null,
            }));
        store(key, tracks);
        rememberProbe(url, tracks);
        return applyEvidence(tracks, ev);
    } catch (e) {
        // A probe failure is not evidence about the file: it must not hide a
        // Telugu tag for the full 30 min. Cache the empty only for the short
        // failure TTL, so one unreachable url does not re-probe on every resolve
        // in the same burst, but the tag is re-checked within the minute.
        store(key, [], PROBE_FAIL_TTL_MS);
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
    const ev = evidenceFor(url);
    const hit = fromCache(cacheKey(url));
    if (hit !== undefined) return applyEvidence(hit, ev);
    return ev.probe ? applyEvidence(ev.probe, ev) : undefined;
}

module.exports = { probeAudioTracks, cachedAudioTracks, applyEvidence, _cache: cache };
