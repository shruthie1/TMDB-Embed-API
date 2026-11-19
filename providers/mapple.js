// mapple - the only source measured carrying a 2160p ladder.
//
// The VM resolver in the `ott` repo launches Chromium for this (~13s) purely to
// sniff a `requestToken` off the wire, on the assumption the page mints it in
// JS. It does not: `POST /api/request-token` hands it over on plain HTTP.
// Measured 2026-09-22 - bootstrap 871/545/506ms across three runs against
// ~13s with a browser, so no browser is used here.
//
// THE CHAIN (all four steps are required; skipping any returns a 200 with an
// unusable body, which is what made this look like a fingerprint gate):
//   1. GET  /watch/<type>/<id>      -> sets _mapple_site cookies
//   2. POST /api/request-token      -> requestToken
//   3. POST /api/playback-init      -> streamToken, sometimes behind a PoW
//   4. POST /api/encrypt            -> a signed path, then GET it for the m3u8
//
// TRAPS, each one measured the hard way:
//   - The key is `mediaId`, NOT `tmdbId`. A wrong key returns 400
//     "Unsupported encryption request".
//   - `requestToken` must be at the TOP LEVEL of the /api/encrypt body as well
//     as inside `data`. Omitting the top-level copy still returns 200, but the
//     blob it hands back resolves to `playback-unavailable`.
//   - The PoW nonce is nested under `pow:{challengeId, nonce}` and sent as a
//     STRING. Flat `challengeId`/`nonce` is silently re-challenged forever.
//   - `source:"mapple"` is only the DEFAULT front. mapple fans out to backends
//     named s1..s25 and any given title sits on some subset, so a single-front
//     lookup reports "not available" for titles that are plainly there. 1408162
//     only appears on s9.

const { createHash } = require('crypto');
const hls = require('../lib/media/hlsManifest');

const BASE = process.env.MAPPLE_BASE || 'https://mapple.fun';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// Session (cookies + requestToken) is reusable across titles. Re-bootstrapping
// per request wasted ~500ms each time for no benefit.
// mapple.fun renamed two endpoints by 2026-11-15 (read from its
// /_next/static chunks): /api/request-token -> /api/ui/session and
// /api/playback-init -> /api/media-session. The old init path answered 401
// "Invalid request token", so mapple returned 0 on every title (14/14 bench).
const REQUEST_TOKEN_PATH = process.env.MAPPLE_REQUEST_TOKEN_PATH || '/api/ui/session';
const PLAYBACK_INIT_PATH = process.env.MAPPLE_PLAYBACK_INIT_PATH || '/api/media-session';

const SESSION_TTL_MS = Number(process.env.MAPPLE_SESSION_TTL_MS) || 10 * 60 * 1000;

// Fronts ordered by how often they actually carried a title in the sweep, so a
// hit usually lands in the first few and the rest are never paid for. The
// unranked tail is still tried - it is the difference between "not available"
// and a stream for the long tail of titles.
const RANKED = [9, 4, 17, 2, 25, 3, 5, 6, 10, 12, 19, 1, 24];
const UNSEEN = [7, 8, 11, 13, 14, 15, 16, 18, 20, 21, 22, 23];
const SOURCES = ['mapple', ...[...RANKED, ...UNSEEN].map((n) => `s${n}`)];

// A whole-sweep ceiling. 25 fronts x a slow one each would otherwise hold the
// aggregate stream request open far past the point the UI has given up.
const SWEEP_BUDGET_MS = Number(process.env.MAPPLE_SWEEP_BUDGET_MS) || 12000;
const STEP_TIMEOUT_MS = Number(process.env.MAPPLE_STEP_TIMEOUT_MS) || 8000;

// readLadder runs after a front already gave a stream, so it must never cost
// that row. The registry drops the whole provider at PROVIDER_DEADLINE_MS
// (20000). Three 8s steps in a row (master, media playlist, init segment) could
// reach 24s. So every readLadder step is cut to the time left before the
// registry deadline minus a margin, and the codec probe gets at most
// PROBE_BUDGET_MS for both of its fetches together. Read from env, not
// required from registry.js, because registry.js requires this file.
const REGISTRY_DEADLINE_MS = Number(process.env.PROVIDER_DEADLINE_MS) || 20000;
const DEADLINE_MARGIN_MS = Number(process.env.MAPPLE_DEADLINE_MARGIN_MS) || 2000;
const PROBE_BUDGET_MS = Number(process.env.MAPPLE_PROBE_BUDGET_MS) || 2000;
// Below this, the probe is skipped: the row ships with videoCodec null.
const PROBE_MIN_MS = 300;

let session = null; // { jar: Map, requestToken, at }
let inFlight = null; // single-flight, so a burst of titles bootstraps once

function streamHeaders() {
    return { 'User-Agent': UA, Referer: `${BASE}/`, Origin: BASE };
}

// difficulty is LEADING ZERO BITS, not hex characters. Read off their own
// /pow-worker.js. At difficulty 18 this costs 72-176ms in plain Node.
function solvePow(challenge, difficulty, max = 20000000) {
    for (let n = 0; n < max; n++) {
        const d = createHash('sha256').update(challenge + n).digest();
        let bits = 0;
        for (const x of d) {
            if (x === 0) { bits += 8; continue; }
            bits += Math.clz32(x) - 24;
            break;
        }
        if (bits >= difficulty) return String(n);
    }
    return null;
}

