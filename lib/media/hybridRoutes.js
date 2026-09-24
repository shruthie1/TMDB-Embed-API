// Serving the hybrid (video-from-A + audio-from-B) masters.
//
// Registered rather than bound at import, matching registerCastleDemuxRoutes,
// so the express app stays the composition root.
//
// WHY THE MASTER IS BUILT LAZILY
// Realising a pairing costs two playlist walks plus a segment download for the
// codec probe. Doing that for every candidate at /api/streams time would add
// several seconds to a listing the viewer may never play from. So the listing
// carries a cheap placeholder URL and the work happens on first request here.
//
// WHY JOBS EXPIRE
// Provider URLs are signed. showsst hands back `...&expire=1790026555088`, and
// Castle's carry an `auth_key`. A master built an hour ago points at segments
// that now 403, and the failure looks like a broken player rather than a stale
// token. Jobs are therefore short-lived and rebuilt rather than cached hard.

const hybrid = require('../../utils/hybridStream');
const ptsRebase = require('../../utils/ptsRebase');
const streamHeaders = require('./streamHeaders');
const tmdb = require('../../utils/tmdb');

// Shorter than the typical provider signature lifetime, so a job is replaced
// before its children start 403ing rather than after.
const JOB_TTL_MS = Number(process.env.HYBRID_JOB_TTL_MS) || 20 * 60 * 1000;

const jobs = new Map();

function putJob(id, value) {
    jobs.set(id, { at: Date.now(), value });
    // Opportunistic sweep: this map only grows on resolve, so there is no
    // separate timer to leak.
    for (const [key, entry] of jobs) {
        if (Date.now() - entry.at > JOB_TTL_MS) jobs.delete(key);
    }
}

function getJob(id) {
    const entry = jobs.get(id);
    if (!entry) return null;
    if (Date.now() - entry.at > JOB_TTL_MS) { jobs.delete(id); return null; }
    return entry.value;
}

function registerHybridRoutes(app) {
    app.get('/hybrid/:id/master.m3u8', async (req, res) => {
        const job = getJob(req.params.id);
        if (!job) {
            // 404 rather than a silent empty playlist: an expired job must be
            // visibly different from a title that has no hybrid, or a stale
            // link looks like a provider outage.
            res.status(404).set('Content-Type', 'application/vnd.apple.mpegurl');
            res.send('# hybrid expired - re-resolve the title\n');
            return;
        }
        // A realised playlist is reused for the life of the job; the expensive
        // part (codec probe) must not run per player retry.
        if (job.playlist) {
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-store');
            res.send(job.playlist);
            return;
        }
        try {
            const serverUrl = `${req.protocol}://${req.get('host')}`;
            const out = await hybrid.realisePlan(job.plan, serverUrl);
            if (!out) {
                res.status(502).send('# hybrid could not be built\n');
                return;
            }
            job.playlist = out.playlist;
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-store');
            res.send(out.playlist);
        } catch (e) {
            console.error('[hybrid] build failed:', e.message);
            res.status(502).send('# hybrid build error\n');
        }
    });
}


