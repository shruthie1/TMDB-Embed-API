require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { compressFilter } = require('./proxy/playlistCompression');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { requireAuth, getSession } = require('./utils/auth');
const { registerAuthRoutes } = require('./routes/auth');
const path = require('path');
const { paths: appPaths } = require('./lib/runtime/paths');
const { metrics, recordProviderOutcome, breakerOpen, budgetFor, latencyEwma, requestCounter } = require('./lib/runtime/metrics');
const { getStore, storeStatus, mediaIdentityOf } = require('./utils/store');
const runtime = require('./lib/runtime/environment');
const { listProviders, getProvider, getCookieStats, PROVIDER_DEADLINE_MS } = require('./providers/registry');
const { QUALITIES: STREAM_QUALITIES, normaliseStream, normaliseStreams } = require('./utils/streamSchema');
const { resolveMany } = require('./lib/media/capabilities');
const streamHeaders = require('./lib/media/streamHeaders');
const { verifyTopStreams } = require('./lib/media/segmentVerify');
const { registerCapabilityRoutes } = require('./routes/capabilities');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { routeStreams, surfaceAllows, surfaceOf } = require('./lib/routing/providerRoutes');
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
// gzip JSON and HLS text playlists only (proxy/playlistCompression.js). Media
// segments, HTML and any ranged response are left alone: the filter runs when
// headers go out, so segment routes stream exactly as before.
app.use(compression({ filter: compressFilter(compression) }));
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
    ...storeStatus(),
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
    // Hybrid audio segments served UNSHIFTED because ffmpeg could not rebase
    // them (utils/ptsRebase.js; log prefix "[pts-rebase] FAILED").
    ptsRebase: require('./utils/ptsRebase').stats,
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
    // Hybrid audio segments served UNSHIFTED because ffmpeg could not rebase
    // them (utils/ptsRebase.js; log prefix "[pts-rebase] FAILED").
    ptsRebase: require('./utils/ptsRebase').stats,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024),
    providerHealth: metrics.providerHealth
  }, endpoints, providers });
});

// Playback capability routes (quality + audio menus) live in
// routes/capabilities.js.
registerCapabilityRoutes(app);

// Providers list
// Bound every field of a playback report (ott server.js /api/playback-report).
// The endpoint is unauthenticated and the browser is not trusted: a malformed
// report is refused or clamped, never stored as sent. Returns null when the
// report cannot be keyed to a title and provider.
function clampPlaybackReport(b) {
  b = b && typeof b === 'object' ? b : {};
  const tmdbId = Number(b.tmdbId);
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1 || tmdbId > 1e9) return null;
  const provider = typeof b.provider === 'string' ? b.provider.trim().toLowerCase().slice(0, 40) : '';
  if (!/^[a-z0-9][a-z0-9+._ -]*$/.test(provider)) return null;
  const boundedInt = (value, max = 86400000) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : 0;
  };
  const small = (v) => boundedInt(v, 100000);
  const type = (b.type || b.mediaType) === 'tv' || (b.type || b.mediaType) === 'series' ? 'tv' : 'movie';
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const lang = str(b.audioLang, 24);
  const identity = str(b.mediaIdentity, 300) || mediaIdentityOf(str(b.mediaUrl, 4000));
  return {
    tmdbId, type, provider,
    season: type === 'tv' ? small(b.season) : 0,
    episode: type === 'tv' ? small(b.episode) : 0,
    mediaIdentity: identity || '',
    // `ok` is the field the player has always sent; playedOk is the new name.
    ok: (b.playedOk ?? b.ok) === true,
    reason: str(b.reason, 60) || (b.ok === true || b.playedOk === true ? null : 'unknown'),
    startupMs: boundedInt(b.startupMs),
    // Nullable: an older client sends no waitMs, and 0 would read as instant.
    waitMs: b.waitMs == null ? null : boundedInt(b.waitMs),
    stallCount: boundedInt(b.stallCount, 1000),
    stallMs: boundedInt(b.stallMs),
    recoveryCount: boundedInt(b.recoveryCount, 1000),
    device: str(b.device, 24),
    connection: str(b.connection, 24),
    audioLang: lang && /^[\p{L} ()-]+$/u.test(lang) ? lang : null,
    // Only an explicit boolean is a statement about the language.
    langOk: typeof b.langOk === 'boolean' ? b.langOk : null,
  };
}

