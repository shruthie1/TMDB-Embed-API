'use strict';
// Cast to a TV through Web Video Caster (docs/PENDING-WORK.md C1, C2).
//
// The phone hands WVC ONE url and the TV plays it for the whole film. That url
// therefore has to:
//   - live for the runtime + 1h. Hybrid jobs live 20 min (HYBRID_JOB_TTL_MS)
//     and castle-demux jobs 30 min, both in memory only.
//   - survive an API restart (every deploy restarts). Jobs are persisted to one
//     JSON file under data/, which deploy-vm.sh carries into the new dir.
//   - offer ONE audio rendition, Telugu, DEFAULT=YES. A receiver may show no
//     audio menu, so a second rendition is a chance to play the wrong language.
//   - give the receiver a VIDEO-ONLY variant. Measured: a receiver that ignores
//     the audio group plays whatever audio the variant carries, so a muxed
//     variant plays its own (often Tamil) track. Muxed video segments are split
//     here with ffmpeg -c copy, the same remux castle-demux runs.
//
// Routes:
//   POST /cast            {url} | {pair:{video,audio}, tmdbId, type}  -> {id, url, expiresAt}
//   GET  /cast/:id.m3u8   the cast master
//   GET  /cast/:id/video.m3u8, /cast/:id/v/:n.ts   video-only split of a muxed video
//   POST /cast/playlist   raw m3u8 body (2 MB cap, 4h TTL, segment-host allowlist)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const hybrid = require('../../utils/hybridStream');
const castleDemux = require('../../utils/castleDemux');
const streamHeaders = require('./streamHeaders');
const { publicBase } = require('../runtime/publicBase');

const HOUR_MS = 3600 * 1000;
const DEFAULT_RUNTIME_SECONDS = 3 * 3600;
const PLAYLIST_TTL_MS = 4 * HOUR_MS;
const PLAYLIST_LIMIT = '2mb';
const MAX_JOBS = Number(process.env.CAST_MAX_JOBS) || 300;
const FETCH_TIMEOUT_MS = Number(process.env.CAST_FETCH_TIMEOUT_MS) || 20000;
const DEFAULT_STORE = path.join(__dirname, '..', '..', 'data', 'cast-jobs.json');
const M3U8 = 'application/vnd.apple.mpegurl';

const DEMUX_ID_RE = /\/castle-demux\/([0-9a-f]{24})\//g;

function newId() { return crypto.randomBytes(12).toString('hex'); }

function totalSeconds(text) {
    return [...String(text || '').matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + parseFloat(m[1]), 0);
}

