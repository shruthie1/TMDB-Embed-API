'use strict';

// Which responses the `compression` middleware may gzip.
//
// JSON (/api/streams answers are ~90 KB raw) and HLS text playlists. A
// castle-demux video.m3u8 was 336,595 B raw with nothing compressing it (nginx
// has no gzip_types for m3u8); the 720p multimovies playlist measured 122,512 B
// raw, 14,346 B gzipped. Every playlist this server writes (/m3u8-proxy,
// /castle-demux, /hybrid, /cast) goes through Express, so the filter lives here.
//
// Never compressed: media segments (video/*, audio/aac, audio/mp4, anything not
// a playlist or JSON), HTML, and any ranged response. A segment is already
// compressed, and gzip on a 206 or a Content-Range body breaks byte offsets.

const PLAYLIST_TYPE = /^\s*(application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/mpegurl|audio\/x-mpegurl)\s*(;|$)/i;
const JSON_TYPE = /\bjson\b/i;

function isRanged(req, res) {
    return res.statusCode === 206
        || Boolean(res.getHeader('Content-Range'))
        || Boolean(req.headers && req.headers.range);
}

function noTransform(res) {
    return /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(String(res.getHeader('Cache-Control') || ''));
}

function compressFilter(compression) {
    return (req, res) => {
        if (isRanged(req, res)) return false;
        const type = String(res.getHeader('Content-Type') || '');
        // mime-db does not mark the m3u8 types compressible, so the default
        // filter would refuse them; honour its no-transform rule ourselves.
        if (PLAYLIST_TYPE.test(type)) return !noTransform(res);
        return JSON_TYPE.test(type) && compression.filter(req, res);
    };
}

// For routes mounted before the app-wide middleware (proxy/proxyServer.js
// mounts /m3u8-proxy first). Same filter; attached to playlist routes only, so
// /ts-proxy's streamed segments never pass through it.
let playlistMiddleware = null;
function playlistCompression() {
    if (!playlistMiddleware) {
        const compression = require('compression');
        playlistMiddleware = compression({ filter: compressFilter(compression) });
    }
    return playlistMiddleware;
}

module.exports = { compressFilter, playlistCompression, PLAYLIST_TYPE };
