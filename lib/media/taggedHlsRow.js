'use strict';
// One HLS row from a master whose ONLY language source is its own
// #EXT-X-MEDIA:TYPE=AUDIO LANGUAGE tags. Used by insertunit and vidout
// (MultiMovies servers, 2026-11-24). Never a page label, never the TMDB
// original language: an untagged rendition stays unknown (CLAUDE.md #1).
//
// Also the runtime gate both use: the row's first variant against the TMDB
// runtime with the client's rule (canary runtimeVerdict, android
// PlayPolicy RUNTIME_MIN_RATIO 0.82). A wrong cut is dropped; an unreadable
// duration or unknown runtime keeps the row.

const http = require('http');
const https = require('https');
const nodeFetch = require('node-fetch');
const hls = require('./hlsManifest');
const { canonicalLanguage } = require('../../utils/streamSchema');
const { lookupWithFallback } = require('../../utils/dnsFallback');

const agents = {
    http: new http.Agent({ keepAlive: true, lookup: lookupWithFallback }),
    https: new https.Agent({ keepAlive: true, lookup: lookupWithFallback }),
};

/** GET -> { status, text }. Uses the DNS-fallback agents (VM1 DNAME hosts). */
async function fetchText(url, headers, timeoutMs) {
    const r = await nodeFetch(url, {
        headers,
        agent: (u) => (u.protocol === 'http:' ? agents.http : agents.https),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
    });
    return { status: r.status, text: await r.text() };
}

// Tier from height; width lifts a letterboxed encode, never above 1080p
// (same rule as providers/vidrift.js tierOf).
function tierOf(level) {
    const w = Number(level && level.width) || 0;
    const h = Number(level && level.height) || 0;
    const byH = h >= 2000 ? 2160 : h >= 1400 ? 1440 : h >= 1000 ? 1080 : h >= 700 ? 720 : h >= 460 ? 480 : h > 0 ? 360 : 0;
    const byW = w >= 1800 ? 1080 : w >= 1200 ? 720 : w >= 800 ? 480 : w > 0 ? 360 : 0;
    const t = Math.max(byH, byW);
    return t ? `${t}p` : null;
}

/**
 * Pure. { provider, display } name the row; headers go on every request.
 * Returns null when the master has no variants.
 */
function rowFromMaster(masterText, masterUrl, { provider, display, headers }) {
    const levels = hls.parseLevels(masterText, masterUrl);
    if (!levels.length) return null;
    // The best variant's audio group only: insertunit repeats every rendition
    // in a failover group, which would double the Audio menu.
    const group = levels[0].audioGroup;
    const renditions = hls.parseMedia(masterText, masterUrl, 'AUDIO')
        .filter((m) => !group || !m.groupId || m.groupId === group);
    const audio = renditions.map((m) => ({
        tagged: true,
        language: canonicalLanguage(m.languageCode) || null,
        languageCode: m.languageCode || null,
        name: m.name || null,
        channels: m.channels || null,
        codec: null,
        default: m.isDefault,
    }));
    const languages = [...new Set(audio.map((a) => a.language).filter(Boolean))];
    const quality = tierOf(levels[0]) || 'Auto';
    // No language word in name/title when untagged: normaliseStream would
    // read one back from the label.
    const label = languages.length ? languages.join('/') : 'Unknown';
    return {
        name: `${display} | ${quality}`,
        title: `${display} · ${label}`,
        url: masterUrl,
        provider,
        quality,
        container: 'hls',
        audioTagsOnly: true,
        languages,
        audio,
        selectableAudio: audio.some((a) => a.language),
        levels: levels.map((l) => ({ height: l.height, quality: tierOf(l), bandwidth: l.bandwidth, codecs: l.codecs })),
        codecs: hls.masterCodecs(masterText),
        videoCodec: hls.videoCodecFamily(hls.masterCodecs(masterText)) || null,
        subtitles: [],
        headers: { ...headers },
    };
}

/**
 * 'ok' | 'mismatch' | 'unknown' for a fetched master, reading its smallest
 * variant (1 GET). `get(url)` -> { status, text }.
 */
async function runtimeCheck(masterText, masterUrl, runtimeMin, get) {
    const { runtimeVerdict } = require('../selfheal/canary');
    if (!(Number(runtimeMin) > 0)) return { verdict: 'unknown', seconds: null };
    const levels = hls.parseLevels(masterText, masterUrl);
    const smallest = levels[levels.length - 1];
    if (!smallest || !smallest.url) return { verdict: 'unknown', seconds: null };
    try {
        const r = await get(smallest.url);
        if (!(r.status >= 200 && r.status < 300)) return { verdict: 'unknown', seconds: null };
        const seconds = hls.parseDuration(r.text);
        return { verdict: runtimeVerdict(seconds, runtimeMin), seconds };
    } catch {
        return { verdict: 'unknown', seconds: null };
    }
}

module.exports = { rowFromMaster, runtimeCheck, fetchText, tierOf, _agents: agents };
