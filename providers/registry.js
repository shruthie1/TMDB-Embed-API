const { config } = require('../utils/config');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const { normaliseStreams } = require('../utils/streamSchema');

// Lazy load cache for providers
const providerCache = new Map();

// Function name mappings for existing providers
const providerFunctionMap = {
  'Showbox.js': 'getStreamsFromTmdbId',
  '4khdhub.js': 'get4KHDHubStreams',
  'vixsrc.js': 'getVixsrcStreams',
  'videasy.js': 'getVideasyStreams',
  'vidlink.js': 'getVidlinkStreams',
  'dahmermovies.js': 'getDahmermoviesStreams',
  'streamflix.js': 'getStreamflixStreams',
  'vaplayer.js': 'getVaplayerStreams',
  'castletv.js': 'getCastletvStreams',
  'hdghartv.js': 'getHdghartvStreams',
  'netmirror.js': 'getNetmirrorStreams',
  'onetouchtv.js': 'getOnetouchtvStreams',
  'zxcstreams.js': 'getZxcstreamsStreams',
  'showsst.js': 'getShowsstStreams',
  'mapple.js': 'getMappleStreams',
  'multimovies.js': 'getMultimoviesStreams',
  'vidrock.js': 'getVidrockStreams',
  'vidrift.js': 'getVidriftStreams',
};

// Per-request cookie context.
//
// Showbox reads (and writes back to) global.currentRequestConfig from ~9 call
// sites deep inside a 3000-line module. The previous save/restore around an
// await was not concurrency-safe: two overlapping Showbox requests interleaved
// and stomped each other's cookie, which is why a search for one title showed
// up inside another title's request.
//
// AsyncLocalStorage gives each request its own store that follows the async
// call chain, so those existing reads stay correct without rewriting Showbox.
// global.currentRequestConfig is redefined as an accessor onto the active
// store, falling back to a shared object when no request is in flight.
const requestContext = new AsyncLocalStorage();
const fallbackConfig = {};

Object.defineProperty(global, 'currentRequestConfig', {
  configurable: true,
  get() { const store = requestContext.getStore(); return store ? store.cfg : fallbackConfig; },
  set(v) { const store = requestContext.getStore(); if (store) store.cfg = v || {}; else Object.assign(fallbackConfig, v || {}); },
});

Object.defineProperty(global, 'currentRequestUserCookieRemainingMB', {
  configurable: true,
  get() { const store = requestContext.getStore(); return store ? store.remainingMB : fallbackConfig.__remainingMB; },
  set(v) { const store = requestContext.getStore(); if (store) store.remainingMB = v; else fallbackConfig.__remainingMB = v; },
});

// Stats for debug endpoint
let lastCookieStats = { selected: null, index: null, total: 0, remainingMB: null, timestamp: null };

async function getEffectiveCookies() {
  return Array.isArray(config.febboxCookies) ? config.febboxCookies : [];
}

// Get all provider files
function getProviderFiles() {
  const providersDir = path.join(__dirname);
  return fs.readdirSync(providersDir)
    // Only files with an entry function. An unmapped file (providers/__nm_s.js,
    // an old netmirror copy) otherwise ran on every request and returned [].
    .filter(file => file.endsWith('.js') && file !== 'registry.js' && providerFunctionMap[file])
    .map(file => ({
      name: path.parse(file).name.toLowerCase(),
      file: file,
      functionName: providerFunctionMap[file]
    }));
}

// Load a provider module
function loadProvider(providerFile) {
  if (!providerCache.has(providerFile)) {
    try {
      providerCache.set(providerFile, require(path.join(__dirname, providerFile)));
    } catch (e) {
      console.error(`Failed to load provider ${providerFile}:`, e.message);
      return null;
    }
  }
  return providerCache.get(providerFile);
}

// Domain self-healing (utils/upstreamBase.js) for providers that export
// UPSTREAM. A throw, a timeout, or an empty answer on a title every source
// should carry counts toward the streak; an empty answer on any other title
// is a catalogue gap and counts for nothing. Crossing the streak starts a
// rediscover in the background; this request is never held for it.
const upstream = require('../utils/upstreamBase');
const { classify, classifyAndLog, shouldHeal } = require('../lib/selfheal/classify');
const keys = require('../lib/selfheal/keys');
const proof = require('../lib/selfheal/proof');
// ott tierprobe TIER_TITLES: Inception, Dune 2, Breaking Bad.
const MAINSTREAM_IDS = new Set(['27205', '693134', '1396']);
const VERIFY_TITLE = { tmdbId: '27205', mediaType: 'movie' };

