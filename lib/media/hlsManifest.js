'use strict';

// HLS manifest parsing.
//
// Pure functions over playlist text: no network, no cache, no provider
// knowledge. The network-facing probe that uses these lives in
// lib/media/probe.js, which keeps this file trivially testable.
//
// Why this exists: `quality` used to be a scalar the provider guessed, and
// providers guessed badly. Measured 2026-09-21 across 30 live streams, 7
// carried multiple quality levels and 6 of those misreported it - VaPlayer
// claimed "1080p" on a ladder topping out at 804px because it read the
// release FILENAME (providers/vaplayer.js:109), while NetMirror said "Auto"
// while genuinely serving 1080p/720p/480p. A stream is a ladder, not a
// number, and the only honest source is the manifest itself.

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;

// Parse an #EXT-X-... attribute list into a plain object. Quoted values are
// unquoted; everything else is returned verbatim as a string.
function parseAttributes(line) {
    const attrs = {};
    const body = line.slice(line.indexOf(':') + 1);
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(body)) !== null) {
        const value = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
        attrs[m[1]] = value;
    }
    return attrs;
}

function isMaster(text) {
    return /^#EXT-X-STREAM-INF:/m.test(String(text || ''));
}

function isMedia(text) {
    const s = String(text || '');
    return /^#EXTINF:/m.test(s) && !isMaster(s);
}

// Map a pixel height to the nearest conventional tier. Real ladders are rarely
// exactly 1080/720: measured heights included 804, 808, 800, 536, 268, which
// are letterboxed encodes of 1080p/720p/360p sources. Snapping to the nearest
// standard tier is what a viewer expects to see in a quality menu.
const TIERS = [2160, 1440, 1080, 720, 480, 360, 240];

function heightToTier(height) {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return null;
    let best = TIERS[0];
    for (const t of TIERS) {
        if (Math.abs(t - h) < Math.abs(best - h)) best = t;
    }
    return `${best}p`;
}

function resolveUri(uri, baseUrl) {
    if (!uri) return null;
    try {
        return new URL(uri, baseUrl).toString();
    } catch {
        return uri;
    }
}

// Variant streams: one entry per #EXT-X-STREAM-INF and its following URI line.
function parseLevels(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    const levels = [];
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
        const attrs = parseAttributes(line);
        // The URI is the next non-blank, non-comment line.
        let uri = null;
        for (let j = i + 1; j < lines.length; j += 1) {
            const next = lines[j].trim();
            if (!next || next.startsWith('#')) continue;
            uri = next;
            break;
        }
        const res = String(attrs.RESOLUTION || '');
        const [w, h] = res.includes('x') ? res.split('x').map(Number) : [null, null];
        levels.push({
            url: resolveUri(uri, baseUrl),
            width: Number.isFinite(w) ? w : null,
            height: Number.isFinite(h) ? h : null,
            quality: heightToTier(h),
            bandwidth: Number(attrs.BANDWIDTH) || null,
            codecs: attrs.CODECS || null,
            frameRate: Number(attrs['FRAME-RATE']) || null,
            audioGroup: attrs.AUDIO || null,
        });
    }
    // Best first: a UI listing qualities wants descending, and "best available"
    // is levels[0] rather than a search.
    return levels.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
}

// #EXT-X-MEDIA renditions of a given TYPE (AUDIO or SUBTITLES).
function parseMedia(text, baseUrl, type) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith('#EXT-X-MEDIA:')) continue;
        const a = parseAttributes(line);
        if (a.TYPE !== type) continue;
        out.push({
            url: resolveUri(a.URI, baseUrl),
            groupId: a['GROUP-ID'] || null,
            name: a.NAME || null,
            languageCode: a.LANGUAGE || null,
            isDefault: a.DEFAULT === 'YES',
            autoselect: a.AUTOSELECT === 'YES',
            forced: a.FORCED === 'YES',
            channels: a.CHANNELS ? Number(String(a.CHANNELS).split('/')[0]) : null,
        });
    }
    return out;
}

// Total duration of a media playlist, in seconds. 0 for a master (no EXTINF),
// which is how a caller distinguishes "not measured" from "measured as short".
function parseDuration(text) {
    let total = 0;
    const re = /#EXTINF:([\d.]+)/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) total += parseFloat(m[1]) || 0;
    return total;
}

function parseSegmentCount(text) {
    return String(text || '')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
}

module.exports = {
    parseAttributes, isMaster, isMedia, heightToTier, resolveUri,
    parseLevels, parseMedia, parseDuration, parseSegmentCount, TIERS,
};
