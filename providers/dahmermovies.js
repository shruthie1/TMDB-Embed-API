const axios = require('axios');
const https = require('https');
const { getTmdbApiKey } = require('../utils/tmdbKey');
const { deaccent } = require('../utils/titleMatch');

const DAHMER_MOVIES_API = 'https://a.111477.xyz';
const DAHMER_WORKER_API = 'https://p.111477.xyz/bulk?u=';

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `${DAHMER_MOVIES_API}/`
};

// a.111477.xyz's certificate chain cannot be verified in this environment:
// the leaf is signed by a private "Fortinet Certificate Authority" (a
// network-level TLS-inspecting proxy/firewall), not by any CA in the system
// trust store. `openssl s_client -connect a.111477.xyz:443` shows
// issuer=O=Fortinet, OU=Certificate Authority — there is no legitimate CA
// bundle to add here; the real cert is being substituted in transit by
// whatever network/device this process runs on. The correct fix is
// environment-level (trust that Fortinet root in the OS keychain, or run off
// that network), not a code fix. Until then we fall back to
// rejectUnauthorized:false, scoped ONLY to this host via a dedicated Agent
// (never a global override). This is a deliberate, narrow workaround, not a
// security-neutral choice: it makes this provider blind to a genuine
// man-in-the-middle from anyone else sitting on the same network path. The
// content fetched is public streaming metadata, not credentials, which is
// why this tradeoff is acceptable here specifically.
// Set ALLOW_INSECURE_TLS=1 to opt into that bypass. It is OFF by default:
// disabling verification does NOT unblock these hosts (the FortiGuard 403
// arrives after the handshake), so the only thing it would buy is a blind
// spot. Measured: `curl -sk https://a.111477.xyz/movies/` returns a 29808-byte
// FortiGuard "Web Filter Violation" page, not the directory.
const insecureAgent = process.env.ALLOW_INSECURE_TLS === '1'
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

function parseLinks(html) {
    const links = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        const rowContent = match[1];
        const linkMatch = rowContent.match(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/i);
        const sizeMatch = rowContent.match(/<td[^>]*>(\d+(?:\.\d+)?\s?[KMGT]B)<\/td>/i);
        if (linkMatch) {
            const href = linkMatch[1];
            const text = linkMatch[2].trim();
            const size = sizeMatch ? sizeMatch[1].trim() : null;
            if (text && href !== '../' && /\.(mkv|mp4|avi|webm|m3u8)$/i.test(text)) {
                links.push({ text, href, size });
            }
        }
    }
    return links;
}

// Deaccent before the title becomes a URL PATH. encodeURIComponent turns a
// macron into %C4%81, so "Bahubali" (a-macron) requested
// /movies/B%C4%81hubali.../ - a directory that does not exist upstream, which
// reads downstream as "this provider has no copy". Same diacritics defect that
// made castletv.js serve a different film (2026-09-21); here it produces a
// silent miss rather than a wrong match.
// UNVERIFIED against the live host: a.111477.xyz is blocked by FortiGuard on
// this network (the 403 is a web-filter page, not the origin), so both the
// accented and deaccented paths are untestable from here. The accented variant
// is tried FIRST so this can only add a candidate, never remove a working one.

async function fetchDirectory(title, year, season) {
    const cleanTitle = title.replace(/:/g, '');
    // Plain-alphabet spelling of the same title: "Bahubali" with a macron
    // becomes "Bahubali". Only add it when it actually differs, so an ASCII
    // title does not fetch the same directory twice.
    const plainTitle = deaccent(cleanTitle);
    const titles = plainTitle !== cleanTitle ? [cleanTitle, plainTitle] : [cleanTitle];
    const variants = season !== null
        ? titles.flatMap((t) => [
            `/tvs/${encodeURIComponent(t)}/Season%20${season < 10 ? '0' + season : season}/`,
            `/tvs/${encodeURIComponent(t)}/Season%20${season}/`
        ])
        : titles.map((t) => `/movies/${encodeURIComponent(`${t} (${year})`)}/`);

    let lastError = null;
    for (const variant of variants) {
        try {
            const res = await axios.get(DAHMER_MOVIES_API + variant, {
                headers: REQUEST_HEADERS,
                timeout: 10000,
                responseType: 'text',
                httpsAgent: insecureAgent
            });
            if (res.data) return { html: res.data, dirUrl: DAHMER_MOVIES_API + variant };
        } catch (err) {
            // Distinguish three cases that a bare `catch {}` used to collapse
            // into one silent "not found":
            //   404            -> this path genuinely doesn't exist, try next variant
            //   other HTTP code -> the request reached the server but was refused
            //                      (seen in practice: 403 from a network-level
            //                      FortiGuard web-filter block page, not the origin)
            //   no response    -> TLS/connection/timeout failure before any HTTP reply
            const status = err.response && err.response.status;
            if (status === 404) {
                lastError = null; // genuine "not found" for this variant
                continue;
            }
            lastError = err;
            if (status) {
                console.error(`[DahmerMovies] Request to ${variant} was refused with HTTP ${status} (not a 404 - likely a network-level block, not "no directory")`);
            } else {
                const reason = err.code || err.message || 'unknown error';
                console.error(`[DahmerMovies] Request to ${variant} failed before an HTTP response (TLS/network error): ${reason}`);
            }
        }
    }
    if (lastError) {
        const status = lastError.response && lastError.response.status;
        console.error(`[DahmerMovies] Directory lookup aborted by ${status ? `HTTP ${status}` : (lastError.code || lastError.message)} - NOT evidence the directory is missing.`);
    }
    return null;
}

