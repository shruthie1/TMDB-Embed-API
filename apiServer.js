require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { requireAuth, getSession } = require('./utils/auth');
const { registerAuthRoutes } = require('./routes/auth');
const path = require('path');
const { paths: appPaths } = require('./lib/runtime/paths');
const { metrics, recordProviderOutcome, breakerOpen, requestCounter } = require('./lib/runtime/metrics');
const runtime = require('./lib/runtime/environment');
const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
const { QUALITIES: STREAM_QUALITIES, normaliseStream, normaliseStreams } = require('./utils/streamSchema');
const { resolveMany } = require('./lib/media/capabilities');
const streamHeaders = require('./lib/media/streamHeaders');
const { registerCapabilityRoutes } = require('./routes/capabilities');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId, searchTitles } = require('./utils/tmdb');
const { applyFilters } = require('./utils/streamFilters');
const castleDemux = require('./utils/castleDemux');

const app = express();
app.set('trust proxy', 1);
const { publicBase } = require('./lib/runtime/publicBase');
const { requestIdMiddleware, patchConsole } = require('./lib/runtime/requestId');
const { createRateLimit } = require('./lib/runtime/rateLimit');
const { installGracefulShutdown } = require('./lib/runtime/shutdown');
const { checkStartupConfig } = require('./lib/runtime/startupCheck');

// Every log line a request causes carries its id (see lib/runtime/requestId).
patchConsole();
app.use(requestIdMiddleware);

// Per-IP limit on the open media proxy routes, mounted before them.
const proxyRateLimit = createRateLimit({
  max: process.env.PROXY_RATE_LIMIT_PER_MIN === undefined ? 600 : Number(process.env.PROXY_RATE_LIMIT_PER_MIN) || 0,
});
app.use(['/m3u8-proxy', '/ts-proxy', '/sub-proxy'], proxyRateLimit);

// Mount proxy routes early so downstream handlers can use them.
//
// `enableProxy` is a ROUTING policy - "send every stream through our proxy" -
// and it is off by default because the proxy costs 13-22x in latency and
// inflates bodies ~6x (measured 2026-09-23 across CastleTV/showsst). It is NOT
// a statement about whether the endpoint should exist.
//
// The two were the same switch until 2026-09-23, and unmounting the endpoint
// broke every hybrid pairing: a fused master pairs a remote picture with local
// audio, and the remote variant MUST go through /m3u8-proxy because a browser
// cannot set the `Referer: https://mapple.fun/` that the origin demands. With
// the routes unmounted that variant returned:
//
//   video variant HTTP 404 149b   Cannot GET /m3u8-proxy
//   telugu audio  HTTP 200 312696b
//
// - an unplayable master with perfectly good audio. So the endpoint is always
// available, and `enableProxy` now only decides whether ORDINARY streams are
// rewritten to use it (see processStreamsForProxy below).
createProxyRoutes(app);
console.log(config.enableProxy
  ? '[startup] proxy routes mounted; enableProxy on: all streams routed through them'
  : '[startup] proxy routes mounted for hybrid pairing; enableProxy off: ordinary streams direct');

// Guard against premature process.exit from imported legacy modules, but allow controlled restarts
const realProcessExit = process.exit.bind(process);
let allowControlledExit = false;
process.exit = function(code){
  if (allowControlledExit) return realProcessExit(code);
  console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
  // keep process alive for debugging
};
setImmediate(()=>console.log('[diagnostic] post-start setImmediate fired'));
app.use(cors());
app.use(express.json());
// Auth routes + login rate limiting live in routes/auth.js.
registerAuthRoutes(app);

// Protect config panel (HTML) explicitly before static middleware
app.get('/config.html', (req,res,next) => {
  const sess = getSession(req);
  if (!sess) return res.redirect(302, '/');
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(appPaths.public,'config.html'));
});

// Explicit root handler for login page to ensure no-store
app.get('/', (req,res) => {
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(appPaths.public,'index.html'));
});

