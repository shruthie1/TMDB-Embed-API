// Pairing one provider's video with another provider's audio.
//
// THE PROBLEM THIS SOLVES
// The providers split cleanly into two camps that are each useless alone for a
// Telugu viewer who wants resolution:
//
//   video-rich, audio-poor   showsst (1080p ladder), mappleapi (2160p ladder).
//                            Measured 2026-09-21 on Devara (811941): showsst's
//                            master carries ZERO #EXT-X-MEDIA:TYPE=AUDIO lines.
//                            Audio is muxed into each variant as one mp4a track
//                            in whatever language the release happened to use.
//   audio-rich, video-poor   castle-demux (4 real renditions, Telugu default),
//                            netmirror (EXT-X-MEDIA groups, but often serves a
//                            rate-limit reel in place of the video).
//
// Binding the good video to the good audio gives 1080p/4K WITH Telugu. hls.js
// then owns synchronisation - one media element, one timeline, no drift
// correction of our own.
//
// WHY THIS IS SAFE TO DO AT ALL
// The two sides must be the same cut, or the audio slides against the picture.
// We do not assume it, we measure it: total #EXTINF runtime on both sides must
// agree within DURATION_TOLERANCE_SECONDS or the pairing is refused.
//
// Measured on Devara (811941), 2026-09-21:
//   showsst 1920x804  2060 segments  10299.6s
//   castle  720p      3378 segments  10299.6s
// Zero drift. Different segmentation, identical cut. That is the normal case
// for an Indian theatrical release: everyone is reusing one master.
//
// The gate doubles as a wrong-film guard. CastleTV matches by TITLE, not by id
// (utils/titleMatch.js), so it is the one provider that can land on a different
// film. A different film is a different runtime, so it fails the gate and the
// merge is simply not offered - the viewer never hears Telugu from the wrong
// movie. That is a second, independent check that does not rely on title logic.
//
// GENERALITY
// Nothing here is keyed on a provider name. A stream is a video candidate
// because it MEASURES as having video segments, and an audio candidate because
// it MEASURES as having renditions. Add a provider tomorrow and it takes part
// in every combination automatically.

const crypto = require('crypto');
// The provider-agnostic sync primitives. See utils/ptsRebase.js.
const ptsRebase = require('./ptsRebase');
const { canonicalLanguage, trackNameLanguage, LANG_CANON } = require('./streamSchema');

const DURATION_TOLERANCE_SECONDS = Number(process.env.AUDIO_MERGE_TOLERANCE_SECONDS) || 15;

// The widened gate used when we can independently confirm the two halves are
// the same film.
//
// WHY THE STRICT GATE IS NOT ENOUGH
//
// The 15s gate exists as a WRONG-FILM guard: CastleTV matches by title, so two
// sources that disagree on runtime may be two different films, and playing a
// mismatch is worse than refusing. But runtime equality is a proxy for
// same-film, and a poor one - it also refuses the same film carrying different
// ad/intro padding, which is a solvable sync problem, not a mismatch.
//
// Measured 2026-09-23 on movie/1290190 (Lokah Chapter 1: Chandra):
//   mapple  2160p  9376s = 156m16s
//   Castle   720p  8974s = 149m34s   <- 7 audio renditions incl. Telugu
//   TMDB runtime           151m
// A 402s gap, and the strict gate refused - so the only 2160p picture on the
// title could never be paired with the only Telugu audio on it. Both sides sit
// within a few minutes of TMDB's stated runtime, so they ARE the same film and
// mapple is simply padded.
//
// When an external runtime is available we use it as the arbiter instead: each
// side must individually be close to the known runtime. That is a far stronger
// same-film test than the two sides matching each other, and it lets a padded
// source through. The padding is then an OFFSET, which the viewer's Audio
// timing nudge already exists to correct - see realisePlan.
const RUNTIME_MATCH_SECONDS = Number(process.env.AUDIO_MERGE_RUNTIME_MATCH_SECONDS) || 600;
const PADDED_TOLERANCE_SECONDS = Number(process.env.AUDIO_MERGE_PADDED_TOLERANCE_SECONDS) || 900;
const FETCH_TIMEOUT_MS = Number(process.env.AUDIO_MERGE_TIMEOUT_MS) || 12000;
const DEFAULT_VIDEO_CODEC = 'avc1.640032';
const DEFAULT_AUDIO_CODEC = 'mp4a.40.2';
const PREFERRED_LANGUAGE = process.env.PREFERRED_AUDIO_LANGUAGE || 'Telugu';

// Height -> the rank we sort video candidates by. A merge is only worth doing
// for the resolution, so the tallest usable picture wins.
function heightOf(stream) {
    const q = String(stream.quality || '');
    const m = q.match(/(\d{3,4})p/);
    if (m) return Number(m[1]);
    const best = (stream.levels || []).reduce((h, l) => Math.max(h, Number(l.height) || 0), 0);
    return best || 0;
}

