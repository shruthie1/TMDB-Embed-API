'use strict';

// How each provider states quality and audio - and how to read it.
//
// Providers do not disagree slightly; they disagree structurally. Measured
// 2026-09-21 across the live set, there are five distinct idioms:
//
//   RELEASE_NAME   quality encoded in a scene filename, audio not stated at all
//                  e.g. VaPlayer: "Peddi.2026.1080p.WEBRip.x264.AAC5.1-[YTS]"
//                  -> providers/vaplayer.js:109 read "1080p" from this string
//                     while the manifest ladder actually topped out at 804px.
//   FIELD          a structured field on the API response
//                  e.g. NetMirror `stream.resolution` -> "1080p"
//   LABEL          languages spelled into the display name, "[Hindi/Telugu]"
//                  e.g. CastleTV
//   MANIFEST       nothing stated; the truth is in the HLS master
//                  e.g. OneTouchTV, and every provider's real ladder
//   MUXED          multiple audio tracks muxed into the TS, invisible to HLS
//                  e.g. CastleTV - needs ffprobe, see utils/castleDemux.js
//
// A provider usually mixes several: CastleTV is LABEL for language, MANIFEST
// for the ladder and MUXED for real audio. So this is not a per-provider
// switch - it is a set of composable extractors, each of which reports
// CONFIDENCE. Confidence is what lets the merge step in resolveCapabilities()
// prefer a measured fact over a parsed guess without knowing which provider it
// came from.

// Ordered worst -> best. A higher-confidence source always wins a conflict.
const CONFIDENCE = {
    GUESS: 1,     // parsed out of a human-readable string
    CLAIMED: 2,   // a structured field the provider set
    MEASURED: 3,  // read from the manifest or the container itself
};

const QUALITY_RE = /\b(2160p|1440p|1080p|720p|480p|360p|240p)\b/i;

// RELEASE_NAME: pull quality from a scene-style filename. Deliberately does
// NOT infer audio languages from tokens like "DUAL" or "Multi" - those say a
// file has more than one track, never which languages, and inventing names
// from them is how a fake language menu gets built.
function fromReleaseName(text) {
    const s = String(text || '');
    if (!s) return null;
    const m = s.match(QUALITY_RE);
    let quality = m ? m[1].toLowerCase() : null;
    if (!quality && /\b(4k|uhd)\b/i.test(s)) quality = '2160p';
    if (!quality) return null;
    return { quality, source: 'release-name', confidence: CONFIDENCE.GUESS };
}

// FIELD: a provider-set value such as `quality: "1080p"` or `resolution: 1080`.
function fromField(value) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    if (!s || /^auto$/i.test(s)) return null;
    const m = s.match(QUALITY_RE) || s.match(/^(\d{3,4})$/);
    if (!m) return null;
    const q = m[1].endsWith('p') ? m[1].toLowerCase() : `${m[1]}p`;
    return { quality: q, source: 'provider-field', confidence: CONFIDENCE.CLAIMED };
}

// MANIFEST: the measured ladder. Always outranks the two above.
function fromManifest(probe) {
    if (!probe || !probe.ok) return null;
    if (!probe.levels || !probe.levels.length) return null;
    return {
        quality: probe.quality,
        levels: probe.levels,
        source: 'manifest',
        confidence: CONFIDENCE.MEASURED,
    };
}

module.exports = { CONFIDENCE, QUALITY_RE, fromReleaseName, fromField, fromManifest };