// Diagnostics for unexpected exits
process.on('beforeExit', (code) => {
  console.log('[diagnostic] beforeExit code=', code);
});
process.on('exit', (code) => {
  console.log('[diagnostic] exit code=', code);
});
// Logged and counted, not fatal: one provider's stray rejection must not take
// down every viewer's stream. /api/health reports the counts.
const processErrors = { uncaughtException: 0, unhandledRejection: 0, last: null };
process.on('uncaughtException', (err) => {
  processErrors.uncaughtException++;
  processErrors.last = { kind: 'uncaughtException', at: new Date().toISOString(), message: String(err && err.message || err).slice(0, 300) };
  console.error('[diagnostic] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  processErrors.unhandledRejection++;
  processErrors.last = { kind: 'unhandledRejection', at: new Date().toISOString(), message: String(reason && reason.message || reason).slice(0, 300) };
  console.error('[diagnostic] unhandledRejection', reason);
});


// --- Metrics (in-memory) ---

app.use(requestCounter);
// Serve static UI (login page at /)
// Default static serving sends an ETag with max-age=0, so the browser
// revalidates and gets a 304 - it keeps running the OLD file. During a
// debugging session that silently discards every client-side change: the
// console keeps printing the previous build's log lines and you chase a bug
// in code that is not running. etag/lastModified off + no-store makes a
// reload actually fetch the file.
app.use(express.static(appPaths.public, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// Config API
app.get('/api/config', requireAuth, (req,res) => {
  const fs = require('fs');
  let override = {};
  try { if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH,'utf8')); } catch (e) {
    // ignore JSON parse or fs errors reading override; return base config
  }
  res.json({ success:true, merged: config, override, overridePath: OVERRIDE_PATH });
});
app.post('/api/config', requireAuth, (req,res) => {
  const patch = req.body || {};
  if (patch.port) {
    const p = Number(patch.port); if (!Number.isFinite(p) || p<=0 || p>65535) return res.status(400).json({ success:false, error:'INVALID_PORT'});
    patch.port = p;
  }
  if (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) return res.status(400).json({ success:false, error:'DEFAULT_PROVIDERS_NOT_ARRAY'});
  const ok = saveConfigPatch(patch);
  res.json({ success: ok, merged: config });
});

// Restart endpoint (requires auth via session cookie on /config.html UI)
app.post('/api/restart', (req,res) => {
  const sess = getSession(req);
  if(!sess) return res.status(401).json({ success:false, error:'UNAUTHORIZED' });
  res.json({ success:true, message:'RESTARTING' });
  // Give the response a moment to flush
  setTimeout(()=>{
    try {
      const fs = require('fs');
      // The marker exists only to make nodemon restart a long-lived local
      // process. On serverless there is no process to restart and the bundle
      // is read-only, so writing it would just throw.
      if (runtime.features.configPersistence) {
        const restartMarker = require('path').join(appPaths.root, 'restart.trigger');
        fs.writeFileSync(restartMarker, String(Date.now()));
        console.warn('[control] wrote restart.trigger to notify nodemon');
      } else {
        console.warn('[control] restart marker skipped: no persistent filesystem in this runtime');
      }
    } catch (e) {
      console.warn('[control] failed to write restart marker:', e.message);
    }
    console.warn('[control] restarting process by exit(0)');
    // Let nodemon detect the file change and restart the app
    allowControlledExit = true;
    realProcessExit(0);
  }, 300);
});

// --- Basic informational endpoints ---
// --- Basic informational endpoints ---

app.get('/api/health', (req, res) => {
  const now = Date.now();
  const mem = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  const breakers = {};
  for (const [name, h] of Object.entries(metrics.providerHealth || {})) {
    const open = Boolean(h.trippedUntil && now < h.trippedUntil);
    breakers[name] = { open, consecutiveMisses: h.consecutiveMisses || 0, trips: h.trips || 0,
      ...(open ? { reopensInS: Math.ceil((h.trippedUntil - now) / 1000) } : {}) };
  }
  res.json({
    ok: true, service: 'tmdb-embed-api', time: new Date().toISOString(),
    uptimeS: Math.round(process.uptime()),
    memory: { rssMB: mb(mem.rss), heapUsedMB: mb(mem.heapUsed), heapTotalMB: mb(mem.heapTotal) },
    openBreakers: Object.keys(breakers).filter((n) => breakers[n].open),
    breakers,
    processErrors,
  });
});

// Server-side catalogue search; the TMDB key never reaches the browser.
app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const type = ['movie', 'series', 'all'].includes(req.query.type) ? req.query.type : 'all';
  if (query.length < 2) return res.status(400).json({ success: false, error: 'QUERY_TOO_SHORT' });
  try {
    const results = await searchTitles(query, type);
    res.json({ success: true, query, type, results });
  } catch (error) {
    const missingKey = /TMDB_API_KEY missing/i.test(error.message);
    res.status(missingKey ? 503 : 502).json({ success: false, error: missingKey ? 'TMDB_API_KEY_MISSING' : 'TMDB_SEARCH_FAILED' });
  }
});

// Metrics endpoint
app.get('/api/metrics', (req,res) => {
  res.json({
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024),
    loadAvg: os.loadavg ? os.loadavg() : [],
    nodeVersion: process.version,
    configDefaults: {
      region: config.defaultRegion,
      providers: config.defaultProviders,
      minQualities: config.minQualities ? Object.keys(config.minQualities).length : 0,
      excludeCodecs: config.excludeCodecs ? Object.keys(config.excludeCodecs).filter(k=>config.excludeCodecs[k]).length : 0,
      febboxCookies: config.febboxCookies.length
    }
  });
});

