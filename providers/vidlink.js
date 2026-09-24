const axios = require('axios');
const https = require('https');

const VIDLINK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Referer': 'https://vidlink.pro'
};

// vidlink.pro's certificate cannot be verified in this environment: the leaf
// is signed by a private "Fortinet Certificate Authority" (a network-level
// TLS-inspecting proxy/firewall), confirmed with
// `openssl s_client -connect vidlink.pro:443 -servername vidlink.pro`
// (issuer=O=Fortinet, OU=Certificate Authority). There is no real CA bundle
// missing here to add - the origin's actual cert is being substituted in
// transit by whatever network/device this process runs on. The correct fix
// is environment-level: trust that Fortinet root in the OS keychain, or run
// this process off that network. Until that is done, we fall back to
// rejectUnauthorized:false scoped ONLY to vidlink.pro via a dedicated Agent
// (never a global override). This is a deliberate workaround, not a
// security-neutral choice - it makes this provider blind to a genuine MITM
// from anyone else on the same network path. Acceptable here because the
// content fetched is public streaming metadata, not credentials.
// Set ALLOW_INSECURE_TLS=1 to opt into that bypass. It is OFF by default:
// disabling verification does NOT unblock these hosts (the FortiGuard 403
// arrives after the handshake), so the only thing it would buy is a blind
// spot. Measured: `curl -sk https://a.111477.xyz/movies/` returns a 29808-byte
// FortiGuard "Web Filter Violation" page, not the directory.
const insecureAgent = process.env.ALLOW_INSECURE_TLS === '1'
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

function qualityToNumber(quality) {
    if (quality === '4k') return 2160;
    if (quality === 'Auto' || quality === 'unknown') return 0;
    const parsed = parseInt(quality, 10);
    return isNaN(parsed) ? 0 : parsed;
}

function canonicalQualityKey(quality) {
    if (quality === '4k') return '2160p';
    if (quality === 'Auto' || quality === 'unknown') return 'Auto';
    return `${quality}p`;
}

// Vidlink's API sometimes tags a quality entry with a captions/audio array;
// parse only what is explicitly stated, never guess.
function extractLanguages(entry) {
    const raw = entry && (entry.languages || entry.lang || entry.language);
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(/[\/,|]/);
    return list.map(s => String(s).trim()).filter(Boolean);
}

function extractAudioTracks(entry) {
    const tracks = entry && (entry.audio || entry.audioTracks);
    if (!Array.isArray(tracks)) return [];
    return tracks.map(t => ({
        language: (t && (t.language || t.lang)) || null,
        codec: (t && t.codec) || null,
        channels: (t && Number(t.channels)) || null,
    }));
}

function inferContainer(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('.m3u8')) return 'hls';
    if (u.includes('.mkv')) return 'mkv';
    if (u.includes('.mp4')) return 'mp4';
    return null;
}

async function getVidlinkStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[Vidlink] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    try {
        // Step 1: Encrypt the TMDB ID via enc-dec.app
        const encRes = await axios.get(
            `https://enc-dec.app/api/enc-vidlink?text=${encodeURIComponent(String(tmdbId))}`,
            { timeout: 8000 }
        );
        const encodedTmdb = encRes.data && encRes.data.result;
        if (!encodedTmdb) {
            console.log('[Vidlink] Encryption step returned no result.');
            return [];
        }

        // Step 2: Fetch file-quality streams from Vidlink API
        const apiUrl = mediaType === 'tv'
            ? `https://vidlink.pro/api/b/tv/${encodedTmdb}/${seasonNum}/${episodeNum}?multiLang=0`
            : `https://vidlink.pro/api/b/movie/${encodedTmdb}?multiLang=0`;

        let apiRes;
        try {
            apiRes = await axios.get(apiUrl, { headers: VIDLINK_HEADERS, timeout: 8000, httpsAgent: insecureAgent });
        } catch (err) {
            const status = err.response && err.response.status;
            if (status) {
                console.error(`[Vidlink] API request refused with HTTP ${status} (not "no streams" - likely a network-level block, e.g. a web-filter page instead of JSON)`);
            } else {
                const reason = err.code || err.message || 'unknown error';
                console.error(`[Vidlink] API request failed before an HTTP response (TLS/network error): ${reason}`);
            }
            return [];
        }

        const streamData = apiRes.data && apiRes.data.stream;
        if (!streamData || !streamData.qualities) {
            console.log('[Vidlink] No quality streams in response.');
            return [];
        }

        const streams = Object.entries(streamData.qualities)
            .filter(([, entry]) => entry && entry.url)
            .sort((a, b) => qualityToNumber(b[0]) - qualityToNumber(a[0]))
            .map(([qualityKey, entry]) => {
                const languages = extractLanguages(entry);
                const audio = extractAudioTracks(entry);
                return {
                    name: 'Vidlink',
                    title: `Vidlink - ${canonicalQualityKey(qualityKey) === 'Auto' ? 'Auto' : canonicalQualityKey(qualityKey)}`,
                    url: entry.url,
                    quality: canonicalQualityKey(qualityKey),
                    provider: 'Vidlink',
                    languages, // [] when Vidlink does not state a language - never guessed
                    audio,
                    subtitles: [],
                    size: entry.size || null,
                    container: entry.container || inferContainer(entry.url),
                    selectableAudio: audio.length > 1,
                    headers: { 'Referer': 'https://vidlink.pro' }
                };
            });

        if (streams.length === 0) {
            console.log('[Vidlink] No usable stream URLs in response.');
            return [];
        }

        console.log(`[Vidlink] Got ${streams.length} stream(s).`);
        return streams;
    } catch (err) {
        console.error(`[Vidlink] Error: ${err.message}`);
        return [];
    }
}

module.exports = { getVidlinkStreams };