/**
 * The verify a candidate host must pass before adoption (review I3):
 *   1. the provider's cheap validator, when it has one (run.validate);
 *   2. the provider's own resolve of its validation title, pinned to the
 *      candidate (one budget GET; run.ownResolve when the run must pin more);
 *   3. proof that the answer is THAT film: run.titleProven (provider-side id
 *      or title match on the candidate itself), else the HLS duration of one
 *      row against the TMDB runtime (lib/selfheal/proof.js). The answer's
 *      shape alone never adopts a host.
 */
function makeVerify(u, fn, run, budget) {
  const verifyTitle = u.verifyTitle || VERIFY_TITLE;
  return (candidate, ctx) => upstream.withBase(u.name, candidate, async () => {
    if (run && run.validate && !(await run.validate(candidate, ctx))) return false;
    if (!budget.charge(1)) {
      console.warn(`[heal] ${u.name} reject ${candidate} cap ${budget.max} GETs`);
      return false;
    }
    const r = run && typeof run.ownResolve === 'function'
      ? await run.ownResolve(candidate, fn, verifyTitle)
      : await fn(verifyTitle.tmdbId, verifyTitle.mediaType, null, null);
    if (!(Array.isArray(r) && r.length > 0)) {
      console.warn(`[heal] ${u.name} reject ${candidate} own-resolve-empty`);
      return false;
    }
    if (run && typeof run.titleProven === 'function') {
      const p = await run.titleProven(candidate, ctx, r);
      if (p === true) {
        console.warn(`[heal] ${u.name} title-proof ${candidate} ok by provider`);
        return true;
      }
      if (p === false) {
        console.warn(`[heal] ${u.name} reject ${candidate} title-mismatch`);
        return false;
      }
    }
    // The rows came from the provider's own fetch (global fetch), so the
    // proof reads them the same way; node-fetch drew HTTP 403 from the
    // vidrock and vaplayer CDNs (laptop, 2026-11-21 17:43Z).
    return proof.titleProof(u.name, candidate, r, verifyTitle.tmdbId, budget.wrap(proof.proofFetch()));
  });
}

// Review I4: a host imported from the legacy data/provider-bases.json is
// held back until it passes this provider's verify once (first use).
function checkLegacy(providerInfo, module) {
  const u = module && module.UPSTREAM;
  if (!u || !upstream.legacyPending(u.name)) return;
  const run = typeof u.healRun === 'function' ? u.healRun() : null;
  const budget = (run && run.budget) || proof.createBudget();
  console.warn(`[heal] ${u.name} legacy-verify start`);
  upstream.verifyLegacy(u.name, makeVerify(u, module[providerInfo.functionName], run, budget))
    .catch((e) => console.warn(`[heal] ${u.name} legacy-verify failed: ${e.message}`));
}

// Task 6: the key heal run for a provider that exports keyHeal (vidrock,
// onetouchtv). Built only when a run starts. The found key is checked by the
// same verify as a host (own resolve + title proof) on the current host,
// under a trial (lib/selfheal/keys.js withTrial), before it is saved.
function keyHealFactory(providerInfo, module) {
  return () => {
    const u = module.UPSTREAM;
    const run = typeof u.healRun === 'function' ? u.healRun() : null;
    const budget = (run && run.budget) || proof.createBudget();
    const kh = module.keyHeal(budget.wrap(proof.proofFetch()));
    const verify = makeVerify(u, module[providerInfo.functionName], run, budget);
    // Review I1: no new key -> one host rediscover (null inside its cooldown).
    return { ...kh, verify: () => verify(upstream.getBase(u.name, u.seed), {}), fallback: () => startRediscover(providerInfo, module) };
  };
}