// Consolidated status (metrics + providers + endpoints)
app.get('/api/status', (req,res) => {
  const endpoints = [
    'GET /api/health',
    'GET /api/metrics',
    'GET /api/status',
    'GET /api/providers',
    'GET /api/providers/:name',
    'GET /api/streams/:type/:tmdbId',
    'GET /api/streams/:provider/:type/:tmdbId',
    'POST /api/config',
    'GET /api/config'
  ];
  // Determine cookie requirement heuristically (currently Showbox / PStream)
  const cookieRequiredProviders = new Set(['showbox']);
  const providers = listProviders().map(p => {
    const cookieRequired = cookieRequiredProviders.has(p.name);
    const cookieOk = !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0);
    const h = metrics.providerHealth[p.name] || null;
    // A verdict, not raw counters: the point is that "called 40 times, returned
    // nothing 40 times" should read as dead at a glance.
    let verdict = 'unknown';
    if (h) {
      const calls = h.hit + h.empty + h.error + h.timeout;
      if (!calls) verdict = 'unknown';
      else if (h.hit === 0 && h.error + h.timeout > 0) verdict = 'failing';
      else if (h.hit === 0) verdict = 'dead';
      else if (h.hit / calls < 0.5) verdict = 'degraded';
      else verdict = 'healthy';
    }
    return { name: p.name, enabled: p.enabled, cookieRequired, cookieOk, verdict, health: h };
  });
  res.json({ success:true, providerCheckTmdbId: config.providerCheckTmdbId, metrics: {
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024),
    providerHealth: metrics.providerHealth
  }, endpoints, providers });
});

// Playback capability routes (quality + audio menus) live in
// routes/capabilities.js.
registerCapabilityRoutes(app);

// Providers list
app.get('/api/providers', (req,res) => {
  res.json({ success: true, providers: listProviders() });
});

// Debug environment/config endpoint (do not expose publicly in production)
app.get('/api/debug/env', requireAuth, (req,res) => {
  const cookieStats = getCookieStats ? getCookieStats() : null;
  res.json({
    port: config.port,
    defaultProviders: config.defaultProviders,
    febboxCookieCount: config.febboxCookies.length,
    showboxCacheDir: process.env.SHOWBOX_CACHE_DIR || '(os tmp)',
    nodeVersion: process.version,
    cookieStats
  });
});

// Single provider info
app.get('/api/providers/:name', (req,res) => {
  const p = getProvider(req.params.name);
  if (!p) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  res.json({ success:true, provider:{ name: p.name, enabled: p.enabled } });
});

// Aggregate streams across all enabled providers.
//
// Deadline model (one of each):
// - Per provider: PROVIDER_DEADLINE_MS in providers/registry.js (20s). An
//   overrun yields [] marked `timedOut`, recorded as a 'timeout' outcome.
//   This replaces a second 45s race here that could never fire before the
//   registry's 20s one.
// - Per request: the response waits for PRIMARY_PROVIDERS (the ones the web
//   player actually plays: castletv, netmirror) and gives the rest
//   SECONDARY_GRACE_MS more. A secondary still running then keeps going in the
//   background and fills providerHitCache, so the next request for the title
//   gets it at once. If nothing at all came back, the response waits for them.
// Off by default: with PRIMARY_PROVIDERS unset every provider counts as
// primary and the response waits for all of them (each still capped by the
// 20s deadline). Set PRIMARY_PROVIDERS=castletv,netmirror to turn the early
// answer on.
const PRIMARY_LIST = (process.env.PRIMARY_PROVIDERS || '')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const isPrimary = (name) => PRIMARY_LIST.length === 0 || PRIMARY_LIST.includes(name);
const SECONDARY_GRACE_MS = Number(process.env.SECONDARY_GRACE_MS) || 1500;
// Once a preferred-language stream exists, how long the rest get before the
// answer goes out without them. Short: they keep running in the background.
const FIRST_ANSWER_GRACE_MS = Number(process.env.FIRST_ANSWER_GRACE_MS) || 400;

// Per-provider result caches, keyed provider|title. Separate from the breaker:
// the breaker is about a provider's health, these are about one title.
// - hits: a provider's raw streams for 10 min (signed URLs outlive that).
// - empties: a provider that had nothing for a title is not asked again for
//   PROVIDER_EMPTY_TTL_MS. Kept short because an empty can be a transient
//   upstream failure (NetMirror reports resets as empty). ?refresh=1 skips both.
const { createTtlCache } = require('./lib/runtime/ttlCache');
const providerHitCache = createTtlCache({
  ttlMs: Number(process.env.PROVIDER_HIT_TTL_MS) || 10 * 60 * 1000, maxEntries: 2000 });
const providerEmptyCache = createTtlCache({
  ttlMs: Number(process.env.PROVIDER_EMPTY_TTL_MS) || 3 * 60 * 1000, maxEntries: 5000 });

// How long a browser may reuse an /api/streams response. Short enough that a
// title's streams stay fresh and signed URLs stay valid, long enough to absorb
// reloads and back-navigation during normal browsing.
const STREAMS_CACHE_SECONDS = Number(process.env.STREAMS_CACHE_SECONDS) || 300;