// Parse what the release filename genuinely states. Never guess a language
// from "DUAL"/"Multi" - that only tells us the file has more than one audio
// track, not which languages they are.
function parseReleaseInfo(fileName) {
    const quality = (fileName.match(/\b(2160p|1080p|720p|480p|360p)\b/i) || [])[1];
    const isMulti = /\b(multi|dual|multi-audio)\b/i.test(fileName);

    // Only trust an explicit, named language tag. "HIN"/"TEL"/etc alone next
    // to "DUAL" does tell us a real language, so pull those out; but bare
    // "DUAL"/"Multi" with no named language contributes nothing to `languages`.
    const langTags = fileName.match(/\b(Hindi|Tamil|Telugu|Malayalam|Kannada|English|Bengali|Marathi|Punjabi|Urdu|HIN|TAM|TEL|MAL|KAN|ENG)\b/gi) || [];
    const languages = [...new Set(langTags.map(t => t.toLowerCase()))];

    const containerMatch = fileName.match(/\.(mkv|mp4|m3u8|avi|webm)$/i);
    const container = containerMatch ? containerMatch[1].toLowerCase() : null;

    // Audio codec/channel hints from common scene-release tokens, e.g.
    // "DDP5.1", "AAC2.0", "AC3 5.1", "DD5.1".
    const audioMatch = fileName.match(/\b(DDP|DD|AC3|EAC3|AAC|DTS|TrueHD)\s?\.?(\d(?:\.\d)?)\b/i);
    const codec = audioMatch ? audioMatch[1].toUpperCase() : null;
    const channels = audioMatch ? parseFloat(audioMatch[2]) : null;

    return { quality, isMulti, languages, container, codec, channels };
}

async function getDahmermoviesStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[DahmerMovies] Searching for ${mediaType} ${tmdbId}`);

    const tmdbKey = getTmdbApiKey();
    if (!tmdbKey) {
        console.error('[DahmerMovies] No TMDB API key configured.');
        return [];
    }

    let title, year;
    try {
        const type = mediaType === 'tv' ? 'tv' : 'movie';
        const { data } = await axios.get(
            `https://api.tmdb.org/3/${type}/${tmdbId}?api_key=${tmdbKey}`,
            { timeout: 8000 }
        );
        title = data.title || data.name || '';
        year = (data.release_date || data.first_air_date || '').substring(0, 4);
    } catch (err) {
        console.error(`[DahmerMovies] TMDB lookup failed: ${err.message}`);
        return [];
    }

    if (!title) return [];

    const dir = await fetchDirectory(title, year, seasonNum);
    if (!dir) {
        console.log(`[DahmerMovies] No directory found for "${title}" (see prior log line for whether that was a 404 or a network/TLS failure)`);
        return [];
    }

    let paths = parseLinks(dir.html);

    // For TV, filter to the specific episode when possible
    if (seasonNum !== null && episodeNum !== null) {
        const epStr = String(episodeNum).padStart(2, '0');
        const seStr = String(seasonNum).padStart(2, '0');
        const epFiltered = paths.filter(p => {
            const name = p.text.toLowerCase();
            return name.includes(`s${seStr}e${epStr}`) || name.includes(`e${epStr}`);
        });
        if (epFiltered.length > 0) paths = epFiltered;
    }

    // Sort 4K first
    paths.sort((a, b) => (/2160p|4k/i.test(b.text) ? 1 : 0) - (/2160p|4k/i.test(a.text) ? 1 : 0));

    const streams = [];
    for (const path of paths.slice(0, 5)) {
        let directUrl;
        if (path.href.startsWith('http')) {
            directUrl = path.href;
        } else if (path.href.includes('/movies/') || path.href.includes('/tvs/')) {
            directUrl = DAHMER_MOVIES_API + (path.href.startsWith('/') ? '' : '/') + path.href;
        } else {
            directUrl = dir.dirUrl + path.href;
        }
        directUrl = decodeURI(directUrl.replace(/([^:]\/)\/+/g, '$1'));

        const fileName = path.text;
        const info = parseReleaseInfo(fileName);

        const cleanInfo = fileName
            .replace(/\.(mkv|mp4|avi|webm|m3u8)$/i, '')
            .replace(/[\[\]()._-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const audio = info.codec
            ? [{ language: null, codec: info.codec, channels: info.channels }]
            : [];

        streams.push({
            name: 'DahmerMovies',
            title: cleanInfo,
            url: DAHMER_WORKER_API + encodeURI(directUrl),
            quality: info.quality || 'Auto',
            provider: 'DahmerMovies',
            languages: info.languages, // [] when only DUAL/Multi is stated - real languages unknown
            audio,
            subtitles: [],
            size: path.size,
            container: info.container,
            selectableAudio: info.isMulti,
            headers: {
                'User-Agent': REQUEST_HEADERS['User-Agent'],
                'Referer': `${DAHMER_MOVIES_API}/`,
                'Accept': '*/*',
                'Range': 'bytes=0-'
            }
        });
    }

    console.log(`[DahmerMovies] Total results found: ${streams.length}`);
    return streams;
}

module.exports = { getDahmermoviesStreams };