// What a real device saw when it played a source - the only ground truth the
// ranking has. Fire-and-forget from the player (web/lib/api.js
// reportPlayback): it never starts a resolve, and a bad report is a 400, not
// an error. Feeds source_stats (G1 ranking) and audio_evidence (G10).
app.post('/api/playback-report', (req, res) => {
  const r = clampPlaybackReport(req.body);
  if (!r) return res.status(400).json({ ok: false, error: 'tmdbId and provider required' });
  try {
    const store = getStore();
    store.recordPlayback(r);
    // A viewer saying the labelled language is NOT what played is
    // authoritative. A confirmation is recorded too, so a later probe that
    // reads `und` cannot erase a language a viewer heard.
    if (r.langOk !== null && r.audioLang && r.mediaIdentity) {
      store.putAudioEvidence({ tmdbId: r.tmdbId, type: r.type, season: r.season, episode: r.episode,
        provider: r.provider, mediaIdentity: r.mediaIdentity, lang: r.audioLang,
        source: 'viewer', refuted: r.langOk === false });
    }
    console.log(`[learn] playback-report ${r.ok ? 'ok' : 'fail'} ${r.type}/${r.tmdbId} s${r.season}e${r.episode} `
      + `provider=${r.provider} identity=${r.mediaIdentity ? 'yes' : 'no'} startupMs=${r.startupMs}`
      + `${r.langOk === null ? '' : ` langOk=${r.langOk}`}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[learn] playback-report write failed: ${e.message}`);
    res.status(500).json({ ok: false, error: 'STORE_WRITE_FAILED' });
  }
});

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
// An early answer never goes out before this long after the request started.
// The grace used to start after the castle gate, so a provider with a short
// settle cap (multimovies, 2 s) missed the first answer by tens of ms on every
// request (RRR 579974, 2026-11-21).
const EARLY_ANSWER_FLOOR_MS = Number(process.env.EARLY_ANSWER_FLOOR_MS) || 2500;
// Whole-request budget, from request start. Providers still running at the
// budget go out as late (partial, no-store); ?full=1 waits for them. Without
// it the castle gate, NetMirror and the breaker retry ran in series, each up
// to the 20 s registry deadline, past the APK's 22 s call timeout.
const REQUEST_BUDGET_MS = Number(process.env.REQUEST_BUDGET_MS) || 12000;
// How long NetMirror waits for the castle gate before it starts anyway.
const CASTLE_GATE_MAX_MS = Number(process.env.CASTLE_GATE_MAX_MS) || 3000;

// Per-provider result caches, keyed provider|title. Separate from the breaker:
// the breaker is about a provider's health, these are about one title.
// - hits: a provider's raw streams for 10 min (signed URLs outlive that).
// - empties: a provider that had nothing for a title is not asked again for
//   PROVIDER_EMPTY_TTL_MS. Kept short because an empty can be a transient
//   upstream failure (NetMirror reports resets as empty). ?refresh=1 skips both.
const { createTtlCache } = require('./lib/runtime/ttlCache');
const PROVIDER_HIT_TTL_MS = Number(process.env.PROVIDER_HIT_TTL_MS) || 10 * 60 * 1000;
const providerHitCache = createTtlCache({ ttlMs: PROVIDER_HIT_TTL_MS, maxEntries: 2000 });
// Signed URLs carry their own expiry (e=, expire=, internal_token). A cache
// entry lives at most until its first row's URL dies, and a read that finds an
// expired row drops the whole entry so the provider is asked again: serving
// the surviving rows alone could hide the expired one (often the Telugu row).
const urlExpiry = require('./lib/urlExpiry');
function providerHitSet(ck, rows) {
  const ttl = urlExpiry.cappedTtlMs(PROVIDER_HIT_TTL_MS, rows);
  if (ttl > 0) providerHitCache.set(ck, rows, ttl);
}
function providerHitGet(ck) {
  const rows = providerHitCache.get(ck);
  if (rows && urlExpiry.anyStreamExpired(rows)) {
    providerHitCache.delete(ck);
    console.log(`[api] url-expired cache=provider key=${ck} - re-resolving`);
    return undefined;
  }
  return rows;
}
const providerEmptyCache = createTtlCache({
  ttlMs: Number(process.env.PROVIDER_EMPTY_TTL_MS) || 3 * 60 * 1000, maxEntries: 5000 });

