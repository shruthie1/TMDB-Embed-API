// showsst - a plain JSON api keyed on TMDB id.
//
// Ported from the sibling resolver (ott/apps/resolver/src/resolver/fastsource.js).
// Two things make it worth having despite its ceiling:
//   - it maps on TMDB id directly, so it cannot land on the wrong film the way
//     a title-matched provider can;
//   - it answers in well under a second with no auth, no session, no browser.
//
// IT CAPS AT 1080p. Measured 2026-09-21 on Devara (811941): the ladder is
// 640x268 / 1280x536 / 1920x804 and nothing above. For 4K use mappleapi.
//
// IT CARRIES NO SELECTABLE AUDIO. The same measurement found ZERO
// #EXT-X-MEDIA:TYPE=AUDIO lines - audio is muxed into each variant as a single
// mp4a track in whatever language the release used. That is precisely why
// utils/hybridStream.js exists: this provider supplies the picture, and a
// rendition-bearing provider (castle-demux, netmirror) supplies the languages.
//
// The host has moved before (api.shows.st was Cloudflare-blocked, now
// api.vidlove.cc) with the routes unchanged, so the base is configurable.

const API_BASE = process.env.SHOWSST_API_BASE || 'https://api.vidlove.cc';
const PLAYER_ORIGIN = process.env.SHOWSST_ORIGIN || 'https://player.vidlove.cc';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.SHOWSST_TIMEOUT_MS) || 12000;

// The stream host rejects a request that does not look like it came from the
// player page, so these travel with every downstream fetch too - they are
// handed back on the stream so the proxy can replay them.
function streamHeaders() {
    return { 'User-Agent': UA, Referer: `${PLAYER_ORIGIN}/`, Origin: PLAYER_ORIGIN };
}

async function getShowsstStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    console.log(`[showsst] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    const base = String(API_BASE).replace(/\/+$/, '');

    // `season`/`episode` spelled out in full. The old host accepted `s`/`e`;
    // this one answers those with {"error":"missing parameters"}, which reads
    // as an ordinary miss and would hide a total TV outage.
    const url = mediaType === 'tv'
        ? `${base}/tv?id=${tmdbId}&season=${seasonNum || 1}&episode=${episodeNum || 1}&mode=json`
        : `${base}/movie?id=${tmdbId}&mode=json`;

    try {
        const res = await fetch(url, {
            headers: { Accept: 'application/json', ...streamHeaders() },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            console.log(`[showsst] HTTP ${res.status} for ${tmdbId}`);
            return [];
        }
        const body = await res.json().catch(() => null);
        const source = body && body.source;
        const streamUrl = source && source.url;
        if (!streamUrl) {
            console.log(`[showsst] No source url for ${tmdbId}`);
            return [];
        }

        // Subtitles come back alongside and cost nothing to carry.
        const subtitles = Array.isArray(body.subtitles)
            ? body.subtitles.filter((s) => s && s.url).map((s, i) => ({
                url: s.url, lang: s.label || s.lang || `Subtitle ${i + 1}`, id: `sst-${i}`,
            }))
            : [];

        console.log(`[showsst] Got 1 stream for ${tmdbId} (${source.label || 'source'})`);
        return [{
            url: streamUrl,
            provider: 'showsst',
            // No language is claimed. The api does not say, and inventing one
            // would put a wrong label in the audio menu - worse than silence.
            languages: [],
            // Deliberately explicit: the master carries no switchable audio, so
            // the UI must not offer a menu that cannot do anything.
            selectableAudio: false,
            quality: '1080p',
            container: 'hls',
            subtitles,
            headers: streamHeaders(),
            title: `showsst · ${source.label || 'VidAPI'}`,
        }];
    } catch (e) {
        console.error(`[showsst] fetch error for ${tmdbId}:`, e.message);
        return [];
    }
}

module.exports = { getShowsstStreams, API_BASE, streamHeaders };
