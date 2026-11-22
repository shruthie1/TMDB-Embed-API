'use strict';

// MultiMovies dash-direct (P21, 2026-11-22): VM HLS playlists built from a
// signed sacdn index.mpd, in place of the out-of-quota dash-hls-bridge.
//
//   GET /mm/hls/<id>/master.m3u8?s=<b64url index.mpd url>&e=<expiry s>[&l=<lang>]
//   GET /mm/hls/<id>/<repId>.m3u8?s=...&e=...
//
// `s` carries the signed MPD URL itself, so the route needs no server state
// and survives a restart or a cached /api/streams answer. `e` is the policy
// expiry, which lib/urlExpiry reads to cap every cache of the row. `l` is the
// provider's language plan for the audio (a name, or "-" for unverified);
// absent, the MPD `lang` is used. Only signed sacdn /dash/ index.mpd URLs are
// accepted: this is not an open fetcher.
//
// The MPD text is cached (resolve-time GET in providers/multimovies.js, or the
// route's own) for 30 min, capped by the URL expiry. The master also needs
// each video rep's init segment (about 3 KB) once: Chrome's MediaSource
// rejects a bare "hev1" CODECS (isTypeSupported false, Chrome 157 on macOS,
// 2026-11-22) and accepts the full hvcC string (hev1.1.6.L150.90).

const { publicBase } = require('../runtime/publicBase');
const conv = require('./mpdHls');

const MPD_HOST = 'sacdn.hakunaymatata.com';
const SIGNED = ['Policy', 'Signature', 'Key-Pair-Id'];
const CACHE_MS = 30 * 60 * 1000;
const EXPIRY_SKEW_MS = 60 * 1000;
const MAX_ENTRIES = 300;
const _config = { mpdTimeoutMs: 5000, initTimeoutMs: 3000 };
const _deps = { fetch: (...a) => globalThis.fetch(...a), now: () => Date.now() };

const cache = new Map(); // mpdUrl -> { text, parsed, until, codecs? }
const inflight = new Map();

// P23 cast watch: c=<token> on a cast URL. The APK polls /mm/hls/cast/<token>
// to see whether the receiver fetched the master and then a video playlist
// (hls.js skips variants whose CODECS it cannot play, so no video playlist
// after the master means the receiver refused the stream). No media bytes.
const CAST_TOKEN = /^[0-9a-f]{16,64}$/;
const CAST_TTL_MS = 2 * 60 * 60 * 1000;
const CAST_MAX = 500;
const casts = new Map(); // token -> { master, video, audio, receiver, at }

function castToken(v) {
    const s = String(v || '');
    return CAST_TOKEN.test(s) ? s : null;
}

function noteCast(token, kind, req) {
    if (!token) return;
    const now = _deps.now();
    for (const [k, e] of casts) if (now - e.at > CAST_TTL_MS) casts.delete(k);
    while (casts.size >= CAST_MAX) casts.delete(casts.keys().next().value);
    const e = casts.get(token) || { master: null, video: null, audio: null, receiver: null, at: now };
    e[kind] = now;
    e.at = now;
    if (kind === 'master') {
        const ua = String(req.get('user-agent') || '');
        e.receiver = require('crypto').createHash('sha256').update(ua).digest('hex').slice(0, 12);
    }
    casts.set(token, e);
}

const b64u = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64u = (s) => { try { return Buffer.from(String(s || ''), 'base64url').toString('utf8'); } catch { return ''; } };

// The parts of a signed sacdn index.mpd URL, or null when it is not one.
function parseMpdUrl(url) {
    let u;
    try { u = new URL(String(url || '')); } catch { return null; }
    if (u.protocol !== 'https:' || u.host !== MPD_HOST) return null;
    const m = /^\/dash\/([^/]+)\/index\.mpd$/.exec(u.pathname);
    if (!m) return null;
    if (!SIGNED.every((k) => u.searchParams.get(k))) return null;
    const idm = /^(\d{10,})_/.exec(m[1]);
    const query = SIGNED.map((k) => `${k}=${encodeURIComponent(u.searchParams.get(k))}`).join('&');
    return {
        id: idm ? idm[1] : m[1].replace(/[^\w-]/g, '').slice(0, 64),
        folder: `https://${MPD_HOST}/dash/${m[1]}/`,
        query,
        expiresAt: conv.policyExpiry(u.searchParams.get('Policy')),
    };
}