function noteUpstream(providerInfo, module, outcome, ctx, err = null) {
  const u = module && module.UPSTREAM;
  if (!u) return;
  if (outcome === 'ok') { upstream.noteOk(u.name); keys.noteKeyOk(u.name); return; }
  // Soak 1 (2026-11-22 09:12:54Z): a provider error marked titleEmpty (the
  // host answered, its page parsed, the title has no rows: vidrift
  // orionStreams null, VidBolt 2xx with no source) is an empty, not a fail.
  // It never feeds the host streak or a rediscover, except on the provider's
  // own validation title (the empty rule below).
  if (outcome === 'fail' && err && err.titleEmpty === true) {
    console.warn(`[heal] ${u.name} title-empty ${ctx.tmdbId} not a host fail`);
    outcome = 'empty';
    err = null;
  }
  // A key failure (GCM tag, CBC padding) is not a move: it counts toward the
  // key streak (3) only, never the host streak.
  if (err && typeof module.keyHeal === 'function') {
    if (classify({ message: err.message, status: err.status }) === 'key') {
      keys.noteKeyFail(u.name, keyHealFactory(providerInfo, module));
      return;
    }
    keys.noteKeyOk(u.name);
  }
  // Empty answers count only on the provider's own validation title (review
  // M8: a provider that never carries Inception must not count it), or on
  // the mainstream titles when the provider names none.
  const countsEmpty = u.verifyTitle
    ? String(ctx.tmdbId) === String(u.verifyTitle.tmdbId)
    : MAINSTREAM_IDS.has(String(ctx.tmdbId));
  if (outcome === 'empty' && !countsEmpty) return;
  if (upstream.noteFail(u.name) < upstream.FAIL_STREAK) return;
  // Review I1: a Cloudflare challenge (blocked, incl. HTTP 403), a throttle
  // (HTTP 429) or a 5xx is not a move: rediscovering only spends requests.
  // A timeout or a reset streak may be a move, so it heals (the old rule).
  if (err) {
    const r = classifyAndLog(u.name, { message: err.message, status: err.status }, { full: true });
    if (!shouldHeal(r)) {
      console.warn(`[heal] ${u.name} skip rediscover (${r.kind} ${r.rule})`);
      return;
    }
  }
  console.warn(`[registry] ${providerInfo.name} failed ${upstream.failStreak(u.name)}x in a row on ${upstream.getBase(u.name, u.seed)} - rediscovering`);
  startRediscover(providerInfo, module);
}

// One host rediscover with this provider's heal run. Returns the run's
// promise, or null inside the 30-min cooldown (upstreamBase).
function startRediscover(providerInfo, module) {
  const u = module.UPSTREAM;
  const fn = module[providerInfo.functionName];
  const current = upstream.getBase(u.name, u.seed);
  // A provider-specific heal run (extra config hosts, lazy trails, a cheap
  // validator that runs before the full resolve). See lib/selfheal/vidbolt.js.
  const run = typeof u.healRun === 'function' ? u.healRun() : null;
  // One 12-GET budget for the whole run (review M6): redirects, player scans,
  // trails, validation, each own resolve and the title proof.
  const budget = (run && run.budget) || proof.createBudget();
  return upstream.triggerRediscover(u.name, {
    seed: u.seed,
    player: u.player ? u.player(current) : undefined,
    aggregatorSlug: u.aggregatorSlug,
    extra: run ? run.extra : undefined,
    trails: run ? run.trails : undefined,
    budget,
    // Pending path heals are saved only after their host passed (review I2).
    onApplied: run && typeof run.onApplied === 'function' ? run.onApplied : undefined,
    verify: makeVerify(u, fn, run, budget),
  });
}

/**
 * The canary's heal (Task 7/8): one run for a host or key failure, under the
 * same cooldowns and the same verify as the request path. Returns
 * { applied, how }. Logs `[heal] <name> canary <kind> ...`.
 */
async function healNow(name, kind) {
  const info = providerFiles.find((p) => p.name === String(name).toLowerCase());
  const module = info && loadProvider(info.file);
  const u = module && module.UPSTREAM;
  if (!u) { console.warn(`[heal] ${name} canary ${kind} skip (no UPSTREAM)`); return { applied: false }; }
  if (kind === 'host') {
    const p = startRediscover(info, module);
    if (!p) { console.warn(`[heal] ${name} canary host skip (cooldown or running)`); return { applied: false }; }
    const r = await p;
    const c = r && r.applied && (r.candidates || []).find((x) => x.url === r.applied);
    console.warn(`[heal] ${name} canary host ${r && r.applied ? `applied ${r.applied}` : 'none'}`);
    return { applied: Boolean(r && r.applied), how: c ? `host:${c.how}` : (r && r.applied ? 'host' : null) };
  }
  if (kind === 'key' && typeof module.keyHeal === 'function') {
    const ok = await keys.healNow(u.name, keyHealFactory(info, module));
    if (ok === 'host') return { applied: true, how: 'host:key-fallback' };
    return { applied: ok === true, how: ok === true ? 'key:bundle' : null };
  }
  console.warn(`[heal] ${name} canary ${kind} skip (no heal for this kind)`);
  return { applied: false };
}

