// vidrock - vidrock.net's JSON api, keyed on TMDB id.
//
// Ported from the community Nuvio scraper D3adlyRocket/All-in-One-Nuvio
// vidrock.js (obfuscator.io output, deobfuscated 2026-11-20). What it does,
// all of it:
//   1. GET https://vidrock.net/api/movie/<tmdb> (tv: /api/tv/<id>/<s>/<e>) with
//      a desktop Chrome UA and Referer/Origin vidrock.net. The answer is an
//      object of named servers (Nova, Atlas, Astra, Orion, Luna, Lyra, Elara,
//      ...), each { url, language, flag, type }; an empty url = no source.
//   2. Each url is AES-256-GCM ciphertext, base64url: 12-byte IV, ciphertext,
//      16-byte tag. The scraper decrypts with a hand-written AES in CTR mode
//      (counter starts at 2, tag never checked) under a fixed key. Node's
//      aes-256-ctr with IV||00000002 is the same transform.
//   3. Fetches the decrypted master with the same headers and keeps it when it
//      has an #EXT-X-STREAM-INF variant; quality comes from the top variant.
// Left out on purpose:
//   - domains.json from raw.githubusercontent.com/sapariyaneel/nuvio-plugin: a
//     third party's file that would pick the api host at run time. The host is
//     fixed here (vidrock.net, the scraper's own fallback).
//   - two api.themoviedb.org calls that only fed the card text (title, year,
//     runtime). No stream data came from them.
//
// LANGUAGE. Each server entry states `language` (e.g. "English"); that is what
// the row claims. Audio renditions are read from the master, never guessed.

const { createDecipheriv } = require('crypto');
const hls = require('../lib/media/hlsManifest');

const API_BASE = 'https://vidrock.net';
const STREAM_KEY = Buffer.from('7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f', 'hex');
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/137.0.0.0 Safari/537.36',
    Referer: 'https://vidrock.net/',
    Origin: 'https://vidrock.net',
};
const API_TIMEOUT_MS = 10000;
const MASTER_TIMEOUT_MS = 8000;

// base64url ciphertext -> plaintext URL. Throws on input too short to hold
// IV + tag, as the scraper did.
function decryptStreamUrl(encoded) {
    const buf = Buffer.from(String(encoded).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length <= GCM_IV_LENGTH + GCM_TAG_LENGTH) throw new Error('ciphertext too short');
    const iv = Buffer.concat([buf.subarray(0, GCM_IV_LENGTH), Buffer.from([0, 0, 0, 2])]);
    const body = buf.subarray(GCM_IV_LENGTH, buf.length - GCM_TAG_LENGTH);
    const d = createDecipheriv('aes-256-ctr', STREAM_KEY, iv);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

// The scraper's qualityLabelFromResolution (width or height).
function tierOf(width, height) {
    const w = Number(width) || 0; const h = Number(height) || 0;
    if (w >= 3200 || h >= 2000) return '2160p';
    if (w >= 2400 || h >= 1400) return '1440p';
    if (w >= 1800 || h >= 1000) return '1080p';
    if (w >= 1200 || h >= 700) return '720p';
    if (w >= 800 || h >= 460) return '480p';
    if (w >= 600 || h >= 340) return '360p';
    return null;
}

// Pure: the row for one server entry whose master was fetched. Exported for tests.
function streamFromMaster(server, entry, url, masterText) {
    const levels = hls.parseLevels(masterText, url);
    if (!levels.length) return null;
    // The scraper took the highest-BANDWIDTH variant.
    const top = levels.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const quality = tierOf(top.width, top.height) || 'Auto';
    const audio = hls.parseMedia(masterText, url, 'AUDIO').map((m) => ({
        language: m.languageCode && !/^(und|unk|mul)$/i.test(m.languageCode) ? m.languageCode : (m.name || null),
        name: m.name || null, channels: m.channels || null, codec: null,
    }));
    const stated = String((entry && entry.language) || '').trim();
    const languages = [...new Set([stated, ...audio.map((a) => a.language)].filter(Boolean))];
    return {
        name: `VidRock | ${quality} | ${server}`,
        title: `VidRock · ${server}${stated ? ` · ${stated}` : ' · Original audio'}`,
        url,
        provider: 'vidrock',
        quality,
        container: 'hls',
        languages,
        audio,
        selectableAudio: audio.length > 0,
        levels: levels.map((l) => ({ height: l.height, quality: tierOf(l.width, l.height), bandwidth: l.bandwidth, codecs: l.codecs })),
        codecs: hls.masterCodecs(masterText),
        subtitles: [],
        headers: { ...HEADERS },
    };
}

async function getVidrockStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const id = parseInt(tmdbId, 10);
    if (!id) {
        console.log(`[vidrock] not a numeric TMDB id: ${tmdbId}`);
        return [];
    }
    console.log(`[vidrock] Fetching streams for TMDB ID: ${id}, Type: ${type}`);
    const path = type === 'tv' ? `tv/${id}/${seasonNum || 1}/${episodeNum || 1}` : `movie/${id}`;

    // Transport error / non-2xx: unknown, thrown so it is not cached as empty.
    const res = await fetch(`${API_BASE}/api/${path}`, { headers: HEADERS, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`vidrock: api HTTP ${res.status} for ${id}`);
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object' || body.error) {
        console.log(`[vidrock] api answered no servers for ${id}`);
        return [];
    }
    const entries = Object.keys(body)
        .map((name) => ({ name, entry: body[name] }))
        .filter((x) => x.entry && typeof x.entry === 'object' && x.entry.url);
    if (!entries.length) {
        console.log(`[vidrock] every server empty for ${id}`);
        return [];
    }

    const rows = await Promise.all(entries.map(async ({ name, entry }) => {
        let url;
        try {
            url = decryptStreamUrl(entry.url);
        } catch (e) {
            console.log(`[vidrock] ${name}: decrypt failed: ${e.message}`);
            return null;
        }
        if (!/^https?:\/\//i.test(url)) {
            console.log(`[vidrock] ${name}: decrypted value is not a URL, dropped`);
            return null;
        }
        try {
            const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(MASTER_TIMEOUT_MS) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const row = streamFromMaster(name, entry, url, await r.text());
            if (!row) console.log(`[vidrock] ${name}: master has no variants, dropped`);
            else console.log(`[vidrock] ${name}: ${row.quality} lang=${row.languages.join('/') || 'unstated'} audio=${row.audio.length}`);
            return row;
        } catch (e) {
            console.log(`[vidrock] ${name}: master unreadable, dropped: ${e.message}`);
            return null;
        }
    }));

    const seen = new Set();
    const out = rows.filter((r) => r && !seen.has(r.url) && seen.add(r.url));
    console.log(`[vidrock] Got ${out.length} stream(s) for ${id} from ${entries.length} server(s)`);
    return out;
}

module.exports = { getVidrockStreams, decryptStreamUrl, streamFromMaster, tierOf, HEADERS };