// When the cached copy of this URL must go: 30 min, or the policy expiry.
function cacheUntil(info, now) {
    const exp = info && info.expiresAt ? info.expiresAt * 1000 - EXPIRY_SKEW_MS : Infinity;
    return Math.min(now + CACHE_MS, exp);
}

function prune(now) {
    for (const [k, e] of cache) if (e.until <= now) cache.delete(k);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

// Keep an MPD fetched elsewhere (the provider's resolve-time GET). Returns
// the parsed MPD, or throws when the text is not a usable MPD.
function rememberMpd(mpdUrl, text) {
    const info = parseMpdUrl(mpdUrl);
    if (!info) throw new Error('not a signed sacdn MPD url');
    const parsed = conv.parseMpd(text);
    const now = _deps.now();
    const until = cacheUntil(info, now);
    if (until > now) {
        prune(now);
        cache.set(mpdUrl, { text, parsed, until });
    }
    return parsed;
}

function cachedEntry(mpdUrl) {
    const e = cache.get(mpdUrl);
    if (!e) return null;
    if (e.until <= _deps.now()) { cache.delete(mpdUrl); return null; }
    return e;
}

// The cached entry for a signed MPD URL, fetching it once if needed.
async function getEntry(mpdUrl) {
    const hit = cachedEntry(mpdUrl);
    if (hit) return hit;
    if (inflight.has(mpdUrl)) return inflight.get(mpdUrl);
    const p = (async () => {
        const r = await _deps.fetch(mpdUrl, { signal: AbortSignal.timeout(_config.mpdTimeoutMs) });
        if (!r.ok) {
            if (r.body && r.body.cancel) r.body.cancel().catch(() => {});
            const err = new Error(`MPD HTTP ${r.status}`);
            err.status = r.status;
            throw err;
        }
        const text = await r.text();
        rememberMpd(mpdUrl, text);
        return cachedEntry(mpdUrl) || { text, parsed: conv.parseMpd(text), until: 0 };
    })();
    inflight.set(mpdUrl, p);
    try { return await p; } finally { inflight.delete(mpdUrl); }
}

// rep id -> full video codec string from each video rep's init segment
// (hvcC / avcC). {} when any read fails: the master then states no CODECS.
function videoCodecs(entry, info) {
    if (entry.codecs) return entry.codecs;
    const { codecFromInit } = require('../../utils/hybridStream');
    const reps = entry.parsed.reps.filter((r) => r.kind === 'video');
    entry.codecs = Promise.all(reps.map(async (r) => {
        if (!r.init) return [r.id, null];
        const res = await _deps.fetch(`${info.folder}${r.init}?${info.query}`,
            { signal: AbortSignal.timeout(_config.initTimeoutMs) });
        if (!res.ok) return [r.id, null];
        return [r.id, codecFromInit(Buffer.from(await res.arrayBuffer()))];
    })).then((pairs) => (pairs.every(([, c]) => c) ? Object.fromEntries(pairs) : {}),
        () => ({}));
    entry.codecs.then((c) => { if (!Object.keys(c).length) entry.codecs = null; });
    return entry.codecs;
}

// Query string shared by the master and media playlist URLs.
function routeQuery(mpdUrl, info, lang, cast) {
    const q = [`s=${b64u(mpdUrl)}`];
    if (info.expiresAt) q.push(`e=${info.expiresAt}`);
    if (lang !== undefined && lang !== null) q.push(`l=${encodeURIComponent(lang || '-')}`);
    const c = castToken(cast);
    if (c) q.push(`c=${c}`);
    return q.join('&');
}

// The VM master URL for one signed MPD. `base`: the public origin.
// `lang`: the provider's language for the audio (a name), '' / '-' for
// unverified (no LANGUAGE), undefined to use the MPD lang.
// `cast`: an optional cast-watch token (hex), carried to every playlist URL.
function masterUrlFor(base, mpdUrl, lang, cast) {
    const info = parseMpdUrl(mpdUrl);
    if (!info) return null;
    return `${String(base).replace(/\/+$/, '')}/mm/hls/${info.id}/master.m3u8?${routeQuery(mpdUrl, info, lang, cast)}`;
}

// The public origin rows are built against when no request is at hand.
function envBase() {
    const fixed = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    return fixed || `http://127.0.0.1:${process.env.PORT || 8787}`;
}

function languageOpt(l) {
    if (l === undefined) return null;
    const v = String(l).trim();
    if (!v || v === '-') return { code: null, name: 'Audio' };
    const code = conv.codeOfName(v) || conv.hlsLanguage(v);
    return { code, name: conv.nameOfCode(code) || v };
}

function send(res, status, body, maxAgeS) {
    res.status(status);
    if (status === 200) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', `private, max-age=${Math.max(0, Math.floor(maxAgeS || 0))}`);
    } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
    }
    res.end(body);
}