/** UPSTREAM.verifyTitle for name, or null (the canary's validation title). */
function verifyTitleOf(name) {
  const info = providerFiles.find((p) => p.name === String(name).toLowerCase());
  const module = info && loadProvider(info.file);
  return (module && module.UPSTREAM && module.UPSTREAM.verifyTitle) || null;
}

// Create fetch function for a provider
function createFetchFunction(providerInfo) {
  return async function(ctx) {
    const module = loadProvider(providerInfo.file);
    if (!module) return [];

    const funcName = providerInfo.functionName;
    if (!module[funcName]) {
      console.error(`Provider ${providerInfo.name} does not export ${funcName}`);
      return [];
    }

    checkLegacy(providerInfo, module);
    try {
      const mediaType = ctx.type === 'movie' ? 'movie' : 'tv';
      const t0 = Date.now();

      let result;
      if (providerInfo.name === 'showbox') {
        // Special case for Showbox with TMDB key and cookies
        const { getTmdbApiKey } = require('../utils/tmdbKey');
        const tmdbApiKey = getTmdbApiKey();
        if (!tmdbApiKey) {
          console.warn('[registry] showbox skipped: TMDB API key missing');
          return [];
        }
        const cookies = await getEffectiveCookies();
        let selected = null;
        let statsForThisRequest = null;
        // Run the whole Showbox resolve inside its own async context so the
        // cookie it picks cannot be seen or overwritten by a concurrent request.
        return await requestContext.run({ cfg: {}, remainingMB: null }, async () => {
        if (cookies.length > 0) {
          const index = Math.floor(Math.random() * cookies.length);
          selected = cookies[index];
          global.currentRequestConfig.cookie = selected.startsWith('ui=') ? selected : `ui=${selected}`;
          global.currentRequestConfig.cookies = cookies.map(c => c.startsWith('ui=') ? c : `ui=${c}`);
          // Build this request's stats object locally; publish it only at the
          // end. A concurrent request mutating the shared slot mid-flight used
          // to let one request's cookie pair up with another's remainingMB.
          statsForThisRequest = { selected: selected.slice(0, 16) + '...', index, total: cookies.length, remainingMB: null, timestamp: Date.now() };
          lastCookieStats = statsForThisRequest;
          console.log(`[registry] Cookie random pick index=${index} total=${cookies.length}`);
        }
        const out = await module[funcName](mediaType, ctx.tmdbId, ctx.season || null, ctx.episode || null, null, selected);
        if (statsForThisRequest && global.currentRequestUserCookieRemainingMB != null) {
          // Write through our own object, then re-publish, so we never stamp a
          // remainingMB onto a newer request's stats.
          statsForThisRequest.remainingMB = global.currentRequestUserCookieRemainingMB;
          lastCookieStats = statsForThisRequest;
        }
        const ms = Date.now() - t0;
        console.log(`[registry] ${providerInfo.name} fetch duration ${ms}ms`);
        if (!Array.isArray(out)) return [];
        return normaliseStreams(out.map(s => ({ ...s, provider: s.provider || providerInfo.name })));
        });
      } else {
        // Standard provider call, under a wall-clock cap.
        //
        // Providers already run concurrently, so total resolve time is set by
        // the SLOWEST one, not the sum. Without a cap a single unreachable
        // origin holds up every other provider's results. Measured 2026-09-23
        // on 628241: castletv 616ms, netmirror 1ms, onetouchtv 281ms, showsst
        // 650ms, mapple 2578ms - all done inside 2.6s - while vaplayer sat at
        // 8577ms waiting on a host that answers 522, making the request 10.1s.
        //
        // A provider that exceeds the cap yields nothing rather than delaying
        // everyone. It is a LATENCY bound, not a correctness one: a slow
        // provider's streams are dropped for this request only, and the fast
        // providers' results still reach the player.
        result = await withDeadline(
          module[funcName](ctx.tmdbId, mediaType, ctx.season || null, ctx.episode || null),
          PROVIDER_DEADLINE_MS,
          providerInfo.name);
      }

      const durationMs = Date.now() - t0;
      console.log(`[registry] ${providerInfo.name} fetch duration ${durationMs}ms`);

      // The aggregate route records this as a 'timeout', not an 'empty'.
      if (result === TIMED_OUT) {
        noteUpstream(providerInfo, module, 'fail', ctx, new Error(`timeout after ${PROVIDER_DEADLINE_MS}ms`));
        const out = []; out.timedOut = true; return out;
      }

      if (!Array.isArray(result)) return [];
      if (!(result.upstreamError && result.length === 0)) {
        noteUpstream(providerInfo, module, result.length ? 'ok' : 'empty', ctx);
      }

      // A provider marks `upstreamError` on its result when part of its
      // upstream failed. With no rows that is a failure, not an empty; with
      // rows the marker must survive normalisation so the caller does not
      // cache an incomplete answer.
      if (result.upstreamError && result.length === 0) {
        throw Object.assign(new Error(String(result.upstreamError)), result.titleEmpty === true ? { titleEmpty: true } : {});
      }

      // Add provider name if not present, then normalise to the canonical
      // stream contract (utils/streamSchema.js) so every provider's output
      // is shaped identically regardless of what that provider emits.
      const out = normaliseStreams(result.map(s => ({ ...s, provider: s.provider || providerInfo.name })));
      if (result.upstreamError) out.upstreamError = result.upstreamError;
      return out;

    } catch (e) {
      // Rethrow. The caller records a provider failure as an 'error' and
      // does not cache it; returning [] here made every upstream outage look
      // like "this title has no streams" for PROVIDER_EMPTY_TTL_MS.
      console.error(`[registry] ${providerInfo.name} fetch error:`, e.message);
      noteUpstream(providerInfo, module, 'fail', ctx, e);
      throw e;
    }
  };
}