async function getText(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(
        new DOMException('hybrid playlist fetch timeout', 'AbortError')), FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { headers: headers || {}, signal: controller.signal });
        if (!resp.ok) return null;
        return await resp.text();
    } catch (_e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function totalSeconds(playlist) {
    return [...String(playlist || '').matchAll(/#EXTINF:([\d.]+)/g)]
        .reduce((sum, m) => sum + parseFloat(m[1]), 0);
}

// #EXT-X-MEDIA carries its URI in an attribute rather than on the next line,
// so it needs its own parse rather than the variant walk below.
function parseAudioRenditions(master, baseUrl) {
    const out = [];
    const lines = String(master || '').split('\n');
    for (const line of lines) {
        if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=AUDIO/.test(line)) continue;
        const uri = (line.match(/URI="([^"]+)"/) || [])[1];
        if (!uri) continue;
        const codecs = renditionAudioCodec(line, lines);
        out.push({
            name: (line.match(/NAME="([^"]+)"/) || [])[1] || 'Audio',
            language: (line.match(/LANGUAGE="([^"]+)"/) || [])[1] || '',
            url: new URL(uri, baseUrl).href,
            ...(codecs ? { codecs } : {}),
        });
    }
    return out;
}

// RFC 6381 entries that are picture, not sound.
const VIDEO_CODEC_RE = /^(avc1|avc3|hvc1|hev1|dvh1|dvhe|av01|vp09|vp08|mp4v)\b/i;

/**
 * A CODECS value safe to write back into a playlist attribute, or null.
 * Only comma-separated RFC 6381 tokens pass: a quote or newline in a value
 * from a request body would otherwise inject playlist lines.
 */
function cleanCodecs(value) {
    const s = String(value || '').trim();
    if (!s || !/^[A-Za-z0-9.\-]+(\s*,\s*[A-Za-z0-9.\-]+)*$/.test(s)) return null;
    return s.split(',').map((c) => c.trim()).join(',');
}
function videoPart(codecs) {
    const c = cleanCodecs(codecs);
    return c ? c.split(',').filter((x) => VIDEO_CODEC_RE.test(x)).join(',') || null : null;
}
function audioPart(codecs) {
    const c = cleanCodecs(codecs);
    return c ? c.split(',').filter((x) => !VIDEO_CODEC_RE.test(x))[0] || null : null;
}

// The audio codec of one EXT-X-MEDIA line: its own CODECS when present, else
// the audio entry of a variant bound to its GROUP-ID (that is where masters
// usually state it: CODECS="avc1.640028,ec-3",AUDIO="aud").
function renditionAudioCodec(mediaLine, lines) {
    const own = audioPart((mediaLine.match(/CODECS="([^"]+)"/) || [])[1]);
    if (own) return own;
    const group = (mediaLine.match(/GROUP-ID="([^"]+)"/) || [])[1];
    if (!group) return null;
    for (const l of lines) {
        if (!l.startsWith('#EXT-X-STREAM-INF') || !l.includes(`AUDIO="${group}"`)) continue;
        const a = audioPart((l.match(/CODECS="([^"]+)"/) || [])[1]);
        if (a) return a;
    }
    return null;
}

// ffprobe's codec_name/profile as an RFC 6381 audio codec. null when unknown,
// so the caller keeps its own fallback rather than inventing one.
function audioCodecFromProbe(info) {
    const name = String((info && info.codecName) || '').toLowerCase();
    const profile = String((info && info.profile) || '').toLowerCase();
    if (name === 'aac') {
        if (profile === 'he-aacv2') return 'mp4a.40.29';
        if (profile === 'he-aac') return 'mp4a.40.5';
        return 'mp4a.40.2';
    }
    if (name === 'ac3') return 'ac-3';
    if (name === 'eac3') return 'ec-3';
    if (name === 'mp3') return 'mp4a.40.34';
    if (name === 'opus') return 'opus';
    if (name === 'flac') return 'fLaC';
    return null;
}

function parseVariants(master, baseUrl) {
    const out = [];
    const lines = String(master || '').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const target = (lines[i + 1] || '').trim();
        if (!target || target.startsWith('#')) continue;
        const res = (lines[i].match(/RESOLUTION=(\d+)x(\d+)/) || []);
        out.push({
            attrs: lines[i],
            height: Number(res[2]) || 0,
            url: new URL(target, baseUrl).href,
        });
    }
    return out;
}

// Walk master -> variant until we reach the playlist that actually holds
// #EXTINF lines. `preferHeight` picks the tallest variant rather than the first,
// because the whole point of a merge is the resolution.
async function resolveMediaPlaylist(url, headers, preferHeight = true) {
    const text = await getText(url, headers);
    if (!text) return null;
    if (totalSeconds(text) > 0) return { text, url, height: 0 };
    let variants = parseVariants(text, url);
    if (!variants.length) return null;
    if (preferHeight) variants = variants.slice().sort((a, b) => b.height - a.height);
    for (const variant of variants) {
        const inner = await getText(variant.url, headers);
        if (inner && totalSeconds(inner) > 0) {
            return { text: inner, url: variant.url, height: variant.height };
        }
    }
    return null;
}

// An avc1 codec string is profile+constraint+level in hex. Read it from the SPS
// of a real segment rather than guessing: a wrong level makes MSE reject the
// stream outright and the player hangs with nothing in the network log.
function avcCodecFromSegment(buffer) {
    for (let i = 0; i + 6 < buffer.length; i += 1) {
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1
            && (buffer[i + 3] & 0x1f) === 7) {
            const profile = buffer[i + 4];
            const constraint = buffer[i + 5];
            const level = buffer[i + 6];
            if (profile && level) {
                const hex = (n) => n.toString(16).padStart(2, '0');
                return `avc1.${hex(profile)}${hex(constraint)}${hex(level)}`;
            }
        }
    }
    return null;
}

// The first media segment of a playlist, plus its EXT-X-MAP init segment when
// it is fMP4. An fMP4 media segment alone is unreadable: its codec config and
// track ids live in the init segment.
function firstSegmentRefs(playlistText, playlistUrl) {
    const lines = String(playlistText || '').split('\n');
    let init = null;
    for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        if (l.startsWith('#EXT-X-MAP:')) {
            const uri = (l.match(/URI="([^"]+)"/) || [])[1];
            if (uri) init = new URL(uri, playlistUrl).href;
            continue;
        }
        if (l.startsWith('#')) continue;
        return { init, segment: new URL(l, playlistUrl).href };
    }
    return null;
}

async function fetchBytes(url, headers, what) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(
        new DOMException(`hybrid ${what} probe timeout`, 'AbortError')), FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { headers: headers || {}, signal: controller.signal });
        if (!resp.ok) return null;
        return Buffer.from(await resp.arrayBuffer());
    } finally { clearTimeout(timer); }
}

