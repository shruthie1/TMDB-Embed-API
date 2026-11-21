'use strict';

// Resolve one stream's TRUE playback capabilities.
//
// This is the single place where provider differences are reconciled. Callers
// pass a normalised stream; they get back what the player can actually offer,
// with every value carrying where it came from and how much to trust it.
//
// The rule is simple and uniform: highest confidence wins, ties go to the
// earlier (more specific) source. No provider names appear anywhere below -
// adding a provider means describing what IT states, never editing this file.

const { probeStream } = require('./probe');
const src = require('./capabilitySources');
const { canonicalLanguage } = require('../../utils/streamSchema');

function pickBest(candidates) {
    return candidates
        .filter(Boolean)
        .sort((a, b) => b.confidence - a.confidence)[0] || null;
}

// Audio from the HLS master's #EXT-X-MEDIA renditions - switchable without a
// reload, which is what a UI audio menu needs.
function audioFromManifest(probe) {
    if (!probe || !probe.ok || !probe.audio || !probe.audio.length) return [];
    return probe.audio.map((a, i) => ({
        id: String(i),
        language: canonicalLanguage(a.languageCode) || canonicalLanguage(a.name) || a.name || `Audio ${i + 1}`,
        languageCode: a.languageCode || null,
        name: a.name || null,
        uri: a.url || null,
        channels: a.channels || null,
        default: Boolean(a.isDefault),
        switchable: true,
        source: 'manifest',
        confidence: src.CONFIDENCE.MEASURED,
    }));
}

// Audio the provider declared structurally. Not switchable on its own - it
// describes the file, and acting on it means loading a different URL.
function audioFromProvider(stream) {
    const list = Array.isArray(stream.audio) ? stream.audio : [];
    return list.map((a, i) => ({
        id: String(i),
        language: canonicalLanguage(a.language) || a.language || `Audio ${i + 1}`,
        languageCode: null,
        channels: a.channels || null,
        default: i === 0,
        switchable: false,
        source: 'provider-field',
        confidence: src.CONFIDENCE.CLAIMED,
    }));
}

// Languages the provider only spelled into a label. Weakest signal: it names
// what exists somewhere in the file, not tracks a player can select.
function audioFromLabels(stream) {
    const langs = Array.isArray(stream.languages) ? stream.languages : [];
    return langs.map((l, i) => ({
        id: String(i),
        language: canonicalLanguage(l) || l,
        languageCode: null,
        channels: null,
        default: i === 0,
        switchable: false,
        source: 'label',
        confidence: src.CONFIDENCE.GUESS,
    }));
}

/**
 * @param {object} stream  a stream already through normaliseStream()
 * @param {object} [opts]  { probe: false } to skip the network call
 * @returns {Promise<object>} capability descriptor - see FIELDS below
 *
 * FIELDS
 *   quality        string   best available tier, e.g. "1080p"
 *   qualitySource  string   'manifest' | 'provider-field' | 'release-name'
 *   qualityTrusted bool     true only when measured from the manifest
 *   levels         array    [{quality,height,width,bandwidth,codecs,url}] best first
 *   audio          array    [{id,language,switchable,default,...}]
 *   selectableAudio bool    true when audio can be switched without reloading
 *   subtitles      array
 *   durationSeconds number|null
 *   kind           'master'|'media'|'progressive'|null
 *   probeError     string|null
 */
async function resolveCapabilities(stream, opts = {}) {
    const wantProbe = opts.probe !== false;
    const probe = wantProbe
        ? await probeStream(stream.url, stream.headers, { quality: stream.quality })
        : null;

    const quality = pickBest([
        src.fromManifest(probe),
        src.fromField(stream.quality),
        src.fromReleaseName(stream.title || stream.name),
    ]);

    // Audio: take the highest-confidence NON-EMPTY source rather than merging
    // them. Mixing a measured rendition list with a label-derived one produces
    // duplicate entries that differ only in trustworthiness, which is exactly
    // the "same Default five times" problem the old UI hit.
    const audio = [audioFromManifest(probe), audioFromProvider(stream), audioFromLabels(stream)]
        .find((list) => list.length) || [];

    const levels = (quality && quality.levels) || [];

    return {
        url: stream.url,
        provider: stream.provider,
        kind: probe ? probe.kind : null,

        quality: (quality && quality.quality) || stream.quality || null,
        qualitySource: (quality && quality.source) || null,
        qualityTrusted: Boolean(quality && quality.confidence === src.CONFIDENCE.MEASURED),
        levels,

        audio,
        audioSource: audio.length ? audio[0].source : null,
        // Only a manifest rendition set is switchable in-player. A provider's
        // audio[] describes the file; picking one means loading another URL.
        selectableAudio: audio.some((a) => a.switchable),

        subtitles: (probe && probe.subtitles) || stream.subtitles || [],
        durationSeconds: (probe && probe.durationSeconds) || null,
        probeError: (probe && probe.error) || null,
    };
}

async function resolveMany(streams, opts = {}) {
    return Promise.all((streams || []).map((s) => resolveCapabilities(s, opts)));
}

module.exports = { resolveCapabilities, resolveMany, CONFIDENCE: src.CONFIDENCE };