// One upstream call per provider+title at a time. Without this, a second
// request for a title that arrived while the first was still fetching (the
// title-page warm-up then Play, a reload, the web's own NetMirror call after
// playback starts, or the follow-up for a partial answer) started the same
// provider again: two NetMirror probes in seconds, and NetMirror throttles per
// IP. Joiners get the same outcome; only the caller that started the fetch
// records it in the breaker and the caches.
const providerInflight = new Map();
function fetchProviderShared(prov, ck, ctx, { titleIsResolvable, titleKey }) {
  const running = providerInflight.get(ck);
  if (running) return running;
  const name = prov.name;
  const p = (async () => {
    // Yield first so the map entry below exists before the finally can run,
    // even if prov.fetch throws synchronously.
    await null;
    metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
    const t0 = Date.now();
    try {
      console.log(`[api] invoking provider ${name} for tmdbId=${ctx.tmdbId}`);
      // Probation (ott budgetFor): a provider judged on >= 5 attempts that has
      // never once succeeded gets 8s, not the full deadline. Healthy and
      // unknown providers keep PROVIDER_DEADLINE_MS untouched.
      const budget = budgetFor(name, PROVIDER_DEADLINE_MS);
      let r;
      if (budget < PROVIDER_DEADLINE_MS) {
        let timer;
        const run = prov.fetch(ctx);
        run.catch(() => {});
        r = await Promise.race([run, new Promise((resolve) => {
          timer = setTimeout(() => { const out = []; out.timedOut = true; resolve(out); }, budget);
        })]).finally(() => clearTimeout(timer));
        if (r && r.timedOut) console.log(`[api] provider-probation ${name} cut at ${budget}ms (never succeeded)`);
      } else {
        r = await prov.fetch(ctx);
      }
      if (r && r.timedOut) {
        // Unknown, not empty: never cached, and the caller keeps the whole
        // response out of the memo and the browser cache.
        recordProviderOutcome(name, 'timeout', Date.now()-t0, 0);
        console.log(`[api] provider-unknown ${name} tmdbId=${ctx.tmdbId} reason=timeout`);
        return { outcome: 'timeout', ms: null, streams: [], error: `timeout after ${Date.now()-t0}ms` };
      }
      const ms = Date.now()-t0;
      const n = Array.isArray(r) ? r.length : 0;
      // Part of the provider's upstream failed (one language track, one
      // platform). Serve the rows it got, but cache none of them: a cached
      // partial answer would hide the missing row (often the Telugu one) for
      // PROVIDER_HIT_TTL_MS after a blip that lasted seconds.
      if (r && r.upstreamError) {
        recordProviderOutcome(name, n > 0 ? 'hit' : 'error', ms, n, titleIsResolvable, titleKey);
        console.log(`[api] provider-partial ${name} tmdbId=${ctx.tmdbId} rows=${n} reason=${String(r.upstreamError).slice(0, 120)}`);
        return { outcome: 'partial', ms, streams: Array.isArray(r) ? r : [], error: String(r.upstreamError).slice(0, 200) };
      }
      recordProviderOutcome(name, n > 0 ? 'hit' : 'empty', ms, n, titleIsResolvable, titleKey);
      if (n > 0) providerHitSet(ck, r);
      else if (titleIsResolvable) providerEmptyCache.set(ck, true);
      console.log(`[api] provider ${name} returned ${n} streams`);
      return { outcome: n > 0 ? 'hit' : 'empty', ms, streams: Array.isArray(r) ? r : [] };
    } catch (e) {
      console.error(`[api] provider ${name} failed:`, e.message);
      // Never cached in providerEmptyCache: an error says the provider is
      // down right now, not that the title is missing. titleKey keeps one
      // title's repeated failures from tripping the breaker for all titles.
      recordProviderOutcome(name, 'error', Date.now()-t0, 0, titleIsResolvable, titleKey);
      const h = metrics.providerHealth[name];
      if (h) h.lastErr = String(e.message || e).slice(0, 200);
      return { outcome: 'error', ms: null, streams: [], error: String(e && e.message || e).slice(0, 200) };
    } finally {
      providerInflight.delete(ck);
    }
  })();
  providerInflight.set(ck, p);
  return p;
}

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
// The surface is part of it too: a web answer has no APK-only rows.
function memoKey(type, tmdbId, season, episode, withCaps, surface = null) {
  return `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}:${withCaps ? 'caps' : 'plain'}${surface ? `:${surface}` : ''}`;
}
function memoGet(key) {
  const payload = streamsMemo.get(key) || null;
  // An expired URL in the memo means the whole answer is stale: drop it so
  // the route rebuilds (and re-resolves) instead of serving a dead link.
  if (payload && urlExpiry.anyStreamExpired(payload.streams)) {
    streamsMemo.delete(key);
    console.log(`[api] url-expired cache=memo key=${key} - re-resolving`);
    return null;
  }
  return payload;
}
function memoSet(key, payload) {
  // Never cache an empty result: a transient upstream failure would otherwise
  // be pinned for the full TTL, turning one bad moment into ten dead minutes.
  if (!payload || !Array.isArray(payload.streams) || payload.streams.length === 0) return;
  const ttl = urlExpiry.cappedTtlMs(STREAMS_MEMO_MS, payload.streams);
  if (ttl > 0) streamsMemo.set(key, payload, ttl);
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

// What a real browser saw, applied INSIDE a language group (ott RANK,
// resolver/index.js). Language stays the primary key; learning only reorders
// within it and sinks proven-bad rows. Nothing is ever dropped.
//
//   1. play_fails >= 2 sinks (it failed again after a success cleared it);
//      a "runtime mismatch" failure sinks and unconfirms on the first report
//   2. browser-confirmed (played_ok_at) before unconfirmed
//   3. score = 1.5*quality + speed + 1.5*startup, each in [0, 1]
//        quality = min(height, 2160) / 2160
//        speed   = clamp((30000 - provider latency EWMA) / 27000, 0, 1)
//        startup = clamp((30000 - startup_ms) / 27000, 0, 1)
//      an unknown term scores 0, as in ott.
//
// `learn` names the title ({ tmdbId, type, season, episode }). Without it,
// rows have no browser history and only quality + speed apply.
function heightOf(q) {
  const m = String(q || '').match(/(\d{3,4})p/);
  return m ? Number(m[1]) : 0;
}
function unit(ms) {
  return ms == null ? 0 : Math.max(0, Math.min(1, (30000 - ms) / 27000));
}
function learnedIndex(learn) {
  if (!learn || !learn.tmdbId) return null;
  try {
    const idx = new Map();
    for (const r of getStore().sourceStatsFor(learn)) idx.set(`${r.provider}|${r.media_identity}`, r);
    return idx;
  } catch (e) {
    console.warn(`[learn] source_stats read failed: ${e.message}`);
    return null;
  }
}
function learnedFacts(s, idx, ewmaCache) {
  const provider = String((s && s.provider) || '').toLowerCase();
  // Exact file first, then the provider-level row for this title (what a
  // client that does not send mediaIdentity reports against).
  const st = idx ? (idx.get(`${provider}|${mediaIdentityOf(s && s.url)}`) || idx.get(`${provider}|`) || null) : null;
  if (!ewmaCache.has(provider)) ewmaCache.set(provider, latencyEwma(provider));
  // A runtime mismatch is proof on the first report: a truncated or wrong
  // file never changes length, so it sinks and loses any earlier
  // confirmation at once (Krack 784572: 102.5m Castle Telugu vs 154m).
  const runtimeBad = Boolean(st && st.play_fails > 0
    && /^runtime mismatch/i.test(String(st.play_fail_reason || '')));
  const startup = st && st.played_ok_at && !st.play_fails ? st.startup_ms : null;
  return {
    sink: st && (st.play_fails >= 2 || runtimeBad) ? 1 : 0,
    unconfirmed: st && st.played_ok_at && !runtimeBad ? 0 : 1,
    score: 1.5 * (Math.min(heightOf(effectiveQuality(s)), 2160) / 2160)
      + unit(ewmaCache.get(provider)) + 1.5 * unit(startup),
  };
}

function sortStreamsCanonically(streams, learn = null) {
  const idx = learnedIndex(learn);
  const ewmaCache = new Map();
  return streams
    .map((s, i) => ({ s, i, l: learnedFacts(s, idx, ewmaCache) }))
    .sort((a, b) => {
      const pa = hasPreferredLanguage(a.s) ? 0 : 1;
      const pb = hasPreferredLanguage(b.s) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      // Proven dead bytes (lib/media/segmentVerify.js) sink inside their
      // language group. Never across it, and never out of the list.
      const da = a.s && a.s.byteCheck && a.s.byteCheck.ok === false ? 1 : 0;
      const db = b.s && b.s.byteCheck && b.s.byteCheck.ok === false ? 1 : 0;
      if (da !== db) return da - db;
      if (a.l.sink !== b.l.sink) return a.l.sink - b.l.sink;
      if (a.l.unconfirmed !== b.l.unconfirmed) return a.l.unconfirmed - b.l.unconfirmed;
      if (Math.abs(a.l.score - b.l.score) > 1e-9) return b.l.score - a.l.score;
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
// Cast to a TV through Web Video Caster: long-lived single-audio masters.
require('./lib/media/castRoutes').registerCastRoutes(app);
// The Android app's resolver override config: built-in
// routes/resolve-config.json < remote RESOLVE_CONFIG_URL < verified heals
// (lib/selfheal/config.js). start() fetches the remote now and every ttlSec;
// with RESOLVE_CONFIG_URL unset it makes no request.
require('./routes/resolveConfig').registerResolveConfigRoute(app);
require('./lib/selfheal/config').start();

// The absolute base a player should call back on. Child URLs inside a hybrid
// master must be absolute, because hls.js resolves them against the master's
// own origin and these masters are assembled, not fetched from one.
function serverUrlFor(req) {
  return publicBase(req);
}

// Make a provider's streams playable: remember each url's request headers
// (for /hybrid/pair), proxy the rows that need it, and say per row whether a
// client may skip the proxy. Shared by the aggregate and the per-provider
// route - the per-provider route used to skip it and returned NetMirror's raw
// mp4, which its CDN refuses without a Referer (429 / ERR_BLOCKED_BY_ORB).
//
// Whether a client NEEDS the proxy is per-provider config, not "the row has
// headers" (owner 2026-11-21, routing-matrix.md): that rule sent CastleTV and
// the multimovies bridge through the VM for nothing. `url` stays proxied for
// old clients; see lib/routing/providerRoutes.js for the contract.
function routeStreamsForBrowser(streams, serverUrl) {
  return routeStreams(streams, serverUrl, {
    enableProxy: config.enableProxy,
    processStreamsForProxy,
    rememberStreams: (s) => streamHeaders.rememberStreams(s),
  });
}

// season/episode are TMDB numbers: positive integers when given. Season 0
// (specials) or a non-integer used to reach the providers as `0 || null` or
// NaN, and several default a missing season to 1 - so S0E1 played S1E1 as if
// it were the requested episode. The web never asks for season 0.
function parseSeasonEpisode(query) {
  const one = (raw, label) => {
    if (raw === undefined || raw === '') return { v: null };
    const n = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(n) || n < 1) return { bad: `INVALID_${label}` };
    return { v: n };
  };
  const s = one(query.season, 'SEASON');
  const e = one(query.episode, 'EPISODE');
  return { season: s.v, episode: e.v, badSeason: s.bad || e.bad || null };
}

app.get('/api/streams/:type/:tmdbId', async (req,res) => {
  const reqT0 = Date.now();
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
  const { season, episode, badSeason } = parseSeasonEpisode(req.query);
  if (badSeason) return res.status(400).json({ success:false, error: badSeason });
  try {
    metrics.streamRequests++;
    const wantCaps = req.query.capabilities === '1';
    const surface = surfaceOf(req.query);
    const mk = memoKey(type, tmdbId, season, episode, wantCaps, surface);
    const cached = req.query.refresh === '1' ? null : memoGet(mk);
    if (cached) {
      metrics.memoHits = (metrics.memoHits || 0) + 1;
      res.set('Cache-Control', `private, max-age=${STREAMS_CACHE_SECONDS}`);
      // The memo holds the order from when it was built. Re-rank on every
      // read so a playback report that landed since takes effect now, not
      // after STREAMS_MEMO_MS.
      return res.json({ ...cached,
        streams: sortStreamsCanonically(cached.streams, { tmdbId, type, season, episode }), cached: true });
    }
    metrics.memoMisses = (metrics.memoMisses || 0) + 1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const selectedProviders = (config.defaultProviders.length ? config.defaultProviders : listProviders().map(p=>p.name))
      .filter((name) => surfaceAllows(name, surface));
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
        const hit = providerHitGet(ck);
        if (hit) { providerTimings[name] = 0; return hit; }
        if (providerEmptyCache.has(ck)) { providerTimings[name] = 0; return []; }
      }
      if (!bypassBreaker && !providerInflight.has(ck) && breakerOpen(name)) {
        providerTimings[name] = null;
        skippedByBreaker.push(name);
        return [];
      }
      const o = await fetchProviderShared(prov, ck,
        { tmdbId, type, season, episode, imdbId, filters:{ } }, { titleIsResolvable, titleKey });
      providerTimings[name] = o.ms;
      // error, timeout and partial all leave this title's answer UNKNOWN for
      // the provider, so the response must not be cached (see below).
      if (o.outcome !== 'hit' && o.outcome !== 'empty') erroredProviders.push(name);
      return urlExpiry.dropExpiredStreams(o.streams);
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
    // The gate is capped at CASTLE_GATE_MAX_MS. A slower Castle joins the
    // fan-out as an ordinary primary task and NetMirror starts at once.
    let castleGate = null;
    if (selectedProviders.includes(GATE_PROVIDER)) {
      castleGate = (async () => {
        const rows = await runProvider(GATE_PROVIDER);
        return { rows, demux: await buildCastleDemuxEntry(rows, serverUrlEarly) };
      })();
      let gateTimer;
      const gate = await Promise.race([castleGate,
        new Promise((r) => { gateTimer = setTimeout(() => r(null), CASTLE_GATE_MAX_MS); })]);
      clearTimeout(gateTimer);
      if (gate) {
        castleStreams = gate.rows;
        demuxed = gate.demux;
        castleGate = null;
      } else {
        console.log(`[api] castle-gate-cap ${GATE_PROVIDER} not done after ${CASTLE_GATE_MAX_MS}ms for ${tmdbId} - starting ${GATED_BY_DEMUX.join(', ')} anyway`);
      }
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
    if (castleGate) tasks.push({ name: GATE_PROVIDER, p: castleGate.then((g) => g.rows) });
    // Answer early once a stream in the preferred language is in hand: the
    // viewer can start, and everything still running fills providerHitCache
    // for the next request (the web app also asks NetMirror on its own after
    // playback starts). Without a preferred-language stream it keeps waiting
    // for the primaries, because answering then would hide the one provider
    // that has Telugu (CLAUDE.md rule 1). Opt-in with PRIMARY_PROVIDERS, like
    // the rest of the early answer.
    let foundPreferred;
    const preferredFound = new Promise((r) => { foundPreferred = r; });
    // ?full=1 is the web's follow-up to a partial answer: it waits for every
    // provider (each still capped by the registry deadline). The providers the
    // first answer left running are joined in flight, not started again.
    const wantFull = req.query.full === '1';
    const primary = (name) => wantFull || isPrimary(name);
    if (PRIMARY_LIST.length && !wantFull) {
      if (gateHolds || hasPreferred(castleStreams)) foundPreferred(true);
      for (const x of tasks) x.p.then((r) => { if (hasPreferred(r)) foundPreferred(true); });
    }
    const LATE = Symbol('late');
    // ?full=1 has no budget: it is the follow-up that collects late rows.
    // budgetFired: a timer can fire a millisecond before Date.now() agrees.
    let budgetTimer;
    let budgetFired = false;
    const budgetOver = wantFull ? new Promise(() => {}) : new Promise((r) => {
      budgetTimer = setTimeout(() => { budgetFired = true; r(LATE); },
        Math.max(0, REQUEST_BUDGET_MS - (Date.now() - reqT0)));
    });
    const budgetSpent = () => !wantFull && (budgetFired || Date.now() - reqT0 >= REQUEST_BUDGET_MS);
    const answeredEarly = await Promise.race([
      Promise.all(tasks.filter((x) => primary(x.name)).map((x) => x.p)).then(() => false),
      preferredFound,
      budgetOver.then(() => false),
    ]);
    let grace;
    // Early-answer grace counts from request start, with a floor, so the
    // castle gate's time is not taken out of the other providers' time.
    const graceMs = answeredEarly
      ? Math.max(FIRST_ANSWER_GRACE_MS, EARLY_ANSWER_FLOOR_MS - (Date.now() - reqT0))
      : SECONDARY_GRACE_MS;
    const graceOver = Promise.race([budgetOver, new Promise((r) => {
      grace = setTimeout(() => r(LATE), graceMs);
    })]);
    let results = await Promise.all(tasks.map((x) =>
      Promise.race([x.p, (primary(x.name) && !answeredEarly) ? budgetOver : graceOver])));
    clearTimeout(grace);
    const late = tasks.filter((x, i) => results[i] === LATE);
    results = results.map((r) => (r === LATE ? [] : r));
    if (late.length && castleStreams.length === 0 && results.every((r) => r.length === 0)) {
      // Nothing yet: an answer with streams is worth waiting for, up to the
      // request budget.
      const settled = await Promise.all(late.map((x) => Promise.race([x.p, budgetOver])));
      const still = late.filter((x, k) => settled[k] === LATE);
      late.forEach((x, k) => { if (settled[k] !== LATE) results[tasks.indexOf(x)] = settled[k]; });
      late.length = 0;
      late.push(...still);
    }
    clearTimeout(budgetTimer);
    if (budgetSpent() && late.length) {
      console.log(`[api] request-budget spent after ${Date.now() - reqT0}ms for ${tmdbId}; late: ${late.map((x) => x.name).join(', ')}`);
    }
    // A Castle that missed the gate cap but answered in time still gets its
    // demuxed audio menu.
    const castleTask = tasks.find((x) => x.name === GATE_PROVIDER);
    if (castleTask && castleGate && !late.includes(castleTask)) {
      const g = await castleGate;
      if (!demuxed) demuxed = g.demux;
    }
    for (const x of late) {
      providerTimings[x.name] = null;
      console.log(`[api] ${x.name} still running after grace for ${tmdbId}; its result will be cached for the next request`);
    }
    if (castleStreams.length === 0 && results.every((r) => r.length === 0) && skippedByBreaker.length
        && budgetSpent()) {
      console.log(`[api] request-budget spent after ${Date.now() - reqT0}ms for ${tmdbId}; skipping breaker retry: ${skippedByBreaker.join(', ')}`);
    } else if (castleStreams.length === 0 && results.every((r) => r.length === 0) && skippedByBreaker.length) {
      const retry = skippedByBreaker.splice(0);
      console.log(`[api] no streams for ${tmdbId}; retrying breaker-skipped providers: ${retry.join(', ')}`);
      if (retry.includes(GATE_PROVIDER)) {
        castleStreams = await runProvider(GATE_PROVIDER, { bypassBreaker: true });
        if (!demuxed) demuxed = await buildCastleDemuxEntry(castleStreams, serverUrlEarly);
      }
      const others = retry.filter((name) => name !== GATE_PROVIDER);
      results.push(...await Promise.all(others.map((name) => runProvider(name, { bypassBreaker: true }))));
    }
    // A provider still skipped by its breaker was never asked about this
    // title. Its answer is unknown, so this response must not be memoized as
    // complete for STREAMS_MEMO_MS or kept by the browser.
    for (const name of skippedByBreaker) {
      console.log(`[api] provider-unknown ${name} tmdbId=${tmdbId} reason=breaker-open`);
      erroredProviders.push(name);
    }
    let streams = [...castleStreams, ...results.flat()];
    // A provider can hand back a URL already past its stated expiry; it would
    // only 403 on play.
    const liveCount = urlExpiry.dropExpiredStreams(streams).length;
    if (liveCount !== streams.length) {
      console.log(`[api] url-expired dropped=${streams.length - liveCount} tmdbId=${tmdbId}`);
      streams = urlExpiry.dropExpiredStreams(streams);
    }
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

    const learn = { tmdbId, type, season, episode };
    streams = sortStreamsCanonically(streams, learn);
    // Read the first bytes of the top candidates before serving them. Runs
    // before routeStreamsForBrowser, which strips the upstream headers the
    // origin needs. Failures are demoted by the re-sort, never removed.
    streams = sortStreamsCanonically(await verifyTopStreams(streams, { skipPrefix: serverUrl }), learn);
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
      streams = sortStreamsCanonically(streams, learn);
    }

    const payload = { success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams };
    // Tells a client cache not to keep this answer: a provider was still
    // running when it went out, and the next request will include it.
    if (late.length) payload.partial = true;
    // A provider that threw is down right now, not missing the title. The
    // browser must not keep this answer either (HTTP cache or the web app's
    // sessionStorage), or a short upstream blip hides that server for minutes.
    if (erroredProviders.length) payload.providerErrors = [...erroredProviders];
    // A partial answer is missing a provider that is still running; any HTTP
    // cache that kept it (max-age=300) would hide that provider for 5 min.
    if (erroredProviders.length || late.length) {
      res.set('Cache-Control', 'no-store');
    } else {
      res.set('Cache-Control', `private, max-age=${STREAMS_CACHE_SECONDS}`);
    }
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
  const { season, episode, badSeason } = parseSeasonEpisode(req.query);
  if (badSeason) return res.status(400).json({ success:false, error: badSeason });
  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  if (!surfaceAllows(prov.name, surfaceOf(req.query))) {
    return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOR_WEB' });
  }
  if (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });
  if (!/^\d+$/.test(String(req.params.tmdbId))) {
    return res.status(400).json({ success:false, error:'INVALID_TMDB_ID' });
  }
  try {
    metrics.streamRequests++;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const t0 = Date.now();
    // Shares the aggregate route's per-provider cache and in-flight call. The
    // web asks /api/streams/netmirror/... after every playback start; that
    // used to be a fresh NetMirror fetch each time even when the aggregate had
    // just fetched it (prod 2026-11-18..20: 43 NetMirror fetches, 21 from the
    // aggregate), and NetMirror throttles per IP.
    const titleKey = `${type}:${tmdbId}:${season ?? ''}:${episode ?? ''}`;
    const ck = `${prov.name}|${titleKey}`;
    const refresh = req.query.refresh === '1';
    let raw = refresh ? undefined : providerHitGet(ck);
    // A provider failure keeps this route's old contract (200, count 0) and
    // says why in providerError, instead of a 500.
    let providerError = null;
    if (!raw && !refresh && providerEmptyCache.has(ck)) raw = [];
    if (!raw) {
      const o = await fetchProviderShared(prov, ck, { tmdbId, type, season, episode, imdbId, filters:{} },
        { titleIsResolvable: Boolean(imdbId), titleKey });
      if (o.outcome !== 'hit' && o.outcome !== 'empty') providerError = o.error || o.outcome;
      raw = o.streams;
    }
    let streams = urlExpiry.dropExpiredStreams(raw);
    if (streams.length !== raw.length) {
      console.log(`[api] url-expired dropped=${raw.length - streams.length} provider=${prov.name} tmdbId=${tmdbId}`);
    }
    const providerTimings = { [prov.name]: Date.now()-t0 };
    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    streams = sortStreamsCanonically(streams, { tmdbId, type, season, episode });
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