// Shared request checks. Returns { mpdUrl, info, entry } or sends an error.
async function load(req, res) {
    const mpdUrl = unb64u(req.query.s);
    const info = parseMpdUrl(mpdUrl);
    if (!info || info.id !== req.params.id) { send(res, 400, 'bad source'); return null; }
    if (info.expiresAt && info.expiresAt * 1000 <= _deps.now()) { send(res, 410, 'source expired'); return null; }
    try {
        return { mpdUrl, info, entry: await getEntry(mpdUrl) };
    } catch (e) {
        console.log(`[mm-dash] ${req.params.id} MPD unavailable: ${e.message}`);
        send(res, e.status === 403 || e.status === 404 ? 404 : 502, 'source unavailable');
        return null;
    }
}

function maxAge(entry) {
    return Math.min(300, (entry.until - _deps.now()) / 1000);
}

function registerMmDashRoutes(app) {
    app.get('/mm/hls/cast/:token', (req, res) => {
        const token = castToken(req.params.token);
        res.setHeader('Cache-Control', 'no-store');
        if (!token) return res.status(400).json({ error: 'bad token' });
        const e = casts.get(token);
        res.json({ master: e ? e.master : null, video: e ? e.video : null, audio: e ? e.audio : null, receiver: e ? e.receiver : null });
    });
    app.get('/mm/hls/:id/master.m3u8', async (req, res) => {
        const t0 = Date.now();
        const got = await load(req, res);
        if (!got) return;
        const { mpdUrl, info, entry } = got;
        const codecs = await videoCodecs(entry, info);
        const lang = languageOpt(req.query.l);
        const cast = castToken(req.query.c);
        const q = routeQuery(mpdUrl, info, req.query.l, cast);
        const base = `${publicBase(req)}/mm/hls/${info.id}`;
        const text = conv.masterPlaylist(entry.parsed,
            (rep) => `${base}/${encodeURIComponent(rep.id)}.m3u8?${q}`,
            { videoCodecs: codecs, language: lang });
        const audio = entry.parsed.reps.filter((r) => r.kind === 'audio').map((r) => r.lang || '-').join('/');
        console.log(`[mm-dash] master ${info.id} video=${entry.parsed.reps.filter((r) => r.kind === 'video').length}`
            + ` audio=${audio} lang=${lang ? lang.code || 'none' : 'mpd'} codecs=${Object.values(codecs)[0] || 'none'}${cast ? ' cast=1' : ''} in ${Date.now() - t0}ms`);
        noteCast(cast, 'master', req);
        send(res, 200, text, cast ? 0 : maxAge(entry));
    });
    app.get('/mm/hls/:id/:rep.m3u8', async (req, res) => {
        const got = await load(req, res);
        if (!got) return;
        const { info, entry } = got;
        const rep = entry.parsed.reps.find((r) => r.id === req.params.rep);
        if (!rep) return send(res, 404, 'no such rendition');
        const cast = castToken(req.query.c);
        if (cast) console.log(`[mm-dash] cast ${info.id} ${rep.kind} playlist ${rep.id}`);
        noteCast(cast, rep.kind === 'video' ? 'video' : 'audio', req);
        send(res, 200, conv.mediaPlaylist(rep, info.folder, info.query), maxAge(entry));
    });
}

module.exports = {
    registerMmDashRoutes, rememberMpd, getEntry, masterUrlFor, parseMpdUrl, envBase, languageOpt,
    _config, _deps,
    _clear: () => { cache.clear(); inflight.clear(); casts.clear(); },
    _cacheSize: () => cache.size,
    _cached: (u) => cachedEntry(u),
};