// Pair a VIEWER-CHOSEN video source with a viewer-chosen audio source.
//
// The old flow pre-computed pairings at /api/streams time and injected a fused
// "showsst+CastleTV" row into the source list. That multiplied the list by the
// number of languages and made the viewer read provider names to work out what
// each row meant. Since 2026-09-22 the player offers picture and language as
// two independent menus instead, and asks for the combination here once the
// viewer has actually picked one.
//
// POST because the two source urls are long and signed, and a GET would put
// them in a querystring that ends up in logs.
function registerPairRoute(app, deps = {}) {
    const hybridStream = deps.hybridStream || hybrid;
    app.post('/hybrid/pair', async (req, res) => {
        const raw = req.body || {};
        if (!raw.video?.url || !raw.audio?.url) {
            return res.status(400).json({ error: 'video.url and audio.url required' });
        }
        const { nudge } = raw;
        // Fill in the request headers the client could not send.
        //
        // pairSources() in web/lib/backend.js posts {url, provider, quality}
        // only, so a url that is fetchable ONLY with its provider's headers
        // arrived here bare. Measured 2026-09-23 on movie/1290190: mapple's
        // 2160p master returns 404 without Referer/Origin/UA, describeStream
        // therefore returned null for the video side, and the message below
        // blamed a runtime disagreement for what was a missing Referer. The
        // headers come from our own resolve, not from the caller - see
        // lib/media/streamHeaders.js for why that direction matters.
        const video = streamHeaders.withKnownHeaders(raw.video);
        const audio = streamHeaders.withKnownHeaders(raw.audio);

        // TMDB's stated runtime, when the caller told us which title this is.
        //
        // This is the same-film arbiter that lets a PADDED source pair - see
        // RUNTIME_MATCH_SECONDS in utils/hybridStream.js. Without it the only
        // same-film test is "the two sides agree with each other", which
        // refuses a 2160p source carrying an ad reel even when the audio is
        // the only Telugu track on the title.
        //
        // Best-effort on purpose: a TMDB outage must not take pairing down
        // with it. A failed lookup simply leaves the strict gate in charge,
        // which is exactly the behaviour that shipped before this.
        let runtimeSeconds = 0;
        if (raw.tmdbId) {
            try {
                const d = await tmdb.getDetails(raw.type === 'series' ? 'tv' : 'movie', raw.tmdbId);
                const mins = Number(d?.runtime)
                    || Number((d?.episode_run_time || [])[0]) || 0;
                runtimeSeconds = mins * 60;
            } catch (e) {
                console.warn(`[hybrid/pair] runtime lookup failed for ${raw.tmdbId}: ${e.message}`);
            }
        }
        try {
            // planPairings applies the duration gate, which is also the
            // wrong-film guard: CastleTV matches by TITLE, so a pairing whose
            // two halves disagree on runtime is very likely two different
            // films. Refusing is better than playing a mismatch.
            const plans = await hybridStream.planPairings([video, audio], { runtimeSeconds });
            const plan = plans[0];
            if (plan && Number(nudge)) plan.nudge = Number(nudge);
            if (!plan) {
                // Say WHICH gate refused, and by how much.
                //
                // One sentence covering both causes meant the only way to tell
                // a runtime mismatch from a missing audio track was to re-run
                // describeStream by hand. Measured 2026-09-22 on movie/1355228:
                // mapple 7330.93s vs CastleTV 7008.29s, a 322.64s gap - the two
                // providers genuinely ship different cuts, which the opaque
                // message made look like a bug in the pairing code.
                //
                // Re-describing here costs two manifest fetches on a path that
                // has already failed, and only on the failure path.
                const diag = await Promise.all([video, audio].map(
                    (s) => hybridStream.describeStream(s).catch(() => null),
                ));
                const [dv, da] = diag;
                const detail = {};
                let why;
                if (!dv || !da) {
                    // Name WHICH side could not be read, and whether we had
                    // headers for it. "could not re-measure" alone sent this
                    // investigation down a duration-mismatch path for a url
                    // that was simply 404ing for want of a Referer.
                    const side = !dv && !da ? 'neither source' : (!dv ? 'the video source' : 'the audio source');
                    const bare = [!dv && video, !da && audio].filter(Boolean)
                        .filter((st) => !Object.keys(st.headers || {}).length).length;
                    // Re-describing can legitimately fail where the first pass
                    // succeeded: these are SIGNED, short-lived CDN urls, and the
                    // diagnostic runs seconds after planPairings already spent
                    // them. Measured 2026-09-22 - the refetch returned null and
                    // an earlier version of this branch then reported "no audio
                    // renditions" for a source that had just described 4 of
                    // them. Never state a cause the second look cannot support.
                    why = `${side} could not be read back`
                        + (bare ? ' and we hold no request headers for it, so a'
                            + ' provider that requires them will have refused'
                            : ' (its signed url may have expired)')
                        + '; the runtime and audio-rendition gates were never reached';
                    detail.unreadable = side;
                    detail.missingHeaders = bare > 0;
                } else {
                    detail.videoSeconds = Math.round(dv.seconds);
                    detail.audioSeconds = Math.round(da.seconds);
                    detail.deltaSeconds = Math.round(Math.abs(dv.seconds - da.seconds));
                    detail.audioRenditions = da.audio ? da.audio.renditions.length : 0;
                    if (!da.audio) {
                        why = 'the audio source carries no switchable audio renditions';
                    } else {
                        why = `the two sources are different cuts: ${detail.deltaSeconds}s apart`
                            + (runtimeSeconds
                                ? ` (TMDB runtime ${Math.round(runtimeSeconds)}s vouched for neither`
                                  + ' closely enough to allow padding)'
                                : ' (no TMDB runtime was supplied, so padding could not be allowed)');
                    }
                }
                console.warn(`[hybrid/pair] refused: ${why}`, detail);
                return res.status(409).json({ error: 'not pairable', reason: why, ...detail });
            }
            const id = hybridStream.planId(plan);
            putJob(id, { plan, playlist: null });
            const serverUrl = `${req.protocol}://${req.get('host')}`;
            res.json({ url: `${serverUrl}/hybrid/${id}/master.m3u8`,
                delta: plan.delta, nudge: Number(nudge) || 0,
                // True = the two halves are the same film but differently
                // padded, so the automatic PTS probe (encoder baseline only)
                // cannot close the gap and the viewer may need the Audio
                // timing bar. The UI should say so rather than let them
                // discover the drift.
                padded: Boolean(plan.padded), runtimeSeconds });
        } catch (e) {
            console.error('[hybrid/pair] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });
}

// Rebase ANY provider's audio segment onto the video provider's timeline.
//
// castle-demux has its own `?pts=` because it is already running ffmpeg per
// segment to split the tracks, so the shift is free there. This route is for
// every OTHER audio source - NetMirror, or whatever ships EXT-X-MEDIA
// renditions next - whose segments are served untouched by m3u8-proxy and had
// no way to be shifted at all. Without it those pairings desync silently, the
// same way Castle did before 2026-09-22.
//
// Deliberately NOT folded into ts-proxy: that handler streams with range
// requests and tail prefetch, while a timestamp shift needs the whole segment
// in hand. Keeping them apart leaves the fast path untouched.
function registerRebaseRoute(app, deps = {}) {
    const fetchImpl = deps.fetch || globalThis.fetch;
    app.get('/pts-rebase', async (req, res) => {
        const url = req.query.url;
        if (!url) return res.status(400).send('url required');
        const offset = ptsRebase.ptsFromQuery(req.query);
        let headers = {};
        try { headers = JSON.parse(req.query.headers || '{}'); } catch { /* unsigned */ }
        try {
            const upstream = await fetchImpl(url, { headers });
            if (!upstream.ok) return res.status(upstream.status).send('upstream failed');
            const raw = Buffer.from(await upstream.arrayBuffer());
            const out = await ptsRebase.rebaseSegment(raw, offset);
            res.set('Content-Type', 'video/mp2t');
            res.set('Cache-Control', 'no-store');
            res.set('Access-Control-Allow-Origin', '*');
            res.send(out);
        } catch (e) {
            console.error('[pts-rebase] failed:', e.message);
            res.status(502).send('rebase failed');
        }
    });
}

module.exports = {
    registerHybridRoutes, registerRebaseRoute, registerPairRoute, putJob, getJob, JOB_TTL_MS, _jobs: jobs,
};
