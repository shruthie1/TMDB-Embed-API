const { createDecipheriv } = require('crypto');
const { getDetails } = require('../utils/tmdb');
const { searchSpellings, findTitleMatch } = require('../utils/titleMatch');

const CASTLE_BASE = 'https://api.hlowb.com';
const PKG = 'com.external.castle';
const CHANNEL = 'IndiaA';
const CLIENT = '1';
const LANG = 'en-US';

const API_HEADERS = {
    'User-Agent': 'okhttp/4.9.3',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'Keep-Alive',
    'Referer': CASTLE_BASE
};

const PLAYBACK_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'DNT': '1'
};

function castleSafeParse(text) {
    const safe = text.replace(/([:{[,]\s*)(\d{16,})/g, '$1"$2"');
    return JSON.parse(safe);
}

function deriveKey(securityKey) {
    const keyBytes = Buffer.from(securityKey, 'base64');
    const suffix = Buffer.from('T!BgJB', 'utf8');
    const combined = Buffer.concat([keyBytes, suffix]);
    if (combined.length < 16) {
        return Buffer.concat([combined, Buffer.alloc(16 - combined.length, 0)]);
    }
    return combined.subarray(0, 16);
}

function decryptCastle(cipherText, securityKey) {
    const key = deriveKey(securityKey);
    const decipher = createDecipheriv('aes-128-cbc', key, key);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(cipherText, 'base64')),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

async function castleRequest(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { ...API_HEADERS, ...(options.headers || {}) },
        signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) {
        throw new Error(`[CastleTV] HTTP ${res.status}: ${res.statusText}`);
    }
    return res;
}

async function extractCipher(res) {
    const text = await res.text();
    const trimmed = text.trim();
    if (!trimmed) throw new Error('[CastleTV] Empty response body');
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed.data && typeof parsed.data === 'string') {
            return parsed.data.trim();
        }
    } catch {
        // Not JSON — raw cipher text
    }
    return trimmed;
}

function unwrap(obj) {
    if (obj && obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
        return obj.data;
    }
    return obj;
}

async function getSecurityKey() {
    const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
    const res = await castleRequest(url);
    const json = await res.json();
    if (json.code !== 200 || !json.data) {
        throw new Error(`[CastleTV] Security key error: ${JSON.stringify(json)}`);
    }
    return json.data;
}