// Cap how long any one provider may hold up a resolve.
//
// Sized off MEASURED cold-cache work, not a round number. Measured 2026-09-23:
// onetouchtv 99ms, showsst 252ms, castletv 485-1541ms, mapple 1160-3214ms,
// vaplayer 2822ms (after its probe fix), netmirror 7330-9226ms cold / ~0ms warm
// - netmirror is genuinely slow because it ffprobes the mp4 for audio language.
//
// A first pass at 6000ms cut netmirror off and silently dropped the Telugu
// track it exists to provide, which is a correctness loss dressed up as a
// speed win. The cap must sit ABOVE the slowest honest provider and only catch
// origins that are hung.
// 12000ms was still cutting it fine: netmirror measured 9226ms cold on 912649,
// and a cold ffprobe plus a slow mirror can exceed that. Dropping the provider
// there does not just cost a stream, it costs the AUDIO LANGUAGE on a stream we
// would otherwise have - so the cap is set above the worst measured cold run
// with headroom, and exists only to catch an origin that is genuinely hung.
const PROVIDER_DEADLINE_MS = Number(process.env.PROVIDER_DEADLINE_MS) || 20000;
const TIMED_OUT = Symbol('timedOut');

// Resolves to [] if the provider overruns. The underlying promise is NOT
// cancellable, so it is left to settle on its own; attaching a catch here
// keeps an late rejection from surfacing as an unhandled rejection.
function withDeadline(promise, ms, name) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[registry] ${name} exceeded ${ms}ms deadline - dropping its results for this request`);
      resolve(TIMED_OUT);
    }, ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Initialize providers - always load all; enabled state is checked dynamically from live config
const providerFiles = getProviderFiles();
const providers = [];

for (const providerInfo of providerFiles) {
  providers.push({
    name: providerInfo.name,
    fetch: createFetchFunction(providerInfo)
  });
  console.log(`[registry] ${providerInfo.name} provider loaded`);
}

function isProviderEnabled(name) {
  const flag = `enable${name.charAt(0).toUpperCase() + name.slice(1)}Provider`;
  return config[flag] !== false;
}

function listProviders() { return providers.map(p => ({ name: p.name, enabled: isProviderEnabled(p.name) })); }
function getProvider(name) {
  const p = providers.find(p => p.name === name.toLowerCase());
  if (!p) return null;
  return { ...p, enabled: isProviderEnabled(p.name) };
}

function getCookieStats() { return lastCookieStats; }

module.exports = { listProviders, getProvider, getCookieStats, PROVIDER_DEADLINE_MS, healNow, verifyTitleOf, _noteUpstream: noteUpstream, _checkLegacy: checkLegacy, _makeVerify: makeVerify };