function attr(line, name) {
    return (String(line).match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';
}

// First fetchable media reference of a media playlist: the init segment when
// there is one (it declares every track), else the first segment.
function firstRef(text, baseUrl) {
    const map = String(text).split('\n').find((l) => l.startsWith('#EXT-X-MAP:'));
    if (map && attr(map, 'URI')) return new URL(attr(map, 'URI'), baseUrl).href;
    const seg = String(text).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    return seg ? new URL(seg, baseUrl).href : null;
}

class CastRefusal extends Error {
    constructor(status, reason) { super(reason); this.status = status; }
}

function registerCastRoutes(app, deps = {}) {
    const now = deps.now || (() => Date.now());
    const doFetch = (...a) => (deps.fetch || globalThis.fetch)(...a);
    const tmdb = deps.tmdb || require('../../utils/tmdb');
    const extractTrack = deps.extractTrack || castleDemux.extractTrack;
    const probeTracks = deps.probeTracks || castleDemux.probeTracks;
    const storePath = deps.storePath || process.env.CAST_STORE_PATH || DEFAULT_STORE;
    const keepaliveMs = deps.keepaliveMs ?? 60 * 1000;
    const playlistHosts = (deps.playlistHosts
        || String(process.env.CAST_PLAYLIST_HOSTS || '').split(','))
        .map((h) => h.trim().toLowerCase()).filter(Boolean);
    const demux = require('./republish');

    const jobs = new Map();

    // ---- store -------------------------------------------------------------
    function load() {
        let raw;
        try { raw = fs.readFileSync(storePath, 'utf8'); } catch { return; }
        try {
            for (const job of JSON.parse(raw)) {
                if (job && job.id && job.expiresAt > now()) jobs.set(job.id, job);
            }
            console.log(`[cast] loaded ${jobs.size} job(s) from ${storePath}`);
        } catch (e) {
            console.error(`[cast] store unreadable, starting empty: ${storePath}: ${e.message}`);
        }
    }

    function persist() {
        const live = [...jobs.values()].filter((j) => j.expiresAt > now());
        try {
            fs.mkdirSync(path.dirname(storePath), { recursive: true });
            const tmp = `${storePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(live));
            fs.renameSync(tmp, storePath);
        } catch (e) {
            console.error(`[cast] persist failed: ${storePath}: ${e.message}`);
        }
    }

    function put(job) {
        for (const [id, j] of jobs) if (j.expiresAt <= now()) jobs.delete(id);
        while (jobs.size >= MAX_JOBS) {
            const oldest = [...jobs.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
            jobs.delete(oldest.id);
            console.warn(`[cast] evicted ${oldest.id}: ${MAX_JOBS} job cap`);
        }
        jobs.set(job.id, job);
        persist();
    }

    function get(id) {
        const job = jobs.get(id);
        if (!job) return null;
        if (job.expiresAt <= now()) { jobs.delete(id); return null; }
        return job;
    }

    // castle-demux jobs live 30 min in memory. A cast that points at one
    // snapshots it and holds it open (and re-creates it after a restart) for
    // as long as the cast lives. storeCastleDemux ids are content hashes, so
    // re-storing the snapshot yields the same id the master already names.
    function keepalive() {
        for (const job of jobs.values()) {
            if (job.expiresAt <= now()) continue;
            for (const [id, snap] of Object.entries(job.demux || {})) {
                let entry = demux.castleDemuxJobs.get(id);
                if (!entry) {
                    const again = demux.storeCastleDemux(snap);
                    if (again !== id) {
                        console.error(`[cast] demux snapshot re-stored under ${again}, expected ${id}`);
                        continue;
                    }
                    entry = demux.castleDemuxJobs.get(id);
                    console.log(`[cast] demux ${id} restored for cast ${job.id}`);
                }
                entry.expiresAt = Math.max(entry.expiresAt || 0, job.expiresAt);
            }
        }
    }

    function demuxSnapshots(master) {
        const out = {};
        for (const m of String(master).matchAll(DEMUX_ID_RE)) {
            const entry = demux.castleDemuxJobs.get(m[1]);
            if (!entry) throw new CastRefusal(409, `castle-demux ${m[1]} expired; re-resolve the title`);
            const { expiresAt, ...snap } = entry; // eslint-disable-line no-unused-vars
            out[m[1]] = snap;
        }
        return out;
    }

    // ---- fetch helpers -----------------------------------------------------
    async function fetchText(url, headers) {
        const r = await doFetch(url, { headers: headers || {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) throw new CastRefusal(502, `upstream ${r.status} for ${String(url).slice(0, 120)}`);
        return r.text();
    }

    async function fetchBytes(url, headers) {
        const r = await doFetch(url, { headers: headers || {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) throw new CastRefusal(502, `segment ${r.status} for ${String(url).slice(0, 120)}`);
        return Buffer.from(await r.arrayBuffer());
    }

    // The tracks inside one media playlist's first reference.
    async function tracksOf(playlistText, playlistUrl, headers) {
        const ref = firstRef(playlistText, playlistUrl);
        if (!ref) throw new CastRefusal(502, 'playlist has no segments');
        const info = await probeTracks(await fetchBytes(ref, headers));
        return { hasVideo: Boolean(info.videoWidth || info.videoHeight), audio: info.audio || [], info };
    }

    async function runtimeFor(tmdbId, type) {
        if (!tmdbId) return 0;
        try {
            const d = await tmdb.getDetails(type === 'series' || type === 'tv' ? 'tv' : 'movie', tmdbId);
            return (Number(d?.runtime) || Number((d?.episode_run_time || [])[0]) || 0) * 60;
        } catch (e) {
            console.warn(`[cast] runtime lookup failed for ${tmdbId}: ${e.message}`);
            return 0;
        }
    }

    const ttlFrom = (seconds) => now() + (seconds || DEFAULT_RUNTIME_SECONDS) * 1000 + HOUR_MS;

    // Same upstream-first header lookup as /hybrid/pair: the browser posts
    // proxied urls, the registry is keyed by the upstream.
    function upstreamSide(side) {
        const inner = hybrid.unwrapProxied(side.url);
        const base = { ...side, url: inner.url };
        const filled = streamHeaders.withKnownHeaders(base);
        const has = (o) => Boolean(o && Object.keys(o).length);
        const out = has(filled.headers) ? filled : { ...filled, headers: inner.headers };
        if (side.codecs != null) out.codecs = hybrid.cleanCodecs(side.codecs);
        return out;
    }

    // ---- pair cast ---------------------------------------------------------
    async function createPair(req, raw, serverUrl) {
        const video = upstreamSide(raw.pair.video);
        const audio = upstreamSide(raw.pair.audio);
        const runtimeSeconds = await runtimeFor(raw.tmdbId, raw.type);
        const plans = await hybrid.planPairings([video, audio], { runtimeSeconds });
        const plan = plans.find((p) => p.video.stream === video && p.audio.stream === audio);
        if (!plan) throw new CastRefusal(409, 'not pairable: different cuts, or no audio renditions');
        if (Number(raw.nudge)) plan.nudge = Number(raw.nudge);

        // C2: the rendition the receiver will play must be audio-only.
        const renditions = plan.audio.desc.audio.renditions;
        const chosen = renditions[hybrid.defaultAudioIndex(renditions)];
        if (!/\/castle-demux\/[0-9a-f]{24}\/audio-\d+\.m3u8/.test(chosen.url)) {
            const text = await fetchText(chosen.url, plan.audio.desc.headers);
            const t = await tracksOf(text, chosen.url, plan.audio.desc.headers)
                .catch((e) => { throw new CastRefusal(409, `audio rendition could not be checked: ${e.message}`); });
            if (t.hasVideo) throw new CastRefusal(409, `audio rendition carries video (muxed): ${chosen.name}`);
        }

        // C2: the variant must be video-only. castle-demux video.m3u8 is by
        // construction; anything else is probed, and split here when muxed.
        const id = newId();
        const v = plan.video.desc.video;
        let split = null;
        let ladder = v.ladder;
        if (!/\/castle-demux\/[0-9a-f]{24}\/video\.m3u8/.test(v.url)) {
            const t = await tracksOf(v.text, v.url, plan.video.desc.headers);
            if (t.audio.length) {
                if (/#EXT-X-MAP:/.test(v.text)) throw new CastRefusal(409, 'video is muxed fMP4; cannot split for cast');
                if (/#EXT-X-BYTERANGE/.test(v.text)) throw new CastRefusal(409, 'video uses byte ranges; cannot split for cast');
                const key = (v.text.match(/#EXT-X-KEY:[^\n]*/) || [])[0];
                if (key && !/METHOD=NONE/.test(key)) throw new CastRefusal(409, 'video is encrypted; cannot split for cast');
                const lines = v.text.split('\n').map((l) => l.replace(/\r$/, ''));
                const segments = [];
                const out = lines.map((l) => {
                    if (!l.trim() || l.startsWith('#')) return l;
                    segments.push(new URL(l.trim(), v.url).href);
                    return { seg: segments.length - 1 };
                });
                split = {
                    lines: out, segments, headers: plan.video.desc.headers || {},
                    videoIndex: t.info.videoIndex,
                };
                const w = t.info.videoWidth;
                const h = t.info.videoHeight || v.height || plan.height || 0;
                ladder = [{
                    url: `${serverUrl}/cast/${id}/video.m3u8`,
                    height: h,
                    attrs: w && h ? `RESOLUTION=${w}x${h}` : '',
                }];
            }
        }
        const castPlan = { ...plan, video: { ...plan.video, desc: { ...plan.video.desc, video: { ...v, ladder } } } };
        const real = await hybrid.realisePlan(castPlan, serverUrl, { castSingleAudio: true });
        if (!real) throw new CastRefusal(502, 'cast master could not be built');
        const seconds = runtimeSeconds || Math.max(plan.video.desc.seconds, plan.audio.desc.seconds);
        const job = {
            id, kind: 'pair', createdAt: now(), expiresAt: ttlFrom(seconds),
            title: String(raw.title || '').slice(0, 200),
            master: real.playlist,
            audio: { name: chosen.name, language: chosen.language },
            video: split,
            demux: demuxSnapshots(real.playlist),
        };
        put(job);
        console.log(`[cast] created ${id} pair ${plan.video.stream.provider} video + ${plan.audio.stream.provider}`
            + ` audio lang=${chosen.language || chosen.name} videoOnly=${split ? 'split' : 'native'}`
            + ` ttl=${Math.round((job.expiresAt - now()) / 60000)}min`);
        return job;
    }

    // ---- plain url cast ----------------------------------------------------
    async function createUrl(req, raw, serverUrl) {
        const inner = hybrid.unwrapProxied(raw.url);
        const upstream = inner.url;
        const local = upstream.startsWith(serverUrl);
        const headers = local ? {} : (streamHeaders.headersFor(upstream) || inner.headers || {});
        const text = await fetchText(upstream, headers);
        if (!/^#EXTM3U/.test(text.trim())) throw new CastRefusal(502, 'not an HLS playlist');
        let master;
        let audio = null;
        let seconds = await runtimeFor(raw.tmdbId, raw.type);
        if (/#EXT-X-STREAM-INF/.test(text)) {
            const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
            const audioLines = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l));
            const keep = audioLines[hybrid.defaultAudioIndex(audioLines.map((l) => ({
                name: attr(l, 'NAME'), language: attr(l, 'LANGUAGE') })))];
            if (keep) audio = { name: attr(keep, 'NAME'), language: attr(keep, 'LANGUAGE') };
            const abs = (u) => hybrid.proxied(serverUrl, new URL(u, upstream).href, headers);
            master = lines
                .filter((l) => !(l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l)) || l === keep)
                .map((l) => {
                    if (l === keep) {
                        l = l.replace(/DEFAULT=(YES|NO)/, 'DEFAULT=YES').replace(/AUTOSELECT=(YES|NO)/, 'AUTOSELECT=YES');
                        if (!/DEFAULT=/.test(l)) l += ',DEFAULT=YES';
                        if (!/AUTOSELECT=/.test(l)) l += ',AUTOSELECT=YES';
                    }
                    if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/, (_, u) => `URI="${abs(u)}"`);
                    return l.trim() ? abs(l.trim()) : l;
                }).join('\n');
        } else {
            seconds = seconds || totalSeconds(text);
            master = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-STREAM-INF:BANDWIDTH=2500000',
                hybrid.proxied(serverUrl, upstream, headers), ''].join('\n');
        }
        const id = newId();
        const job = {
            id, kind: 'url', createdAt: now(), expiresAt: ttlFrom(seconds),
            title: String(raw.title || '').slice(0, 200),
            master, audio, video: null, demux: demuxSnapshots(master),
        };
        put(job);
        console.log(`[cast] created ${id} url lang=${audio ? (audio.language || audio.name) : 'in-stream'}`
            + ` ttl=${Math.round((job.expiresAt - now()) / 60000)}min`);
        return job;
    }

    // ---- routes ------------------------------------------------------------
    app.post('/cast', async (req, res) => {
        const raw = req.body || {};
        const serverUrl = publicBase(req);
        const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));
        try {
            let job;
            if (raw.pair) {
                if (!isHttp(raw.pair.video?.url) || !isHttp(raw.pair.audio?.url)) {
                    return res.status(400).json({ error: 'pair.video.url and pair.audio.url (http/https) required' });
                }
                job = await createPair(req, raw, serverUrl);
            } else if (raw.url) {
                if (!isHttp(raw.url)) return res.status(400).json({ error: 'url must be http(s)' });
                job = await createUrl(req, raw, serverUrl);
            } else {
                return res.status(400).json({ error: 'url or pair required' });
            }
            res.json({
                id: job.id, url: `${serverUrl}/cast/${job.id}.m3u8`, expiresAt: job.expiresAt,
                audio: job.audio, videoOnly: job.kind === 'pair' ? (job.video ? 'split' : 'native') : null,
            });
        } catch (e) {
            const status = e instanceof CastRefusal ? e.status : 500;
            console.warn(`[cast] refused ${status}: ${e.message}`);
            res.status(status).json({ error: 'cast failed', reason: e.message });
        }
    });

    app.post('/cast/playlist', express.text({
        limit: PLAYLIST_LIMIT,
        type: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'text/plain'],
    }), (req, res) => {
        const text = typeof req.body === 'string' ? req.body : String(req.body?.playlist || '');
        if (!/^#EXTM3U/.test(text.trim())) return res.status(400).json({ error: 'body must be an m3u8 playlist' });
        const serverHost = new URL(publicBase(req)).hostname.toLowerCase();
        const allowed = (host) => host === serverHost
            || playlistHosts.some((h) => host === h || host.endsWith(`.${h}`));
        const uris = [];
        for (const l of text.split('\n').map((x) => x.trim())) {
            if (!l) continue;
            if (l.startsWith('#')) { const u = attr(l, 'URI'); if (u) uris.push(u); } else uris.push(l);
        }
        for (const u of uris) {
            let host;
            try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw new Error(); host = p.hostname.toLowerCase(); } catch {
                return res.status(400).json({ error: `uri must be absolute http(s): ${u.slice(0, 120)}` });
            }
            if (!allowed(host)) return res.status(400).json({ error: `host not allowed: ${host}` });
        }
        const id = newId();
        const job = { id, kind: 'playlist', createdAt: now(), expiresAt: now() + PLAYLIST_TTL_MS,
            master: text, audio: null, video: null, demux: {} };
        put(job);
        console.log(`[cast] created ${id} playlist ${text.length}B ${uris.length} uris`);
        res.json({ id, url: `${publicBase(req)}/cast/${id}.m3u8`, expiresAt: job.expiresAt });
    });

    app.get('/cast/:id.m3u8', (req, res) => {
        const job = get(req.params.id);
        if (!job) return res.status(404).set('Content-Type', M3U8).send('# cast expired - cast again from the phone\n');
        keepalive();
        res.set('Content-Type', M3U8);
        res.set('Cache-Control', 'no-store');
        res.send(job.master);
    });

    app.get('/cast/:id/video.m3u8', (req, res) => {
        const job = get(req.params.id);
        if (!job || !job.video) return res.status(404).set('Content-Type', M3U8).send('# cast expired\n');
        const base = `${publicBase(req)}/cast/${job.id}/v`;
        res.set('Content-Type', M3U8);
        res.set('Cache-Control', 'no-store');
        res.send(job.video.lines.map((l) => (typeof l === 'string' ? l : `${base}/${l.seg}.ts`)).join('\n') + '\n');
    });

    app.get('/cast/:id/v/:n.ts', async (req, res) => {
        const job = get(req.params.id);
        if (!job || !job.video) return res.status(404).send('cast expired');
        const src = job.video.segments[Number(req.params.n)];
        if (!src) return res.status(404).send('no such segment');
        try {
            const buf = await fetchBytes(src, job.video.headers);
            const out = await extractTrack(buf, job.video.videoIndex, 0);
            res.set('Content-Type', 'video/mp2t');
            res.set('Cache-Control', 'no-store');
            res.send(out);
        } catch (e) {
            console.error(`[cast] video segment ${job.id}/${req.params.n} failed: ${e.message}`);
            res.status(502).send('video split failed');
        }
    });

    load();
    keepalive();
    if (keepaliveMs > 0) setInterval(keepalive, keepaliveMs).unref();
    return { keepalive, jobs };
}

module.exports = { registerCastRoutes };
