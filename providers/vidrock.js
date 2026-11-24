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
//      Unlike the scraper, a media playlist (#EXTINF, no variants) is kept
//      too, as one Auto row (streamFromMaster).
// Left out on purpose:
//   - domains.json from raw.githubusercontent.com/sapariyaneel/nuvio-plugin: a
//     third party's file that would pick the api host at run time. The host is
//     fixed here (vidrock.net, the scraper's own fallback).
//   - two api.themoviedb.org calls that only fed the card text (title, year,
//     runtime). No stream data came from them.
//
// LANGUAGE. Each server entry states `language` (e.g. "English"), but that is
// a hint, not a fact: Radhe Shyam 673392's Nova said English over a Hindi
// track (2026-11-20). The row claims the stated language only when one of the
// master's AUDIO renditions confirms it. Otherwise it claims only what the
// renditions say (often nothing = unlabelled), and keeps the hint on
// `statedLanguage`. A first-segment probe cannot confirm it either: Nova's TS
// segments carry no language tag (ffprobe on 27205, 2026-11-20).
//
// MASTER 403. vercetti.org answers a sporadic 403 on the same master URL
// regardless of its age (1 of 10 fetches at 3s spacing; the URL is identical
// across resolves minutes apart), so a 403 at resolve gets one retry.

const { createDecipheriv } = require('crypto');
const hls = require('../lib/media/hlsManifest');
const { canonicalLanguage } = require('../utils/streamSchema');

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
// Today's values; routes/resolve-config.json carries the same (provider
// self-heal Task 3).
const CONFIG_DEFAULTS = { bases: [API_BASE], key: STREAM_KEY.toString('hex') };
const upstream = require('../utils/upstreamBase');
const selfheal = require('../lib/selfheal/config');
// Read per call: a remote config edit or a heal applies without a restart.
const vidrockSeed = () => selfheal.cfg('vidrock', 'bases', CONFIG_DEFAULTS.bases)[0].replace(/\/+$/, '');
// verifyTitle: RRR 579974. vidrock answered 0 rows for Inception and 1 HLS
// row for RRR (laptop, 2026-11-21). The title is proven by the HLS duration
// (lib/selfheal/proof.js), vidrock's API carries no title.
const UPSTREAM = { name: 'vidrock', get seed() { return vidrockSeed(); }, verifyTitle: { tmdbId: '579974', mediaType: 'movie' } };
function apiBase() { return upstream.getBase('vidrock', vidrockSeed()); }
function headers() {
    const b = apiBase();
    return { ...HEADERS, Referer: `${b}/`, Origin: b };
}
function streamKey() {
    // A key under test in a heal run (lib/selfheal/keys.js withTrial) first.
    const hex = require('../lib/selfheal/keys').trial('vidrock', 'key') || selfheal.cfg('vidrock', 'key', CONFIG_DEFAULTS.key);
    return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : STREAM_KEY;
}
const API_TIMEOUT_MS = 10000;
const MASTER_TIMEOUT_MS = 8000;
const MASTER_RETRY_DELAY_MS = 500;