// Server-side result cache. The Cache-Control header below already stops ONE
// browser re-requesting, but it does nothing for a second client, a reload with
// devtools open, or the player asking again after a restart - each of those
// replayed the whole provider fan-out. Measured 2026-09-21: a cold aggregate
// call is 2.8-6.3s, almost all of it upstream wait.
//
// TTL is deliberately far under the upstream signature lifetime. Castle's
// `expire=` sits 180 min out, so a 10 min entry cannot outlive the URLs it
// holds. Keyed per title+episode; the payload carries signed per-session URLs,
// so this Map must stay process-local and never be shared between users.
const STREAMS_MEMO_MS = Number(process.env.STREAMS_MEMO_MS) || 10 * 60 * 1000;
// Capped: an unbounded Map grew with every distinct title+episode requested.
const streamsMemo = createTtlCache({
  ttlMs: STREAMS_MEMO_MS, maxEntries: Number(process.env.STREAMS_MEMO_MAX) || 500 });

// `withCaps` is part of the key: the two variants return different payloads for
// the same title, so sharing one entry would serve a capabilities response to a
// plain caller (and, worse, a plain one to a UI that needs the ladders).
function memoKey(type, tmdbId, season, episode, withCaps) {
  return `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}:${withCaps ? 'caps' : 'plain'}`;
}
function memoGet(key) {
  return streamsMemo.get(key) || null;
}
function memoSet(key, payload) {
  // Never cache an empty result: a transient upstream failure would otherwise
  // be pinned for the full TTL, turning one bad moment into ten dead minutes.
  if (!payload || !Array.isArray(payload.streams) || payload.streams.length === 0) return;
  streamsMemo.set(key, payload);
}
setInterval(() => {
  streamsMemo.prune(); providerHitCache.prune(); providerEmptyCache.prune();
}, 5 * 60 * 1000).unref();

// Deterministic ordering for the aggregate response. The user's standing
// requirement is Telugu audio: a stream whose canonical `languages` array
// (utils/streamSchema.js) contains the preferred language ranks above one
// that does not, tie-broken by quality (2160p > ... > Auto). This only
// reorders - it never drops or hides a stream.
const SORT_PREFERRED_LANGUAGE = String(process.env.PREFERRED_AUDIO_LANGUAGE || 'Telugu');
const QUALITY_RANK = new Map(STREAM_QUALITIES.map((q, i) => [q, i]));
function qualityRank(q) {
  const r = QUALITY_RANK.get(q);
  return r === undefined ? QUALITY_RANK.size : r;
}
function hasPreferredLanguage(stream) {
  return Array.isArray(stream && stream.languages) &&
    stream.languages.some(l => String(l).toLowerCase() === SORT_PREFERRED_LANGUAGE.toLowerCase());
}
// The quality to rank and display a stream by.
//
// A provider's own `quality` is a CLAIM, and several providers read it off the
// release filename rather than the media. Measured on Irumudi: VaPlayer claims
// 1080p while its manifest advertises heights [804, 536, 268] - really ~720p.
// Sorting on the claim put that stream above a genuine 720p, so "best first"
// was wrong on the surface the viewer actually picks from.
//
// When the capability layer has MEASURED the ladder from the manifest, that
// measurement wins. Otherwise the claim stands, so nothing regresses for
// streams we have not probed.
function effectiveQuality(stream) {
  const caps = stream && stream.capabilities;
  if (caps && caps.qualitySource === 'manifest' && caps.quality) return caps.quality;
  return stream && stream.quality;
}

function sortStreamsCanonically(streams) {
  return streams
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const pa = hasPreferredLanguage(a.s) ? 0 : 1;
      const pb = hasPreferredLanguage(b.s) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const qa = qualityRank(effectiveQuality(a.s));
      const qb = qualityRank(effectiveQuality(b.s));
      if (qa !== qb) return qa - qb;
      return a.i - b.i; // stable tie-break: preserve original arrival order
    })
    .map(({ s }) => s);
}


// Caps how long one provider may hold up the whole fan-out. Lives here, with
// the streams routes that use it - it is not demux-specific.

// CastleTV demux (one muxed TS -> an HLS master with per-language audio)
// lives in lib/media/republish.js. Routes are registered rather than bound
// at import time so the module can be loaded without starting a server.
const { registerCastleDemuxRoutes, buildCastleDemuxEntry } = require('./lib/media/republish');
registerCastleDemuxRoutes(app);

// Hybrid streams: video from one provider, audio renditions from another.
// Same registration pattern - the app stays the composition root.
const hybridStream = require('./utils/hybridStream');
const { registerHybridRoutes, registerRebaseRoute, registerPairRoute, putJob: putHybridJob } = require('./lib/media/hybridRoutes');
registerHybridRoutes(app);
// Generic audio rebasing, for hybrid audio sources that are not castle-demux.
registerRebaseRoute(app);
// Pair a viewer-chosen video source with a viewer-chosen audio source.
registerPairRoute(app);

// The absolute base a player should call back on. Child URLs inside a hybrid
// master must be absolute, because hls.js resolves them against the master's
// own origin and these masters are assembled, not fetched from one.
function serverUrlFor(req) {
  return publicBase(req);
}