async function searchCastle(secKey, keyword) {
    const params = new URLSearchParams({
        channel: CHANNEL,
        clientType: CLIENT,
        keyword,
        lang: LANG,
        mode: '1',
        packageName: PKG,
        page: '1',
        size: '30'
    });
    const res = await castleRequest(`${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params}`);
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getCastleDetails(secKey, movieId) {
    const url = `${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`;
    const res = await castleRequest(url);
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getVideoByLanguage(secKey, movieId, episodeId, languageId, resolution) {
    const body = {
        mode: '1',
        appMarket: 'GuanWang',
        clientType: CLIENT,
        woolUser: 'false',
        apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475',
        androidVersion: '13',
        movieId,
        episodeId,
        languageId,
        isNewUser: 'true',
        resolution: resolution.toString(),
        packageName: PKG
    };
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const res = await castleRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

async function getVideoShared(secKey, movieId, episodeId, resolution) {
    const body = {
        mode: '1',
        appMarket: 'GuanWang',
        clientType: CLIENT,
        woolUser: 'false',
        apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475',
        androidVersion: '13',
        movieId,
        episodeId,
        isNewUser: 'true',
        resolution: resolution.toString(),
        packageName: PKG
    };
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const res = await castleRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const cipher = await extractCipher(res);
    return castleSafeParse(decryptCastle(cipher, secKey));
}

function resolutionLabel(res) {
    const map = { 1: '480p', 2: '720p', 3: '1080p' };
    return map[res] || `${res}p`;
}

const KNOWN_HEIGHTS = new Set([240, 360, 480, 540, 576, 720, 1080, 1440, 2160]);

function knownHeight(value) {
    const n = Number(value);
    return Number.isFinite(n) && KNOWN_HEIGHTS.has(n);
}

function resolutionNumToLabel(num) {
    const map = { 1: '480p', 2: '720p', 3: '1080p', 4: '4K' };
    return map[num] || null;
}

function streamQuality(url, description, resolutionNum, defaultQual) {
    if (description) {
        const m = /(?:SD|HD|FHD|UHD|4K)?\s*(\d{3,4})\s*p?/i.exec(String(description).trim());
        if (m && knownHeight(m[1])) {
            return `${m[1]}p`;
        }
        if (/4k|uhd/i.test(String(description))) return '4K';
    }
    // Castle's hls_mps paths embed the true height (.../<hash>/480/index...).
    // It requested 1080p but serves 480p, so the path beats the requested
    // resolution number - otherwise every variant is mislabelled 1080p.
    if (url) {
        const pathHeight = /\/(\d{3,4})\/[^/]*$/.exec(String(url).split('?')[0]);
        if (pathHeight && knownHeight(pathHeight[1])) return `${pathHeight[1]}p`;
    }
    const numLabel = resolutionNumToLabel(Number(resolutionNum));
    if (numLabel) return numLabel;
    if (url) {
        const tokens = url.match(/[^/a-z](?:(\d{3,4})\s*p?)[^a-z]/gi);
        if (tokens) {
            for (const t of tokens) {
                const m = /(\d{3,4})/i.exec(t);
                if (m && knownHeight(m[1])) return `${m[1]}p`;
            }
        }
    }
    return defaultQual;
}

function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes <= 0) return 'Unknown';
    if (bytes > 1000000000) return `${(bytes / 1000000000).toFixed(2)} GB`;
    return `${(bytes / 1000000).toFixed(0)} MB`;
}

// A preview clip betrays itself in the path even when the API flag does not.
function isPreviewUrl(url) {
    return /\/index_preview_\d+\.m3u8/i.test(String(url || ''));
}

function looksLikePreviewPayload(data) {
    const urls = [data.videoUrl, ...(data.videos || []).map((v) => v && v.url)].filter(Boolean);
    return urls.length > 0 && urls.every(isPreviewUrl);
}

function buildCastleStreams(raw, langLabel, titleLine, resolution) {
    const data = unwrap(raw);
    // Castle gates real playback behind a signed-in VIP session. Anonymously we
    // get either permissionDenied (no url at all) or isPreview (a ~480p preview
    // reel of .jpg segments served under the title's own hash). Both used to be
    // emitted as if they were the film, which is where "every language sounds
    // the same" came from - it was one preview reel wearing N language labels.
    if (data.permissionDenied === true) return [];
    if (data.isPreview === true) return [];
    // isPreview is Castle's own flag and it is not always set: some titles come
    // back with it absent (or false) while every returned URL is still an
    // `index_preview_*` clip under a `/480/` path, labelled 1080p. Measured on
    // one such title, all five "languages" were the same 10.02 minute, 191
    // segment reel. Trust the URL shape as well as the flag.
    if (looksLikePreviewPayload(data)) return [];
    if (!data.videoUrl && !((data.videos || []).length)) return [];

    const defaultQual = resolutionLabel(resolution);

    const subtitles = (data.subtitles || [])
        .filter((s) => typeof s.url === 'string' && s.url.length > 0)
        .map((s, i) => ({
            url: s.url.replace(/ /g, '%20'),
            lang: s.abbreviate || s.title || 'Unknown',
            id: `castle-${s.languageId || s.abbreviate || i}`
        }));

    const streams = [];

    if (data.videos && data.videos.length > 0) {
        const bestByUrl = new Map();
        for (const v of data.videos) {
            // Entries without their own url are metadata-only rows (size and
            // resolutionDescription). Falling back to data.videoUrl here minted
            // one fake stream per advertised resolution, all the same file.
            const videoUrl = v.url;
            if (!videoUrl) continue;
            const resNum = Number(v.resolution) || 0;
            const qual = streamQuality(
                videoUrl,
                v.resolutionDescription,
                resNum,
                defaultQual
            );
            const existing = bestByUrl.get(videoUrl);
            if (existing && existing.resNum >= resNum) continue;
            const nameTag = langLabel ? `CastleTV ${langLabel}` : 'CastleTV';
            bestByUrl.set(videoUrl, {
                resNum,
                stream: {
                    name: `${nameTag} | ${qual}`,
                    title: `${titleLine}\n${qual} | ${formatSize(v.size)} | Castle`,
                    url: videoUrl,
                    quality: qual,
                    provider: 'CastleTV',
                    headers: PLAYBACK_HEADERS,
                    ...(subtitles.length ? { subtitles } : {})
                }
            });
        }
        for (const { stream } of bestByUrl.values()) {
            streams.push(stream);
        }
    }

    // videos[] present but every entry was metadata-only: fall back to the one
    // real url on the payload rather than dropping the stream entirely.
    if (streams.length === 0) {
        const videoUrl = data.videoUrl;
        if (!videoUrl) return [];
        const qual = streamQuality(videoUrl, data.resolutionDescription, 0, defaultQual);
        const nameTag = langLabel ? `CastleTV ${langLabel}` : 'CastleTV';
        streams.push({
            name: `${nameTag} | ${qual}`,
            title: `${titleLine}\n${qual} | ${formatSize(data.size)} | Castle`,
            url: videoUrl,
            quality: qual,
            provider: 'CastleTV',
            headers: PLAYBACK_HEADERS,
            ...(subtitles.length ? { subtitles } : {})
        });
    }

    return streams;
}

// Castle signs every playback URL and rotates an `index_preview_<NNN>` suffix,
// so the same physical media comes back under a different URL on each call.
// Identity is the CDN path with the query and that suffix removed - this is
// what lets us tell "a real second language" apart from "the same file again".
function mediaIdentity(url) {
    if (!url) return '';
    const noQuery = String(url).split('?')[0];
    const pathOnly = noQuery.replace(/^https?:\/\/[^/]+/i, '');
    return pathOnly.replace(/_(\d+)(\.m3u8)$/i, '$2');
}

// Every track is queried, never just the existIndividualVideo ones.
//
// This used to keep only eiv===true tracks when any existed. But eiv is
// ADVISORY and Castle sets it false on tracks that do serve their own file -
// the comment at the call site already says so for Kantara's Hindi track.
// Measured 2026-09-21 on Devara: Part 1 (811941), a TELUGU original:
//   [{1037 Telugu eiv:false}, {1018 Hindi eiv:true}, {1033 Tamil eiv:false},
//    {1039 Malayalam eiv:false}, {1035 Kannada eiv:false}]
// Exactly one track was flagged, so the filter discarded Telugu, Tamil,
// Malayalam and Kannada and the film came back Hindi-only. Trusting a flag the
// code elsewhere calls unreliable is what cost the original language.
//
// Querying all of them is safe: the caller already collapses results by media
// identity, so languages that share one file emit a single stream naming each,
// and a track with no distinct file simply resolves to the same URL.
function pickPreferredTracks(tracks) {
    return tracks || [];
}

// Castle changed the track schema from languageId/languageName to id/name.
// Normalize both shapes before requesting playback; otherwise an undefined
// languageId makes the API return its default Hindi stream for every label.
function normalizeLanguageTrack(track) {
    if (!track || typeof track !== 'object') return track;
    return {
        ...track,
        languageId: track.languageId ?? track.id,
        languageName: track.languageName ?? track.name ?? track.abbreviate
    };
}

async function getCastletvStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[CastleTV] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);

    try {
        const type = mediaType === 'tv' ? 'series' : 'movie';
        const tmdbType = mediaType === 'tv' ? 'tv' : 'movie';
        const details = await getDetails(tmdbType, tmdbId);
        const title = (details && (details.title || details.name)) || '';
        const year = (details && (details.release_date || details.first_air_date || '').slice(0, 4)) || null;
        if (!title) {
            console.log(`[CastleTV] No TMDB title resolved for ${tmdbId}`);
            return [];
        }

        const season = seasonNum || 1;
        const episode = episodeNum || 1;
        const titleLine = type === 'series'
            ? `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}${year ? ` (${year})` : ''}`
            : `${title}${year ? ` (${year})` : ''}`;

        const secKey = await getSecurityKey();

        // Ask in every plausible spelling, best first. Deaccenting locally is
        // not enough on its own: if Castle's index is ASCII-only, querying in
        // the accented spelling returns zero rows, and zero rows is
        // indistinguishable downstream from "Castle has no copy".
        // searchSpellings collapses to one entry for an ASCII title, so nothing
        // is fetched twice.
        const keywords = searchSpellings(title, { year });

        let rows = [];
        let keyword = keywords[0];
        for (const candidate of keywords) {
            keyword = candidate;
            const searchResult = await searchCastle(secKey, candidate);
            rows = (unwrap(searchResult).rows || []);
            if (rows.length) break;
            console.log(`[CastleTV] No search results for "${candidate}"`);
        }

        if (rows.length === 0) return [];

        // Title matching lives in utils/titleMatch.js, shared by every
        // title-based provider. It deaccents FIRST (a macron used to fall
        // outside [a-z0-9] and become a SPACE, so "Bahubali" normalised to
        // "b hubali the beginning"), tolerates Indic doubled vowels
        // ("Bahubali" ~ "Baahubali") and allows a catalogue to omit a sequel
        // suffix ("Devara" for TMDB's "Devara: Part 1").
        //
        // It never falls back to rows[0]. Guessing produced a confidently wrong
        // film with a plausible-looking stream - we served "Beginning" instead
        // of "Bahubali: The Beginning" and reported the film as Tamil-only.
        // Returning nothing lets another provider win instead.
        const match = findTitleMatch(rows, title);
        if (!match) {
            // Log what WAS on offer. A bare "no match" is indistinguishable
            // from a matcher that is too strict, and telling those two apart
            // by hand is what cost a day on Bahubali.
            const offered = rows.slice(0, 6).map((r) => r.title || r.name).join(' | ');
            console.log(`[CastleTV] No confident match for "${title}" among ${rows.length} rows - skipping (saw: ${offered})`);
            return [];
        }
        const castleId = (match.id || match.redirectId || match.redirectIdStr || '').toString();
        if (!castleId) return [];

        let castleDetails = await getCastleDetails(secKey, castleId);
        let activeId = castleId;

        if (type === 'series') {
            const seasons = (unwrap(castleDetails).seasons || []);
            const seasonEntry = seasons.find((s) => s.number === season);
            if (seasonEntry && seasonEntry.movieId && seasonEntry.movieId.toString() !== castleId) {
                castleDetails = await getCastleDetails(secKey, seasonEntry.movieId.toString());
                activeId = seasonEntry.movieId.toString();
            }
        }

        const episodes = (unwrap(castleDetails).episodes || []);
        let episodeId = null;

        if (type === 'series') {
            const ep = episodes.find((e) => e.number === episode);
            episodeId = ep && ep.id ? ep.id.toString() : null;
        } else {
            episodeId = episodes[0] && episodes[0].id ? episodes[0].id.toString() : null;
        }

        if (!episodeId) {
            console.log(`[CastleTV] No episode found (${season}/${episode})`);
            return [];
        }

        const epEntry = episodes.find((e) => e.id && e.id.toString() === episodeId);
        const allTracks = ((epEntry && epEntry.tracks) || []).map(normalizeLanguageTrack);
        const tracks = pickPreferredTracks(allTracks);

        // existIndividualVideo is advisory only - Castle sets it false on tracks
        // that still return their own per-language file (Kantara Chapter 1's
        // Hindi track is eiv=false yet serves .../Kantara/hin_720/). So always
        // fan out, and decide what is genuinely distinct from the media path
        // that comes back rather than from this flag.
        const streams = [];
        const seenUrls = new Set();
        // Keyed by media identity, so the [3,2,1] resolution fan-out and the
        // rotating URL suffix collapse into one entry per real file.
        const seenMedia = new Set();

        if (tracks.length > 0) {
            const langJobs = tracks.map((track) =>
                Promise.allSettled(
                    [3, 2, 1].map((resolution) =>
                        getVideoByLanguage(secKey, activeId, episodeId, String(track.languageId), resolution)
                            .then((raw) => ({ raw, resolution, track }))
                    )
                )
            );
            const allResults = await Promise.all(langJobs);

            // One entry per DISTINCT media file. Several languageIds often
            // resolve to the same file (one multi-audio or original-language
            // mix); emitting that once per language is what made every option
            // sound identical. A language with its own file still gets its own
            // entry. Labels are decided after collection so a shared file can
            // name every language it actually serves.
            const byMedia = new Map();
            for (const trackResults of allResults) {
                for (const r of trackResults) {
                    if (r.status !== 'fulfilled') continue;
                    const { raw, resolution, track } = r.value;
                    for (const s of buildCastleStreams(raw, '', titleLine, resolution)) {
                        const identity = mediaIdentity(s.url);
                        const langName = track.languageName || track.abbreviate || 'Unknown';
                        const existing = byMedia.get(identity);
                        if (existing) {
                            if (!existing.langs.includes(langName)) existing.langs.push(langName);
                            continue;
                        }
                        byMedia.set(identity, { stream: s, langs: [langName] });
                    }
                }
            }
            for (const { stream, langs } of byMedia.values()) {
                if (seenUrls.has(stream.url)) continue;
                seenUrls.add(stream.url);
                seenMedia.add(mediaIdentity(stream.url));
                const label = `[${langs.join('/')}]`;
                stream.name = stream.name.replace('CastleTV |', `CastleTV ${label} |`);
                stream.language = langs.join('/');
                streams.push(stream);
            }
        }

        if (streams.length === 0) {
            // One shared file for the title. Castle still tells us which
            // language it is via the default track, so use that rather than
            // leaving it unlabelled - but never claim the other languages.
            const defaultTrack = allTracks.find((t) => t.isDefault) || allTracks[0];
            const defaultName = defaultTrack && (defaultTrack.languageName || defaultTrack.abbreviate);
            const sharedLabel = defaultName ? `[${defaultName}]` : '';
            const sharedResults = await Promise.allSettled(
                [3, 2, 1].map((resolution) =>
                    getVideoShared(secKey, activeId, episodeId, resolution)
                        .then((raw) => ({ raw, resolution }))
                )
            );
            for (const r of sharedResults) {
                if (r.status !== 'fulfilled') continue;
                const { raw, resolution } = r.value;
                for (const s of buildCastleStreams(raw, sharedLabel, titleLine, resolution)) {
                    const identity = mediaIdentity(s.url);
                    if (seenUrls.has(s.url) || seenMedia.has(identity)) continue;
                    seenUrls.add(s.url);
                    seenMedia.add(identity);
                    streams.push(s);
                }
            }
        }

        console.log(`[CastleTV] Got ${streams.length} stream(s) for "${title}"`);
        return streams;
    } catch (err) {
        console.error(`[CastleTV] Error: ${err.message}`);
        throw err; // an upstream failure is an error, not "no streams"
    }
}

module.exports = { getCastletvStreams };