// The bytes ffprobe needs to read the head of a playlist: init + first
// segment for fMP4, the first segment alone for TS.
async function headBytes(refs, headers, what) {
    const [init, seg] = await Promise.all([
        refs.init ? fetchBytes(refs.init, headers, what) : Promise.resolve(null),
        fetchBytes(refs.segment, headers, what),
    ]);
    if (!seg || (refs.init && !init)) return null;
    return init ? Buffer.concat([init, seg]) : seg;
}

// Codec strings from an fMP4 init segment's avcC / hvcC box.
function codecFromInit(buf) {
    const avcc = buf.indexOf('avcC');
    if (avcc >= 0 && avcc + 8 < buf.length) {
        const hex = (n) => n.toString(16).padStart(2, '0');
        const [profile, constraint, level] = [buf[avcc + 5], buf[avcc + 6], buf[avcc + 7]];
        if (profile && level) {
            const entry = buf.indexOf('avc3') >= 0 && buf.indexOf('avc3') < avcc ? 'avc3' : 'avc1';
            return `${entry}.${hex(profile)}${hex(constraint)}${hex(level)}`;
        }
    }
    const hvcc = buf.indexOf('hvcC');
    if (hvcc >= 0 && hvcc + 17 < buf.length) {
        const b = hvcc + 4;
        const spaceTierProfile = buf[b + 1];
        const space = ['', 'A', 'B', 'C'][spaceTierProfile >> 6];
        const tier = (spaceTierProfile >> 5) & 1 ? 'H' : 'L';
        const profile = spaceTierProfile & 0x1f;
        // Compatibility flags are written bit-reversed (ISO/IEC 14496-15 E.3).
        let compat = buf.readUInt32BE(b + 2);
        let rev = 0;
        for (let i = 0; i < 32; i += 1) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
        const constraints = [];
        for (let i = 0; i < 6; i += 1) constraints.push(buf[b + 6 + i]);
        while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
        const level = buf[b + 12];
        const entry = buf.indexOf('hev1') >= 0 && buf.indexOf('hev1') < hvcc ? 'hev1' : 'hvc1';
        return [`${entry}.${space}${profile}`, (rev >>> 0).toString(16), `${tier}${level}`,
            ...constraints.map((c) => c.toString(16).toUpperCase())].join('.');
    }
    return null;
}

async function probeVideoCodec(playlistText, playlistUrl, headers) {
    try {
        const refs = firstSegmentRefs(playlistText, playlistUrl);
        if (!refs) return null;
        if (refs.init) {
            // fMP4: the SPS sits in the init segment's config box, never as an
            // Annex-B NAL in the media segment, so scanning the segment for
            // start codes would find nothing (or noise).
            const init = await fetchBytes(refs.init, headers, 'codec');
            const codec = init ? codecFromInit(init) : null;
            console.log(`[hybrid] codec probe fMP4 init: ${codec || 'unreadable'}`);
            return codec;
        }
        const seg = await fetchBytes(refs.segment, headers, 'codec');
        return seg ? avcCodecFromSegment(seg) : null;
    } catch (_e) {
        return null;
    }
}