// Make a provider's streams playable from a browser: remember each url's
// request headers (for /hybrid/pair), then route header-gated origins via
// the proxy. Shared by the aggregate and the per-provider route - the
// per-provider route used to skip it and returned NetMirror's raw mp4,
// which its CDN refuses without a Referer (429 / ERR_BLOCKED_BY_ORB).
function routeStreamsForBrowser(streams, serverUrl) {
  // Record url -> headers BEFORE any proxy rewriting. Both branches below
  // strip `headers` once the proxy carries them, so recording afterwards
  // would remember a proxied url with nothing attached and /hybrid/pair
  // would be back to fetching provider manifests bare.
  streamHeaders.rememberStreams(streams);
  if (config.enableProxy) {
    streams = processStreamsForProxy(streams, serverUrl);
    // Omit original headers when proxying to avoid leaking upstream requirements
    streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
  } else {
    // Proxy the streams that CANNOT work any other way, even though the
    // routing policy is off.
    //
    // `enableProxy` is a performance policy - the proxy costs 13-22x in
    // latency, so ordinary streams go direct. But a stream whose origin
    // demands a Referer/Origin cannot be played by a browser at all: fetch
    // and <video> both forbid setting those headers, so the request goes out
    // bare and the origin refuses it.
    //
    // Measured 2026-09-23 on movie/1273049 (NetMirror, a raw mp4):
    //   no Referer                       HTTP/2 429  text/html 185b
    //   Referer videodownloader.site     HTTP/2 206  video/mp4
    //                                    x-oss-cdn-auth: success
    // In Chrome that surfaced as ERR_BLOCKED_BY_ORB on the media request and
    // "NetMirror is not responding" in the player - a provider that worked
    // perfectly from curl and never once worked in a browser.
    //
    // So the test is need, not policy: a stream carrying request headers is
    // routed through the proxy; everything else stays direct and keeps the
    // speed that turning the flag off was for.
    const needsHeaders = (s) => s && typeof s === 'object' && !s.__noProxy
      && s.headers && Object.keys(s.headers).length > 0;
    const gated = streams.filter(needsHeaders);
    if (gated.length) {
      const proxiedByUrl = new Map(
        processStreamsForProxy(gated, serverUrl).map((s, i) => [gated[i].url, s.url]));
      streams = streams.map((s) => {
        if (!needsHeaders(s)) return s;
        const url = proxiedByUrl.get(s.url);
        if (!url) return s;
        // Drop the headers now that the proxy carries them, for the same
        // reason as the enableProxy branch above: they are an upstream
        // requirement and not the browser's business.
        const { headers, ...rest } = s;
        return { ...rest, url };
      });
      console.log(`[proxy] ${gated.length}/${streams.length} stream(s) routed via proxy `
        + '(header-gated origins); the rest direct');
    }
  }
  return streams;
}