// base64url ciphertext -> plaintext URL. AES-256-GCM with the tag checked
// (self-heal Task 6): a wrong key throws "unable to authenticate data", which
// the classifier calls `key`, where CTR (no tag) gave garbage that was
// dropped as "not a URL". GCM with a 12-byte IV runs CTR from counter 2, so
// the plaintext is the same as the scraper's (the recorded Nova url in
// test/vidrock.test.js passes the tag). Throws on input too short for IV + tag.
function decryptStreamUrl(encoded) {
    const buf = Buffer.from(String(encoded).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length <= GCM_IV_LENGTH + GCM_TAG_LENGTH) throw new Error('ciphertext too short');
    const d = createDecipheriv('aes-256-gcm', streamKey(), buf.subarray(0, GCM_IV_LENGTH));
    d.setAuthTag(buf.subarray(buf.length - GCM_TAG_LENGTH));
    const body = buf.subarray(GCM_IV_LENGTH, buf.length - GCM_TAG_LENGTH);
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
// A media playlist (#EXTINF segments, no #EXT-X-STREAM-INF) is playable on its
// own and becomes a single-variant row with quality Auto. The scraper dropped
// it; VM logs 2026-11-20..24 showed 6 of 8 servers dropped as "no variants".
// Anything else (HTML error page, empty body) is still no row.
function streamFromMaster(server, entry, url, masterText) {
    const levels = hls.parseLevels(masterText, url);
    const single = !levels.length && hls.isMedia(masterText);
    if (!levels.length && !single) return null;
    // The scraper took the highest-BANDWIDTH variant.
    const top = single ? {} : levels.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const quality = tierOf(top.width, top.height) || 'Auto';
    const audio = hls.parseMedia(masterText, url, 'AUDIO').map((m) => ({
        language: m.languageCode && !/^(und|unk|mul)$/i.test(m.languageCode) ? m.languageCode : (m.name || null),
        name: m.name || null, channels: m.channels || null, codec: null,
    }));
    const stated = String((entry && entry.language) || '').trim();
    const rendition = audio.map((a) => a.language).filter(Boolean);
    const confirmed = Boolean(stated) && audio.some((a) => [a.language, a.name]
        .some((v) => v && canonicalLanguage(v) === canonicalLanguage(stated)));
    const languages = [...new Set([...(confirmed ? [stated] : []), ...rendition])];
    return {
        name: `VidRock | ${quality} | ${server}`,
        // No language word here: normaliseStream reads one from the title
        // when `languages` is empty, which would restore the unconfirmed hint.
        title: `VidRock · ${server}${confirmed ? ` · ${stated}` : ''}`,
        url,
        provider: 'vidrock',
        quality,
        container: 'hls',
        languages,
        statedLanguage: stated || null,
        audio,
        selectableAudio: audio.length > 0,
        levels: levels.map((l) => ({ height: l.height, quality: tierOf(l.width, l.height), bandwidth: l.bandwidth, codecs: l.codecs })),
        codecs: hls.masterCodecs(masterText),
        subtitles: [],
        headers: headers(),
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
    const res = await fetch(`${apiBase()}/api/${path}`, { headers: headers(), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
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

    // Every entry failing the GCM tag means the key is wrong, not "no
    // streams": thrown, so the registry's key heal can see it (Task 6).
    let decryptFails = 0; let lastDecryptErr = '';
    const rows = await Promise.all(entries.map(async ({ name, entry }) => {
        let url;
        try {
            url = decryptStreamUrl(entry.url);
        } catch (e) {
            console.log(`[vidrock] ${name}: decrypt failed: ${e.message}`);
            decryptFails++; lastDecryptErr = e.message;
            return null;
        }
        if (!/^https?:\/\//i.test(url)) {
            console.log(`[vidrock] ${name}: decrypted value is not a URL, dropped`);
            return null;
        }
        try {
            const get = () => fetch(url, { headers: headers(), signal: AbortSignal.timeout(MASTER_TIMEOUT_MS) });
            let r = await get();
            if (r.status === 403) {
                console.log(`[vidrock] ${name}: master 403, retry once`);
                await new Promise((res) => setTimeout(res, MASTER_RETRY_DELAY_MS));
                r = await get();
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const text = await r.text();
            const row = streamFromMaster(name, entry, url, text);
            if (!row) {
                const kind = /^\s*</.test(text) ? 'html' : (!text.trim() ? 'empty' : (/^#EXTM3U/.test(text.trim()) ? 'playlist-no-segments' : 'other'));
                console.log(`[vidrock] ${name}: master not playable (${kind}, ${text.length}b), dropped`);
            } else console.log(`[vidrock] ${name}: ${row.quality}${row.levels.length ? '' : ' single-variant'} lang=${row.languages.join('/') || 'und'} stated=${row.statedLanguage || '-'} audio=${row.audio.length}`);
            return row;
        } catch (e) {
            console.log(`[vidrock] ${name}: master unreadable, dropped: ${e.message}`);
            return null;
        }
    }));

    if (decryptFails === entries.length) {
        throw new Error(`vidrock: decrypt failed on all ${entries.length} server(s) for ${id}: ${lastDecryptErr}`);
    }
    const seen = new Set();
    const out = rows.filter((r) => r && !seen.has(r.url) && seen.add(r.url));
    console.log(`[vidrock] Got ${out.length} stream(s) for ${id} from ${entries.length} server(s)`);
    return out;
}

// Task 6: what the key heal run needs from vidrock. One API GET for a fresh
// ciphertext, then lib/selfheal/keys.js reads the page and its bundle (2 GETs).
// The registry adds the verify (own resolve + title proof) and the trigger.
function keyHeal(fetchFn) {
    const keys = require('../lib/selfheal/keys');
    return {
        current: () => ({ key: streamKey().toString('hex') }),
        extract: async () => {
            const r = await fetchFn(`${apiBase()}/api/movie/${UPSTREAM.verifyTitle.tmdbId}`, { headers: headers(), signal: AbortSignal.timeout(API_TIMEOUT_MS) });
            if (!r || !r.ok) throw new Error(`api HTTP ${r && r.status}`);
            const body = await r.json().catch(() => null);
            const sample = Object.values(body || {}).map((e) => e && typeof e === 'object' && e.url).find(Boolean);
            if (!sample) { console.warn('[heal] vidrock key none: no ciphertext in the api answer'); return null; }
            return keys.extractVidrockKey({ fetch: fetchFn, base: apiBase(), sample, headers: headers() });
        },
    };
}

module.exports = { getVidrockStreams, decryptStreamUrl, streamFromMaster, tierOf, HEADERS, CONFIG_DEFAULTS, UPSTREAM, _internal: { apiBase, headers, streamKey }, keyHeal };