// The PTS a playlist's first segment actually starts at, in seconds.
//
// The two providers in a hybrid do not agree on where zero is. Measured on
// Devara (811941): showsst video segment 0 starts at PTS 0.000000 while
// CastleTV audio segment 0 starts at 1.478556. hls.js lines the two up BY PTS,
// so binding them untouched plays the borrowed audio ~1.48s late for the whole
// film - which reads as bad lip sync, not as a stall.
//
// The shift is constant, not cumulative: playlist-position minus real-PTS held
// at 1.478 / 1.401 / 1.422 / 1.406 / 1.413 s across segments 1, 500, 1500,
// 2500 and 3370 of a 170-minute film. So one measurement at the head is enough
// to correct the entire timeline.
//
// It is MEASURED per pairing rather than hardcoded, because 1.478556 is what
// this title happens to carry, not a property of the provider.
async function probeSegmentInfo(playlistText, playlistUrl, headers, kind = 'a') {
    const none = { pts: null, codecName: null, profile: null };
    try {
        // A rendition is known only by its URL - parseAudioRenditions carries no
        // playlist body - so fetch it when the caller has no text to hand.
        let text = playlistText;
        if (!text) {
            const r = await fetch(playlistUrl, { headers: headers || {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!r.ok) return none;
            text = await r.text();
        }
        const refs = firstSegmentRefs(text, playlistUrl);
        if (!refs) return none;
        const buf = await headBytes(refs, headers, 'pts');
        if (!buf) return none;
        return await ptsRebase.segmentInfo(buf, kind);
    } catch (_e) {
        return none;
    }
}

async function probeStartPts(playlistText, playlistUrl, headers, kind = 'a') {
    return (await probeSegmentInfo(playlistText, playlistUrl, headers, kind)).pts;
}

module.exports = {
    DURATION_TOLERANCE_SECONDS, PREFERRED_LANGUAGE,
    heightOf, getText, totalSeconds, parseAudioRenditions, parseVariants,
    resolveMediaPlaylist, avcCodecFromSegment, probeVideoCodec, probeStartPts,
    probeSegmentInfo, codecFromInit, cleanCodecs, videoPart, audioPart, audioCodecFromProbe,
};

// ---------------------------------------------------------------------------
// Classification
//
// A stream is described ONCE and the result cached, because the naive nested
// pairing loop would otherwise refetch the same playlist for every candidate on
// the other side (V video x A audio = V*A fetches for V+A distinct playlists).

const describeCache = new Map();
const DESCRIBE_TTL_MS = 10 * 60 * 1000;

function cacheKey(stream) { return `${stream.provider}|${stream.url}`; }

function fromCache(key) {
    const hit = describeCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > DESCRIBE_TTL_MS) { describeCache.delete(key); return null; }
    return hit.value;
}

/**
 * What can this stream contribute to a pairing?
 *
 * Returns { seconds, video, audio } where `video` is present when the stream
 * has real picture segments, and `audio` is present when it can supply named
 * audio. Both can be present - castle-demux is a perfectly good video source
 * too, it is just short on resolution.
 *
 * Deliberately measured, never assumed from the provider name. A provider that
 * starts shipping renditions tomorrow becomes an audio source with no code
 * change here.
 */
async function describeStream(stream) {
    if (!stream || !stream.url) return null;
    const key = cacheKey(stream);
    const cached = fromCache(key);
    if (cached !== null) return cached;

    // A proxied url is described from its upstream, so rendition and variant
    // urls come back as upstream urls and every later decision (rebase, header
    // refill, re-proxying) sees the real target. See unwrapProxied.
    const unwrapped = unwrapProxied(stream.url);
    if (unwrapped.url !== stream.url) {
        const own = stream.headers && Object.keys(stream.headers).length;
        console.log(`[hybrid] describe ${stream.provider}: unwrapped proxied url to upstream`
            + ` (headers from ${own ? 'caller' : (Object.keys(unwrapped.headers).length ? 'wrapper' : 'none')})`);
        stream = { ...stream, url: unwrapped.url, headers: own ? stream.headers : unwrapped.headers };
    }
    const headers = stream.headers || {};
    const masterText = await getText(stream.url, headers);
    if (!masterText) { describeCache.set(key, { at: Date.now(), value: null }); return null; }

    // Audio side: renditions declared in the master we just fetched.
    const renditions = parseAudioRenditions(masterText, stream.url);

    // Video side: walk down to a playlist with real segments.
    const media = totalSeconds(masterText) > 0
        ? { text: masterText, url: stream.url, height: 0 }
        : await resolveMediaPlaylist(stream.url, headers);

    // Keep the WHOLE ladder, not just the variant we measured. A hybrid master
    // that advertises one variant collapses the player's quality menu to a
    // single entry and disables ABR: hls.js only adapts between levels it was
    // given. Carrying every variant through means auto-quality behaves exactly
    // as it does on a normal stream, and the merge is invisible to the viewer.
    const ladder = parseVariants(masterText, stream.url)
        .filter((v) => v.height > 0)
        .sort((a, b) => b.height - a.height);

    let seconds = media ? totalSeconds(media.text) : 0;

    // A rendition-only master (castle-demux audio side) still needs a runtime.
    // Every rendition is one mix re-encoded, so probing the first settles all.
    if (!seconds && renditions.length) {
        const probe = await getText(renditions[0].url, headers);
        seconds = totalSeconds(probe);
    }

    if (!seconds) { describeCache.set(key, { at: Date.now(), value: null }); return null; }

    const value = {
        provider: stream.provider,
        seconds,
        headers,
        video: media
            ? { url: media.url, text: media.text, height: media.height || heightOf(stream), ladder }
            : null,
        audio: renditions.length ? { renditions } : null,
    };
    describeCache.set(key, { at: Date.now(), value });
    return value;
}

// Telugu first, then track count. The user's standing requirement is Telugu, so
// it is applied here at ranking time rather than being wired into a provider.
function audioScore(desc) {
    const langs = (desc.audio?.renditions || [])
        .map((r) => `${r.name} ${r.language}`.toLowerCase());
    const preferred = PREFERRED_LANGUAGE.toLowerCase();
    const hasPreferred = langs.some((l) => l.includes(preferred)
        || l.includes(preferred.slice(0, 3)));
    return (hasPreferred ? 1000 : 0) + langs.length;
}

/**
 * Every viable video+audio pairing, best first.
 *
 * "Viable" is measured, not guessed: same runtime within tolerance, different
 * providers, and each side actually carrying what it is being asked for.
 */
async function planPairings(streams, opts = {}) {
    const strictTolerance = opts.tolerance ?? DURATION_TOLERANCE_SECONDS;
    // Seconds, from TMDB. Optional: without it the strict gate is all we have.
    const runtime = Number(opts.runtimeSeconds) || 0;
    const described = [];
    for (const s of streams || []) {
        const d = await describeStream(s).catch(() => null);
        if (d) described.push({ stream: s, desc: d });
    }

    const videos = described.filter((d) => d.desc.video)
        .sort((a, b) => (b.desc.video.height || heightOf(b.stream))
            - (a.desc.video.height || heightOf(a.stream)));
    const audios = described.filter((d) => d.desc.audio)
        .sort((a, b) => audioScore(b.desc) - audioScore(a.desc));

    const plans = [];
    for (const v of videos) {
        for (const a of audios) {
            // Pairing a provider with itself is pointless and actively harmful:
            // the video side is the same reel whose audio we are borrowing.
            if (String(v.stream.provider).toLowerCase()
                === String(a.stream.provider).toLowerCase()) continue;
            const delta = Math.abs(v.desc.seconds - a.desc.seconds);

            // Two ways to be accepted. Either the two sides agree with each
            // other (the original strict gate), or a known runtime vouches for
            // both of them individually - see RUNTIME_MATCH_SECONDS.
            //
            // The padded path still has an upper bound. Without one, a 45min
            // episode would pair with a 3h film whenever the runtime lookup
            // happened to be missing for one of them.
            const bothMatchRuntime = runtime > 0
                && Math.abs(v.desc.seconds - runtime) <= RUNTIME_MATCH_SECONDS
                && Math.abs(a.desc.seconds - runtime) <= RUNTIME_MATCH_SECONDS;
            const padded = bothMatchRuntime && delta <= PADDED_TOLERANCE_SECONDS;
            if (delta > strictTolerance && !padded) continue;

            plans.push({
                video: v, audio: a, delta,
                // True when this pairing only got through because TMDB vouched
                // for both halves. The gap is then real content padding, which
                // the PTS probe cannot see (it corrects the encoder baseline,
                // not an ad reel at the head), so the viewer may still need the
                // Audio timing nudge. Surfaced so the UI can say so instead of
                // leaving them to discover it.
                padded: Boolean(padded && delta > strictTolerance),
                height: v.desc.video.height || heightOf(v.stream),
                languages: a.desc.audio.renditions.map((r) => r.name),
                score: audioScore(a.desc),
            });
        }
    }
    // Tallest picture wins; among equals, the richer/Telugu-bearing audio wins.
    // Tallest picture first, then the richer/Telugu-bearing audio. An exact
    // duration match is preferred over a padded one at equal height and score,
    // since the padded pairing may need a manual nudge.
    plans.sort((x, y) => (y.height - x.height)
        || (y.score - x.score)
        || (Number(x.padded) - Number(y.padded)));
    return plans;
}

module.exports.describeStream = describeStream;
module.exports.planPairings = planPairings;
module.exports.audioScore = audioScore;
module.exports._describeCache = describeCache;

// ---------------------------------------------------------------------------
// Master construction
//
// The CODECS placement below is not cosmetic. Both halves of it were paid for
// in debugging time (see the original utils/audioMerge.js), so neither should
// be "tidied":
//
//   On the VARIANT: video codec ONLY. The video side is usually NOT video-only
//   - a Castle TS carries h264 plus muxed AAC - and if we advertise an audio
//   codec here, hls.js tries to reconcile that embedded audio against the
//   external AUDIO group and the transmuxer throws fragParsingError. Segments
//   download fine and nothing ever plays. Declaring only the video codec tells
//   hls.js this variant contributes picture, so it drops the embedded audio and
//   takes sound from the group.
//
//   On the RENDITIONS: audio codec. With it absent from BOTH places, hls.js
//   re-derives the codec set on an audio-track switch and builds an audio-only
//   SourceBuffer (BUFFER_CODECS fires with ["audio"]). Video then has nowhere
//   to append: the buffered range freezes, the playhead runs past it, and
//   gap-controller spins bufferStalledError -> bufferNudgeOnStall, refetching
//   at ~200 fragments/second.

// Upstream CDNs reject requests without the provider's Referer, and a browser
// cannot be made to send one. Every child URL therefore points back at our own
// m3u8-proxy carrying the right headers.
// Snap a measured pixel height to the display tier a viewer recognises. A
// 2.39:1 film encoded in a 1920-wide ladder measures 804 tall, not 1080, and
// labelling it "804p" both reads wrong and sorts below an actual 720p stream.
function tierFor(height) {
    const h = Number(height) || 0;
    if (h >= 1700) return '2160p';
    if (h >= 1150) return '1440p';
    if (h >= 750) return '1080p';
    if (h >= 500) return '720p';
    if (h >= 350) return '480p';
    if (h > 0) return '360p';
    return 'Auto';
}

// The browser plays (and posts back) PROXIED urls:
// <base>/m3u8-proxy?url=<encoded upstream>&headers=<json>. Everything that
// decides how to treat a url - local or remote, which headers it needs - must
// look at the upstream inside, not at the wrapper. Judged by its prefix, a
// proxied NetMirror rendition read as LOCAL and lost rebase=1, so its measured
// PTS offset was silently ignored by the proxy (docs/PENDING-WORK.md H1).
// Matches the path on any host: the public base the browser saw need not equal
// the one this request arrived on. Returns {url, headers}; headers are the
// wrapper's own, {} when it carried none or the url was not a wrapper.
function unwrapProxied(url, depth = 0) {
    const plain = { url, headers: {} };
    if (!url || depth > 2) return plain;
    let u;
    try { u = new URL(String(url)); } catch { return plain; }
    if (!u.pathname.endsWith('/m3u8-proxy')) return plain;
    const inner = u.searchParams.get('url');
    if (!inner || !/^https?:\/\//i.test(inner)) return plain;
    let headers = {};
    try {
        const parsed = JSON.parse(u.searchParams.get('headers') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed;
    } catch { /* unsigned wrapper: no headers */ }
    const deeper = unwrapProxied(inner, depth + 1);
    return {
        url: deeper.url,
        headers: Object.keys(deeper.headers).length ? deeper.headers : headers,
    };
}

function proxied(serverUrl, url, headers) {
    // A URL that already points at this server needs no proxy: castle-demux
    // playlists and their segments are served locally and carry no upstream
    // Referer requirement. Wrapping them produced
    // /ts-proxy?url=...%2Fts-proxy%3Furl%3D...%2Fseg%2Fa3%2F300.ts, which
    // serves the first request and then 404s on SEEK, because the doubly
    // encoded inner url stops resolving once the player jumps to a segment
    // outside what it had already fetched.
    if (String(url).startsWith(serverUrl)) return url;
    const h = headers && Object.keys(headers).length
        ? `&headers=${encodeURIComponent(JSON.stringify(headers))}`
        : '';
    return `${serverUrl}/m3u8-proxy?url=${encodeURIComponent(url)}${h}`;
}

// Stamp the measured rebase onto an AUDIO rendition url.
//
// Two mechanisms, because two kinds of url reach this point and only one of
// them can shift its own timestamps:
//
//   LOCAL (castle-demux)  already runs ffmpeg per segment to split the tracks
//                         out, so `?pts=` rides along and the shift is free.
//
//   REMOTE (anything else) is served untouched by m3u8-proxy, which has no
//                         rebase. Its SEGMENTS must be routed through
//                         /pts-rebase instead - marked here with `rebase=1` so
//                         the playlist rewriter knows to redirect them.
//
// Getting this wrong is silent: the audio simply plays early or late, which is
// exactly how the Castle desync shipped unnoticed until it was measured.
//
// A zero offset leaves the url untouched in both cases, so standalone playback
// keeps its own timestamps.
function withPts(url, ptsOffset, opts = {}) {
    if (!ptsOffset) return url;
    const sep = String(url).includes('?') ? '&' : '?';
    const remote = opts.remote ? '&rebase=1' : '';
    return `${url}${sep}pts=${ptsOffset}${remote}`;
}

// Canonical names of every language the schema knows ('Telugu', 'Hindi', ...).
const KNOWN_LANGUAGES = new Set(Object.values(LANG_CANON));

// The known language a value names ('te', 'tel-IN', 'Hindi'), or null. Unlike
// canonicalLanguage, an unrecognised value is NOT title-cased into a language.
function knownLanguageName(value) {
    const canon = canonicalLanguage(value);
    return canon && KNOWN_LANGUAGES.has(canon) ? canon : null;
}

// One rendition's language, Step 1's rule as on web (languageSources.js
// renditionLanguage) and APK: the LANGUAGE tag first. The name is read only
// when the tag is empty, 'und' or not a language, so {name:'Hindi',
// language:'tel'} is Telugu, and an und track named 'Hindi AAC 2.0' is Hindi.
function renditionLanguage(r) {
    return knownLanguageName(r.language)
        || knownLanguageName(r.name)
        || trackNameLanguage(r.name);
}

// The index of the first rendition in `language` (any name or code), or -1.
// opts.byTrackName (an ASKED language): tag first, then the name, via
// renditionLanguage. Without it, the old exact LANGUAGE/NAME match, so the
// no-language default stays exactly as it was for APK 1.2.37 and the web.
function languageRenditionIndex(renditions, language, opts = {}) {
    const list = renditions || [];
    if (opts.byTrackName) {
        const wanted = knownLanguageName(language);
        return wanted ? list.findIndex((r) => renditionLanguage(r) === wanted) : -1;
    }
    const wanted = canonicalLanguage(language);
    if (!wanted) return -1;
    return list.findIndex((r) =>
        canonicalLanguage(r.language) === wanted
        || canonicalLanguage(r.name) === wanted);
}

// The rendition hls.js should start on: `language` (the viewer's explicit pick
// from /hybrid/pair), else PREFERRED_AUDIO_LANGUAGE, by name or language code,
// else index 0. Shared with the cast route so both agree.
function defaultAudioIndex(renditions, language = null) {
    const i = language
        ? languageRenditionIndex(renditions, language, { byTrackName: true })
        : languageRenditionIndex(renditions, PREFERRED_LANGUAGE);
    return i < 0 ? 0 : i;
}

// audioCodec: the donor's audio codec when measured (probe or stream.codecs).
// Each rendition's own codec from its master wins over it; mp4a.40.2 is the
// fallback only when neither is known.
//
// opts.castSingleAudio: emit ONLY the default (preferred-language) rendition.
// For casting (docs/PENDING-WORK.md C2): a TV receiver may offer no audio menu,
// so every extra rendition is a chance to play the wrong language.
function buildMaster(plan, serverUrl, videoCodec, ptsOffset = 0, audioCodec = null, opts = {}) {
    const { video, audio } = plan;
    const renditions = audio.desc.audio.renditions;

    // DEFAULT=YES decides what actually comes out of the speakers, because
    // hls.js starts on the default rendition. Index 0 is whichever track the
    // provider happened to list first, which has nothing to do with the film's
    // language: on Devara (811941), a Telugu original, Castle's track 0 is
    // Kannada. Honour PREFERRED_AUDIO_LANGUAGE and fall back to 0.
    // plan.language is the viewer's explicit "Add <L> audio" pick; without
    // one this is the PREFERRED_AUDIO_LANGUAGE default, as before.
    const defaultIndex = defaultAudioIndex(renditions, plan.language || null);

    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    renditions.forEach((r, i) => {
        if (opts.castSingleAudio && i !== defaultIndex) return;
        // Decide local vs remote from the upstream, not the wrapper. A
        // rendition that arrived already proxied is re-wrapped once, carrying
        // the wrapper's headers when the description has none.
        const inner = unwrapProxied(r.url);
        const wrapped = inner.url !== r.url;
        const remote = !String(inner.url).startsWith(serverUrl);
        const hdrs = Object.keys(audio.desc.headers || {}).length ? audio.desc.headers : inner.headers;
        if (wrapped && remote && ptsOffset) {
            console.log(`[hybrid] audio rendition ${i} was proxied; unwrapped to upstream so rebase=1 carries pts=${ptsOffset}`);
        }
        const attrs = [
            'TYPE=AUDIO',
            'GROUP-ID="hybrid-audio"',
            `NAME="${String(r.name).replace(/"/g, '')}"`,
            r.language ? `LANGUAGE="${r.language}"` : null,
            `CODECS="${cleanCodecs(r.codecs) || audioCodec || DEFAULT_AUDIO_CODEC}"`,
            `DEFAULT=${i === defaultIndex ? 'YES' : 'NO'}`,
            'AUTOSELECT=YES',
            `URI="${withPts(proxied(serverUrl, inner.url, hdrs), ptsOffset, { remote })}"`,
        ].filter(Boolean);
        lines.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
    });

    // Every video variant, so the player's quality menu and ABR work exactly as
    // they do on an ordinary stream. Each one is bound to the SAME audio group,
    // which is what lets hls.js change resolution without touching the audio
    // track - switching quality must not drop the viewer back to Kannada.
    //
    // Audio is deliberately NOT re-declared per variant: one group, N variants.
    const ladder = (video.desc.video.ladder || []).length
        ? video.desc.video.ladder
        : [{ url: video.desc.video.url, height: plan.height || 0, attrs: '' }];

    for (const v of ladder) {
        const h = v.height || plan.height || 720;
        // Reuse the origin's own BANDWIDTH when it gave one: ABR switches on
        // bitrate, and a made-up figure makes it pick badly on a slow line.
        const declared = (v.attrs.match(/BANDWIDTH=(\d+)/) || [])[1];
        const bandwidth = Number(declared) || Math.max(800000, h * 3500);
        const resAttr = (v.attrs.match(/RESOLUTION=(\d+x\d+)/) || [])[1]
            || (h ? `${Math.round(h * 16 / 9)}x${h}` : null);
        // CODECS from the origin variant when present, else the probed value.
        // Strip any audio codec: see the note above - advertising audio on the
        // variant makes hls.js reconcile embedded audio against the group and
        // throw fragParsingError.
        const originCodecs = (v.attrs.match(/CODECS="([^"]+)"/) || [])[1];
        // videoPart drops every non-video entry (mp4a, ac-3, ec-3, ...).
        const videoOnly = videoPart(originCodecs) || '';
        const codecs = videoOnly || videoCodec || DEFAULT_VIDEO_CODEC;
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}`
            + (resAttr ? `,RESOLUTION=${resAttr}` : '')
            + `,CODECS="${codecs}",AUDIO="hybrid-audio"`);
        lines.push(proxied(serverUrl, v.url, video.desc.headers));
    }
    return lines.join('\n') + '\n';
}

/**
 * Realise one plan into a playable master playlist.
 *
 * Kept separate from planPairings because it costs a segment download (the
 * codec probe). Listing is cheap; only the pairing the viewer actually picks
 * pays this.
 */
async function realisePlan(plan, serverUrl, opts = {}) {
    if (!plan) return null;
    // Both probes hit the network; they are independent, so run them together.
    // The audio side reads the FIRST rendition: all of Castle's tracks are
    // demuxed from one source file and therefore share a baseline, so probing
    // one is probing all of them.
    const firstAudio = (plan.audio.desc.audio.renditions || [])[0];
    // The provider's own measured CODECS (stream.codecs, e.g. mapple's
    // "hvc1.1.6.L150.90,mp4a.40.2") beats a probe that reads H.264 only.
    const statedVideo = videoPart(plan.video.stream.codecs);
    const [probed, videoPts, audioInfo] = await Promise.all([
        statedVideo ? Promise.resolve(null) : probeVideoCodec(
            plan.video.desc.video.text, plan.video.desc.video.url, plan.video.desc.headers),
        probeStartPts(
            plan.video.desc.video.text, plan.video.desc.video.url,
            plan.video.desc.headers, 'v'),
        firstAudio
            ? probeSegmentInfo(null, firstAudio.url, plan.audio.desc.headers, 'a')
            : Promise.resolve({ pts: null }),
    ]);
    const codec = statedVideo || probed;
    const audioPts = audioInfo.pts;
    const statedAudio = audioPart(plan.audio.stream.codecs);
    const probedAudio = audioCodecFromProbe(audioInfo);
    const audioCodec = (firstAudio && cleanCodecs(firstAudio.codecs)) || statedAudio || probedAudio || null;
    console.log(`[hybrid] codecs: video ${statedVideo ? 'stream.codecs' : (probed ? 'probe' : 'default')}=`
        + `${codec || DEFAULT_VIDEO_CODEC} audio ${firstAudio && cleanCodecs(firstAudio.codecs) ? 'master'
            : (statedAudio ? 'stream.codecs' : (probedAudio ? 'probe' : 'default'))}=${audioCodec || DEFAULT_AUDIO_CODEC}`);

    // Shift the audio so its zero lands on the video's zero. Either probe
    // failing means we do not KNOW the offset, and guessing one would be worse
    // than leaving the streams as they are, so it falls back to no shift.
    // `plan.nudge` is the viewer's manual correction from the Audio timing
    // bar. It is ADDED to the measured offset rather than replacing it: the
    // probe handles the encoder's baseline, the nudge handles whatever is left
    // (a dub mastered against a different cut, say). Positive = audio later.
    const auto = ptsRebase.offsetFor(videoPts, audioPts);
    const nudge = Number(plan.nudge) || 0;
    const ptsOffset = Number((auto + nudge).toFixed(6));

    console.log(`[hybrid] ${plan.video.stream.provider} video (${plan.height}p) + `
        + `${plan.audio.stream.provider} audio (${plan.languages.join('/')}) `
        + `delta=${plan.delta.toFixed(1)}s codec=${codec || DEFAULT_VIDEO_CODEC} `
        + `vpts=${videoPts} apts=${audioPts} auto=${auto} nudge=${nudge} `
        + `ptsOffset=${ptsOffset}`);
    const playlist = buildMaster(plan, serverUrl, codec, ptsOffset, audioCodec,
        { castSingleAudio: Boolean(opts.castSingleAudio) });
    return {
        playlist,
        codecs: masterCodecs(playlist),
        audioCodec: audioCodec || DEFAULT_AUDIO_CODEC,
        ptsOffset,
        videoProvider: plan.video.stream.provider,
        audioProvider: plan.audio.stream.provider,
        languages: plan.languages,
        height: plan.height,
        delta: plan.delta,
    };
}

// What a built master asks the browser to decode: the distinct variant video
// codecs, and the DEFAULT rendition's audio codec. /hybrid/pair returns this so
// the player can check MediaSource support before it switches (H8).
function masterCodecs(playlist) {
    const video = [...new Set([...String(playlist).matchAll(/#EXT-X-STREAM-INF:[^\n]*CODECS="([^"]+)"/g)]
        .map((m) => m[1]))];
    const media = String(playlist).split('\n').filter((l) => l.startsWith('#EXT-X-MEDIA:'));
    const def = media.find((l) => l.includes('DEFAULT=YES')) || media[0] || '';
    const audio = (def.match(/CODECS="([^"]+)"/) || [])[1] || null;
    return { video, audio };
}

// A stable id for a pairing, so a lazily-built master can be addressed by URL
// without carrying both source urls in the querystring.
function planId(plan) {
    // The nudge is part of the identity. Without it two different manual
    // offsets hash to the same id and the second one silently serves the
    // first one's cached master.
    // The asked language is too: the same two urls with a different default
    // rendition are a different master. Appended only when set, so every
    // no-language id (APK 1.2.37, web) hashes exactly as before.
    const nudge = Number(plan.nudge) || 0;
    const lang = plan.language ? `|${plan.language}` : '';
    return crypto.createHash('sha1')
        .update(`${plan.video.stream.url}|${plan.audio.stream.url}|${nudge}${lang}`)
        .digest('hex').slice(0, 24);
}

/**
 * Turn plans into catalogue entries WITHOUT building them.
 *
 * The user chose lazy realisation: the list stays cheap and the probe happens
 * when a pairing is actually played. Entries are emitted ALONGSIDE the original
 * streams (never replacing them) so a misbehaving merge always has a fallback.
 */
function describePlansAsStreams(plans, serverUrl) {
    return plans.map((plan) => {
        const id = planId(plan);
        return {
            url: `${serverUrl}/hybrid/${id}/master.m3u8`,
            provider: `${plan.video.stream.provider}+${plan.audio.stream.provider}`,
            title: `${plan.video.stream.provider} video + ${plan.audio.stream.provider} audio`,
            // Label with the TALLEST variant, snapped to a standard tier. The
            // measured height is the real pixel height (showsst's 1080p ladder
            // tops out at 1920x804 on a scope-ratio film), and a card reading
            // "804p" is both odd and sorts below a 720p row that is actually
            // smaller. `levels` carries the true ladder for the quality menu.
            quality: tierFor(plan.height),
            levels: (plan.video.desc.video.ladder || []).map((v) => ({
                height: v.height,
                quality: tierFor(v.height),
                bandwidth: Number((v.attrs.match(/BANDWIDTH=(\d+)/) || [])[1]) || null,
            })),
            languages: plan.languages,
            selectableAudio: plan.languages.length > 1,
            container: 'hls',
            headers: {},
            // Already points at this server and embeds its own proxied child
            // URLs. Without this, processStreamsForProxy wraps the master a
            // second time and every child becomes
            // /ts-proxy?url=...%2Fts-proxy%3Furl%3D... - which resolves on the
            // first request and then 404s on seek. streamSchema preserves the
            // flag; proxyServer strips it after honouring it.
            __noProxy: true,
            // Explicit marker for the player: a hybrid needs looser fragment
            // gap tolerances because the two sides share a cut but not a
            // segmentation. Inferring it from the "A+B" provider string works
            // but is fragile - a provider could legitimately contain a "+".
            hybrid: true,
            __hybrid: { id, plan },
        };
    });
}

module.exports.buildMaster = buildMaster;
module.exports.defaultAudioIndex = defaultAudioIndex;
module.exports.languageRenditionIndex = languageRenditionIndex;
module.exports.knownLanguageName = knownLanguageName;
module.exports.realisePlan = realisePlan;
module.exports.masterCodecs = masterCodecs;
module.exports.planId = planId;
module.exports.describePlansAsStreams = describePlansAsStreams;
module.exports.proxied = proxied;
module.exports.tierFor = tierFor;
module.exports.withPts = withPts;
module.exports.unwrapProxied = unwrapProxied;