function cookieHeader(jar) {
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorb(jar, res) {
    for (const c of (res.headers.getSetCookie?.() || [])) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
}

async function go(jar, url, opt = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), STEP_TIMEOUT_MS);
    try {
        const r = await fetch(url, {
            ...opt,
            signal: ac.signal,
            headers: {
                'user-agent': UA,
                origin: BASE,
                referer: `${BASE}/`,
                ...(opt.headers || {}),
                ...(jar.size ? { cookie: cookieHeader(jar) } : {}),
            },
            redirect: 'manual',
        });
        absorb(jar, r);
        return r;
    } finally {
        clearTimeout(timer);
    }
}

async function json(res) {
    try { return await res.json(); } catch { return null; }
}

async function bootstrap(mediaType, mediaId) {
    const jar = new Map();
    await go(jar, `${BASE}/watch/${mediaType}/${mediaId}`);
    const rt = await json(await go(jar, `${BASE}${REQUEST_TOKEN_PATH}`, {
        method: 'POST', headers: { accept: 'application/json' },
    }));
    if (!rt?.token) throw new Error('no requestToken');
    return { jar, requestToken: rt.token, at: Date.now() };
}

async function getSession(mediaType, mediaId) {
    if (session && Date.now() - session.at < SESSION_TTL_MS) return session;
    if (inFlight) return inFlight;
    inFlight = bootstrap(mediaType, mediaId)
        .then((s) => { session = s; return s; })
        .finally(() => { inFlight = null; });
    return inFlight;
}

// Pull the ladder out of the master so the UI can show a real quality menu and
// so a 2160p title is visibly 2160p rather than "Auto".
//
// The same fetch also checks the master is playable. Prod 2026-11-19, 1376856
// (The Paradise): a front answered with a stream_url whose master body was
// only "#EXTM3U" (8 bytes). That row cannot play but was still offered, so it
// is now treated like `playback-unavailable` and the sweep moves on.
// `empty` is true only when a body was read and has neither tag. A failed or
// timed-out fetch says nothing about the stream, so the row is kept.
function isEmptyPlaylist(text) {
    return !/#EXT-X-STREAM-INF/i.test(text) && !/#EXTINF/i.test(text);
}

