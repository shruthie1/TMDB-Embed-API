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

const BASE = process.env.MAPPLE_BASE || 'https://mapple.fun';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// Session (cookies + requestToken) is reusable across titles. Re-bootstrapping
// per request wasted ~500ms each time for no benefit.
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
    const rt = await json(await go(jar, `${BASE}/api/request-token`, {
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
async function readLadder(url) {
    try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), STEP_TIMEOUT_MS);
        const r = await fetch(url, { headers: streamHeaders(), signal: ac.signal })
            .finally(() => clearTimeout(timer));
        if (!r.ok) return [];
        const text = await r.text();
        const levels = [];
        const re = /RESOLUTION=(\d+)x(\d+)[^\n]*/g;
        const bw = /BANDWIDTH=(\d+)/;
        let m;
        while ((m = re.exec(text)) !== null) {
            const height = Number(m[2]);
            const b = m[0].match(bw);
            if (Number.isFinite(height) && height > 0) {
                levels.push({ height, bandwidth: b ? Number(b[1]) : null });
            }
        }
        return levels;
    } catch {
        return [];
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

        let init = await json(await go(jar, `${BASE}/api/playback-init`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(base),
        }));

        if (init?.requiresPow) {
            const nonce = solvePow(init.pow.challenge, init.pow.difficulty);
            if (!nonce) { console.warn(`[mapple] PoW unsolved for ${tmdbId}`); return []; }
            init = await json(await go(jar, `${BASE}/api/playback-init`, {
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

            const levels = await readLadder(streamUrl);
            const best = levels.length ? Math.max(...levels.map((l) => l.height)) : 0;

            console.log(`[mapple] ${tmdbId} on ${source} in ${Date.now() - t0}ms`
                + (best ? ` (${best}p)` : ''));

            return [{
                url: streamUrl,
                provider: 'mapple',
                // mapple serves one video ladder with no switchable audio
                // renditions. Claiming a language would be inventing one, and
                // the audio menu must not offer a switch that does nothing.
                languages: [],
                selectableAudio: false,
                levels,
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

module.exports = { getMappleStreams, solvePow, SOURCES, BASE, streamHeaders };