app.get('/api/streams/:type/:tmdbId', async (req,res) => {
  const { type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  // A TMDB id is always a positive integer. Without this, "notanumber" ran the
  // full provider fan-out and returned 200 success:true with count:0 - several
  // seconds of upstream calls for an id that cannot exist, and worse, every
  // provider recorded a miss for it. Measured 2026-09-21: a handful of bogus
  // requests pushed onetouchtv to consecutiveMisses=5, one short of tripping
  // its breaker, purely from junk input.
  if (!/^\d+$/.test(String(tmdbId))) {
    return res.status(400).json({ success:false, error:'INVALID_TMDB_ID' });
  }
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  try {
    metrics.streamRequests++;
    const wantCaps = req.query.capabilities === '1';
    const mk = memoKey(type, tmdbId, season, episode, wantCaps);
    const cached = req.query.refresh === '1' ? null : memoGet(mk);
    if (cached) {
      metrics.memoHits = (metrics.memoHits || 0) + 1;
      res.set('Cache-Control', `private, max-age=${STREAMS_CACHE_SECONDS}`);
      return res.json({ ...cached, cached: true });
    }
    metrics.memoMisses = (metrics.memoMisses || 0) + 1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const selectedProviders = (config.defaultProviders.length ? config.defaultProviders : listProviders().map(p=>p.name));
    const providerTimings = {};

    // CastleTV runs ahead of the pack, alone, because the answer it gives
    // decides whether another provider needs calling at all. Its muxed
    // language tracks can be split into a real audio menu (buildCastleDemuxEntry),
    // and when that works NetMirror has nothing left to contribute - it exists
    // in this list to supply alternate-language audio.
    //
    // Measured on tmdbId 1443136: castletv 3.1s, netmirror 22.1s (and it
    // returned zero streams). Paying Castle's 3.1s serially to skip NetMirror's
    // 22.1s is a large net win, and it spares a provider that rate limits per IP.
    const GATE_PROVIDER = 'castletv';
    const GATED_BY_DEMUX = ['netmirror'];

    // If TMDB knows nothing about this id, an empty provider result is a fact
    // about the title, not about the provider - see recordProviderOutcome.
    const titleIsResolvable = Boolean(imdbId);

    // Providers skipped by an open breaker on this request. If nothing else
    // returns a stream they are retried below: a breaker trades a provider's
    // latency for the others' results, and with no results there is nothing
    // to trade for. Prod 2026-11-15 19:01: one flaky NetMirror probe re-tripped
    // its breaker, so The Paradise (1376856) returned 0 streams instantly for
    // 10 minutes while /api/streams/netmirror/movie/1376856 returned 1.
    const skippedByBreaker = [];
    // Providers that threw on this request. The response is then not
    // memoized, or one short upstream blip would pin a result without that
    // provider for STREAMS_MEMO_MS.
    const erroredProviders = [];
    const refresh = req.query.refresh === '1';
    const titleKey = `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`;
    const runProvider = async (name, { bypassBreaker = false } = {}) => {
      const prov = getProvider(name);
      if (!prov || !prov.enabled) return [];
      const ck = `${name}|${titleKey}`;
      if (!refresh) {
        const hit = providerHitCache.get(ck);
        if (hit) { providerTimings[name] = 0; return hit; }
        if (providerEmptyCache.has(ck)) { providerTimings[name] = 0; return []; }
      }
      if (!bypassBreaker && breakerOpen(name)) {
        providerTimings[name] = null;
        skippedByBreaker.push(name);
        return [];
      }
      metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
      // `t0` must outlive the try: the catch below reports elapsed time, and a
      // block-scoped const there threw ReferenceError instead, replacing the real
      // provider error with a bogus one.
      const t0 = Date.now();
      try {
        console.log(`[api] invoking provider ${name} for tmdbId=${tmdbId}`);
        const r = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{ } });
        if (r && r.timedOut) {
          providerTimings[name] = null;
          recordProviderOutcome(name, 'timeout', Date.now()-t0, 0);
          return [];
        }
        providerTimings[name] = Date.now()-t0;
        const n = Array.isArray(r) ? r.length : 0;
        recordProviderOutcome(name, n > 0 ? 'hit' : 'empty', providerTimings[name], n, titleIsResolvable,
          titleKey);
        if (n > 0) providerHitCache.set(ck, r);
        else if (titleIsResolvable) providerEmptyCache.set(ck, true);
        console.log(`[api] provider ${name} returned ${n} streams`);
        return Array.isArray(r) ? r : [];
      } catch (e) {
        console.error(`[api] provider ${name} failed:`, e.message);
        providerTimings[name] = null;
        erroredProviders.push(name);
        // Never cached in providerEmptyCache: an error says the provider is
        // down right now, not that the title is missing. titleKey keeps one
        // title's repeated failures from tripping the breaker for all titles.
        recordProviderOutcome(name, 'error', Date.now()-t0, 0, titleIsResolvable, titleKey);
        const h = metrics.providerHealth[name];
        if (h) h.lastErr = String(e.message || e).slice(0, 200);
        return [];
      }
    };

    const serverUrlEarly = publicBase(req);
    let castleStreams = [];
    let demuxed = null;
    // The gate only holds while Castle actually covers the user's language.
    // NetMirror now reports its own languages (post.php carries a `lang` array),
    // so skipping it when Castle lacks the wanted language throws away the only
    // provider that has it - measured on Kuberaa, where Castle has no Tamil and
    // NetMirror does. Skip NetMirror only when Castle's demux already offers
    // the preferred language.
    const preferredLanguage = String(process.env.PREFERRED_AUDIO_LANGUAGE || 'Telugu');
    const preferredRe = new RegExp(preferredLanguage, 'i');
    const hasPreferred = (list) => Array.isArray(list)
      && list.some((s) => s && Array.isArray(s.languages) && s.languages.some((l) => preferredRe.test(l)));
    // Providers Castle does not gate start NOW, alongside Castle. They used to
    // start only after Castle (and its demux probe) finished, which put
    // Castle's ~3s in front of every other provider for no reason: the gate
    // only decides whether NetMirror runs.
    const early = new Map(selectedProviders
      .filter((name) => name !== GATE_PROVIDER && !GATED_BY_DEMUX.includes(name))
      .map((name) => [name, runProvider(name)]));
    if (selectedProviders.includes(GATE_PROVIDER)) {
      castleStreams = await runProvider(GATE_PROVIDER);
      demuxed = await buildCastleDemuxEntry(castleStreams, serverUrlEarly);
      if (demuxed) {
        const covered = new RegExp(preferredLanguage, 'i')
          .test(`${demuxed.name || ''} ${demuxed.language || ''}`);
        if (!covered) {
          demuxed.__keepGated = true;
          console.log(`[api] castle demux for ${tmdbId} lacks ${preferredLanguage} - still querying ${GATED_BY_DEMUX.join(', ')}`);
        } else {
          console.log(`[api] castle demux available for ${tmdbId} (has ${preferredLanguage}) - skipping ${GATED_BY_DEMUX.join(', ')}`);
        }
      }
    }
    const gateHolds = Boolean(demuxed) && !demuxed.__keepGated;

    const remaining = selectedProviders.filter((name) =>
      name !== GATE_PROVIDER && !(gateHolds && GATED_BY_DEMUX.includes(name)));

    const tasks = remaining.map((name) => ({ name, p: early.get(name) || runProvider(name) }));
    // Answer early once a stream in the preferred language is in hand: the
    // viewer can start, and everything still running fills providerHitCache
    // for the next request (the web app also asks NetMirror on its own after
    // playback starts). Without a preferred-language stream it keeps waiting
    // for the primaries, because answering then would hide the one provider
    // that has Telugu (CLAUDE.md rule 1). Opt-in with PRIMARY_PROVIDERS, like
    // the rest of the early answer.
    let foundPreferred;
    const preferredFound = new Promise((r) => { foundPreferred = r; });
    if (PRIMARY_LIST.length) {
      if (gateHolds || hasPreferred(castleStreams)) foundPreferred(true);
      for (const x of tasks) x.p.then((r) => { if (hasPreferred(r)) foundPreferred(true); });
    }
    const answeredEarly = await Promise.race([
      Promise.all(tasks.filter((x) => isPrimary(x.name)).map((x) => x.p)).then(() => false),
      preferredFound,
    ]);
    const LATE = Symbol('late');
    let grace;
    const graceOver = new Promise((r) => {
      grace = setTimeout(() => r(LATE), answeredEarly ? FIRST_ANSWER_GRACE_MS : SECONDARY_GRACE_MS);
    });
    let results = await Promise.all(tasks.map((x) =>
      (isPrimary(x.name) && !answeredEarly) ? x.p : Promise.race([x.p, graceOver])));
    clearTimeout(grace);
    const late = tasks.filter((x, i) => results[i] === LATE);
    results = results.map((r) => (r === LATE ? [] : r));
    if (late.length && castleStreams.length === 0 && results.every((r) => r.length === 0)) {
      // Nothing yet: an answer with streams is worth waiting for.
      const settled = await Promise.all(late.map((x) => x.p));
      late.forEach((x, k) => { results[tasks.indexOf(x)] = settled[k]; });
      late.length = 0;
    }
    for (const x of late) {
      providerTimings[x.name] = null;
      console.log(`[api] ${x.name} still running after grace for ${tmdbId}; its result will be cached for the next request`);
    }
    if (castleStreams.length === 0 && results.every((r) => r.length === 0) && skippedByBreaker.length) {
      const retry = skippedByBreaker.splice(0);
      console.log(`[api] no streams for ${tmdbId}; retrying breaker-skipped providers: ${retry.join(', ')}`);
      if (retry.includes(GATE_PROVIDER)) {
        castleStreams = await runProvider(GATE_PROVIDER, { bypassBreaker: true });
        if (!demuxed) demuxed = await buildCastleDemuxEntry(castleStreams, serverUrlEarly);
      }
      const others = retry.filter((name) => name !== GATE_PROVIDER);
      results.push(...await Promise.all(others.map((name) => runProvider(name, { bypassBreaker: true }))));
    }
    let streams = [...castleStreams, ...results.flat()];
    streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    const serverUrl = serverUrlEarly;
    // Castle ships its language tracks muxed into one file; splitting them out
    // gives a real audio menu without depending on another provider. Built
    // above, before the fan-out, so its result could gate the other providers.
    if (demuxed) {
      delete demuxed.__keepGated;
      // buildCastleDemuxEntry hand-builds a raw stream (name/quality/url only);
      // normalise it too so it carries `languages`/`title`/`container`/etc
      // like every provider-sourced stream, and sorts correctly below.
      streams = [normaliseStream(demuxed), ...streams];
    }
    // Hybrid pairings: one provider's picture bound to another's audio
    // renditions (utils/hybridStream.js).
    //
    // OFF BY DEFAULT since 2026-09-22. The viewer picks video and audio
    // independently in the player instead of being handed a pre-fused
    // "showsst+CastleTV" row, so a combination chosen here would compete with
    // the one they chose there. The machinery stays - /hybrid/:id/master.m3u8
    // is exactly how a viewer-chosen pair is played - only the automatic
    // injection into the source list is gone.
    //
    // Set enableHybridStreams:true in user-config.json to restore the old
    // auto-paired behaviour.
    if (config.enableHybridStreams === true && streams.length > 1) {
      try {
        const plans = await hybridStream.planPairings(streams);
        if (plans.length) {
          const entries = hybridStream.describePlansAsStreams(plans, serverUrlFor(req));
          for (const entry of entries) {
            putHybridJob(entry.__hybrid.id, { plan: entry.__hybrid.plan, playlist: null });
            delete entry.__hybrid;
          }
          // Ranked above the originals: a merged entry is strictly better than
          // the video-only stream it was built from - same picture, plus
          // languages - so it should be what the player picks by default.
          streams = [...normaliseStreams(entries), ...streams];
          console.log(`[hybrid] offering ${entries.length} pairing(s) for ${tmdbId}`);
        }
      } catch (e) {
        // A hybrid is an enhancement. If it throws, the ordinary streams must
        // still be served rather than the whole request failing.
        console.error('[hybrid] planning failed:', e.message);
      }
    }

    streams = sortStreamsCanonically(streams);
    streams = routeStreamsForBrowser(streams, serverUrl);
    // Every call here fans out to a dozen providers, and NetMirror rate limits
    // per IP ("Too Many Requests in Short Period of Time"). A plain page reload
    // re-ran the whole fan-out and burned another NetMirror probe even when the
    // viewer was about to play a CastleTV stream. Letting the browser reuse the
    // response for a few minutes removes that entirely, for every client, with
    // no cache bookkeeping of our own.
    //
    // `private` because the payload carries signed, per-session upstream URLs
    // that must never land in a shared cache. The TTL stays well under the
    // signature lifetime so a cached entry cannot outlive its own URLs.
    // ?capabilities=1 resolves every stream's real ladder and audio renditions
    // in the same round trip, so a UI can render both menus without a second
    // call per card. Off by default: it costs one manifest fetch per stream
    // (cached 5 min in lib/media/probe.js), which is wasted work for a caller
    // that only lists titles.
    if (wantCaps) {
      const caps = await resolveMany(streams);
      streams = streams.map((st, i) => {
        const c = caps[i];
        const st2 = { ...st, capabilities: c };
        // A measured ladder overrides the provider's claim on the top-level
        // `quality` field too, not just inside `capabilities`. A UI reads
        // `quality` for its label and its menu; leaving the claim there meant
        // the card said 1080p while the highest rendition the player could
        // actually select was 720p. `claimedQuality` keeps the original so the
        // disagreement stays visible rather than being quietly erased.
        if (c && c.qualitySource === 'manifest' && c.quality && c.quality !== st.quality) {
          st2.claimedQuality = st.quality;
          st2.quality = c.quality;
        }
        return st2;
      });
      // Re-sort: the ranking above ran on claimed values, and a correction may
      // have changed the order.
      streams = sortStreamsCanonically(streams);
    }

    res.set('Cache-Control', `private, max-age=${STREAMS_CACHE_SECONDS}`);
    const payload = { success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams };
    // Tells a client cache not to keep this answer: a provider was still
    // running when it went out, and the next request will include it.
    if (late.length) payload.partial = true;
    // A response missing a late provider is not memoized, so the next request
    // rebuilds it and picks that provider up from providerHitCache.
    if (!late.length && !erroredProviders.length) memoSet(mk, payload);
    res.json(payload);
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// Provider-specific streams
app.get('/api/streams/:provider/:type/:tmdbId', async (req,res) => {
  const { provider, type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  if (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });
  if (!/^\d+$/.test(String(req.params.tmdbId))) {
    return res.status(400).json({ success:false, error:'INVALID_TMDB_ID' });
  }
  try {
    metrics.streamRequests++;
    metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name]||0)+1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const t0 = Date.now();
    // A provider failure keeps this route's old contract (200, count 0) and
    // says why in providerError, instead of a 500.
    let providerError = null;
    let streams = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{} })
      .catch((e) => { providerError = String(e && e.message || e).slice(0, 200); return []; });
    const providerTimings = { [prov.name]: Date.now()-t0 };
    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    streams = sortStreamsCanonically(streams);
    streams = routeStreamsForBrowser(streams, publicBase(req));
    res.json({ success:true, provider: prov.name, tmdbId, imdbId, count: streams.length, providerTimings,
      ...(providerError ? { providerError } : {}), streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// Vercel imports this module as a serverless handler, while local/Docker runs
// execute it directly and need a normal listening server.
if (require.main === module) {
  const startup = checkStartupConfig(config, process.env, listProviders().map((p) => p.name));
  for (const w of startup.warnings) console.warn(`[startup][warning] ${w}`);
  if (startup.errors.length) {
    for (const e of startup.errors) console.error(`[startup][error] ${e}`);
    allowControlledExit = true;
    realProcessExit(1);
  }
  const PORT = config.port;
  const HOST = process.env.BIND_HOST || '0.0.0.0';
  const server = app.listen(PORT, HOST, () => {
    console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
    if (HOST !== 'localhost') {
      console.log(`Local access (if running on your machine): http://localhost:${PORT}`);
    }
    console.log('Endpoints:');
    console.log('  GET  /api/health');
    console.log('  GET  /api/metrics');
    console.log('  GET  /api/providers');
    console.log('  GET  /api/streams/:type/:id');
    console.log('  POST /api/streams/:type/:id');
    if (!config.febboxCookies || config.febboxCookies.length === 0) {
      console.warn('[startup][warning] No FEBBOX_COOKIES configured. Showbox / PStream related streams may be unavailable. Set FEBBOX_COOKIES in your environment to enable these sources.');
    }
  });

  server.on('error', (err)=>{ console.error('[diagnostic] server error', err); });
  installGracefulShutdown(server, { exit: (code) => { allowControlledExit = true; realProcessExit(code); } });
}

module.exports = app;