// `signal`, when given, is a caller's shared budget (the codec probe) and
// replaces the per-step timer.
async function fetchStep(url, asBytes = false, timeoutMs = STEP_TIMEOUT_MS, signal = null) {
    const ac = signal ? null : new AbortController();
    const timer = ac && setTimeout(() => ac.abort(), timeoutMs);
    try {
        const r = await fetch(url, { headers: streamHeaders(), signal: signal || ac.signal });
        if (!r.ok) return null;
        return asBytes ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// The video codec, when the master does not state it. Prod 2026-11-19, The
// Paradise (1376856): the s4 master had no CODECS attribute, its fMP4 init
// segment held hev1/hvcC, and Chrome on Android (no HEVC in MediaSource)
// played the audio over a black screen with no error. Reads the top variant
// and its #EXT-X-MAP init segment (3248 bytes on that title). Any failure
// answers null ("unknown"), never a guess. Both fetches share one budget of
// `budgetMs`, so a slow init segment cannot hold the row.
async function probeVideoCodec(levels, masterUrl, budgetMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budgetMs);
    try {
        const top = levels.find((l) => l.url);
        if (!top) return null;
        const media = await fetchStep(hls.resolveUri(top.url, masterUrl), false, budgetMs, ac.signal);
        const init = media && hls.mapUri(media, hls.resolveUri(top.url, masterUrl));
        if (!init) return null;
        const bytes = await fetchStep(init, true, budgetMs, ac.signal);
        return bytes ? hls.initVideoCodec(bytes) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// `deadline` is the epoch ms after which this provider call must be done.
async function readLadder(url, deadline = Date.now() + REGISTRY_DEADLINE_MS - DEADLINE_MARGIN_MS) {
    try {
        const masterMs = Math.min(STEP_TIMEOUT_MS, deadline - Date.now());
        if (masterMs <= 0) return { levels: [], empty: false };
        const text = await fetchStep(url, false, masterMs);
        if (text == null) return { levels: [], empty: false };
        if (isEmptyPlaylist(text)) return { levels: [], empty: true, bytes: text.length };
        // parseLevels also reads CODECS, so a row can say it is HEVC and a
        // browser without HEVC decode can skip it (see videoCodecFamily).
        const parsed = hls.parseLevels(text, url);
        const levels = parsed
            .filter((l) => Number.isFinite(l.height) && l.height > 0)
            .map((l) => ({ height: l.height, bandwidth: l.bandwidth, codecs: l.codecs }));
        const codecs = hls.masterCodecs(text);
        let videoCodec = hls.videoCodecFamily(codecs);
        const probeMs = Math.min(PROBE_BUDGET_MS, deadline - Date.now());
        if (!videoCodec && probeMs >= PROBE_MIN_MS) videoCodec = await probeVideoCodec(parsed, url, probeMs);
        return { levels, empty: false, codecs, videoCodec: videoCodec || null };
    } catch {
        return { levels: [], empty: false };
    }
}

async function getMappleStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
    const mediaId = String(tmdbId);
    const type = mediaType === 'movie' ? 'movie' : 'tv';
    const t0 = Date.now();

    try {
        const { jar, requestToken } = await getSession(type, mediaId);

        const base = { mediaId, mediaType: type, tv_slug: '', requestToken };
        if (type === 'tv' && seasonNum != null) {
            base.season = Number(seasonNum);
            base.episode = Number(episodeNum);
        }

        let init = await json(await go(jar, `${BASE}${PLAYBACK_INIT_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(base),
        }));

        if (init?.requiresPow) {
            const nonce = solvePow(init.pow.challenge, init.pow.difficulty);
            if (!nonce) { console.warn(`[mapple] PoW unsolved for ${tmdbId}`); return []; }
            init = await json(await go(jar, `${BASE}${PLAYBACK_INIT_PATH}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...base,
                    pow: { challengeId: init.pow.challengeId, nonce },
                }),
            }));
        }

        if (!init?.token) {
            console.warn(`[mapple] no streamToken for ${tmdbId}`);
            return [];
        }

        for (const source of SOURCES) {
            if (Date.now() - t0 > SWEEP_BUDGET_MS) {
                console.warn(`[mapple] sweep budget hit for ${tmdbId} at ${source}`);
                break;
            }

            const data = { mediaId, mediaType: type, tv_slug: '', source };
            if (base.season != null) { data.season = base.season; data.episode = base.episode; }

            const enc = await json(await go(jar, `${BASE}/api/encrypt`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // requestToken twice, deliberately - see the header note.
                body: JSON.stringify({ data, endpoint: 'stream-encrypted', requestToken }),
            }));
            if (!enc?.url) continue;

            const signed = `${BASE}${enc.url}`
                + `&requestToken=${encodeURIComponent(requestToken)}`
                + `&token=${encodeURIComponent(init.token)}`;
            const out = await json(await go(jar, signed, { headers: { accept: 'application/json' } }));

            const streamUrl = out?.data?.stream_url || '';
            // `playback-unavailable` is mapple's in-band "this front does not
            // have it" - a 200 with a placeholder url, not an error status.
            if (!streamUrl || streamUrl.includes('playback-unavailable')) continue;

            const { levels, empty, bytes, codecs = null, videoCodec = null } = await readLadder(streamUrl, t0 + REGISTRY_DEADLINE_MS - DEADLINE_MARGIN_MS);
            if (empty) {
                console.warn(`[mapple] ${tmdbId} on ${source}: empty master (${bytes}B), trying next front`);
                continue;
            }
            const best = levels.length ? Math.max(...levels.map((l) => l.height)) : 0;

            console.log(`[mapple] ${tmdbId} on ${source} in ${Date.now() - t0}ms`
                + (best ? ` (${best}p)` : '') + (videoCodec ? ` ${videoCodec}` : ''));

            return [{
                url: streamUrl,
                provider: 'mapple',
                // mapple serves one video ladder with no switchable audio
                // renditions. Claiming a language would be inventing one, and
                // the audio menu must not offer a switch that does nothing.
                languages: [],
                selectableAudio: false,
                levels,
                codecs,
                videoCodec,
                container: 'hls',
                headers: streamHeaders(),
                title: source === 'mapple' ? 'mapple' : `mapple · ${source}`,
            }];
        }

        console.log(`[mapple] no front carried ${tmdbId} (${Date.now() - t0}ms)`);
        return [];
    } catch (e) {
        // A dead session is the common failure; drop it so the next request
        // re-bootstraps rather than replaying a stale token forever.
        session = null;

        // Name TLS interception rather than letting it read as "mapple is
        // down". Measured 2026-09-22 on this network: mapple.fun's leaf came
        // back issued by "CN=FG4H0FT922902630, O=Fortinet" while google.com and
        // api.themoviedb.org kept their real issuers - so a middlebox is
        // re-signing THIS domain only, and node rejects the forged chain with
        // UNABLE_TO_VERIFY_LEAF_SIGNATURE after ~220ms. Nothing in this file
        // can fix that; the operator has to trust the CA or exempt the domain.
        const code = e?.cause?.code || e?.code;
        if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
            || code === 'SELF_SIGNED_CERT_IN_CHAIN'
            || code === 'CERT_HAS_EXPIRED') {
            console.error(`[mapple] TLS interception blocking ${BASE} (${code}).`
                + ' A middlebox is re-signing this domain; mapple cannot be reached'
                + ' until its CA is trusted or the domain is exempted.');
            return [];
        }
        console.error(`[mapple] error for ${tmdbId}:`, e.message, code || '');
        return [];
    }
}

module.exports = { REQUEST_TOKEN_PATH, isEmptyPlaylist, PLAYBACK_INIT_PATH, getMappleStreams, solvePow, SOURCES, BASE, streamHeaders };
