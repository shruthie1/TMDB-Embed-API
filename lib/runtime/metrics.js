'use strict';

// Runtime metrics and the per-provider circuit breaker.
//
// Extracted from apiServer.js, where a single `metrics` object was read and
// mutated from ~38 places. Threading that through function parameters would
// have been churn for its own sake; giving it a module with a named interface
// keeps the state in one file while the call sites stay as short as before.
//
// Counters are in-process; breaker state and provider latency are also
// persisted (utils/store.js) so they survive a restart. On serverless each instance keeps its own counters,
// so /api/status reports that instance only and the breaker protects that
// instance only - see lib/runtime/environment.js.

const { getStore } = require('../../utils/store');

const metrics = {
  startTime: Date.now(),
  requestsTotal: 0,
  streamRequests: 0,
  providerCalls: {},
  // Outcome, not just volume. providerCalls counts invocations, so a provider
  // that has silently returned zero for weeks looks identical to a healthy one
  // - that is how hdghartv and zxcstreams went dead unnoticed. Track hit/empty/
  // error/timeout per provider so /api/status can say which ones still earn
  // their place in the fan-out.
  providerHealth: {},
  lastRequestAt: null,
  lastError: null,
  streamsReturned: 0,
  tmdbToImdbLookups: 0
};

// A provider that has come back empty this many times in a row is skipped for
// COOLDOWN_MS rather than kept in the fan-out. Measured on 2026-09-21: videasy
// burned 8.4s of a 9.5s request to return nothing on every single call, so a
// consistently-empty provider is pure latency. This is a circuit breaker, not a
// permanent disable - the config flag stays untouched, and one probe is allowed
// through after the cooldown so a provider that recovers (or a network block
// that gets lifted) comes back on its own without anyone editing config.
const BREAKER_THRESHOLD = Number(process.env.PROVIDER_BREAKER_THRESHOLD) || 5;
const BREAKER_COOLDOWN_MS = Number(process.env.PROVIDER_BREAKER_COOLDOWN_MS) || 10 * 60 * 1000;

// outcome: 'hit' | 'empty' | 'error' | 'timeout'
// titleKey (optional) names the title asked for. Repeated empties for the SAME
// title count once: they say the provider lacks that title, not that it is
// down. Prod 2026-11-15: 5 retries of one title Castle lacks tripped Castle,
// the only live provider, and every title returned 0 streams for 10 minutes.
// Breaker state lives in provider_health (utils/store.js) so a trip, and the
// evidence that a provider never works, survive a restart or deploy. Before
// this, every pm2 restart handed a dead provider a clean slate and its full
// deadline again. Counters (hit/empty/...) stay per-process: they are the
// /api/status view of THIS run.
function persisted(name) {
  try { return getStore().providerHealth(name); } catch { return null; }
}
function persist(name, h, extra = {}) {
  try {
    getStore().saveProviderHealth(name, {
      consecutive_misses: h.consecutiveMisses || 0,
      tripped_until: h.trippedUntil || null,
      trips: h.trips || 0,
      last_miss_title: h.lastMissTitle || null,
      last_ok_at: h.lastOkAt || null,
      ...extra,
    });
  } catch (e) {
    console.warn(`[api] provider_health write failed for ${name}: ${e.message}`);
  }
}
function healthEntry(name) {
  let h = metrics.providerHealth[name];
  if (h) return h;
  h = metrics.providerHealth[name] = {
    hit: 0, empty: 0, error: 0, timeout: 0, streams: 0, lastMs: null, lastOkAt: null, lastErr: null,
    consecutiveMisses: 0, trippedUntil: null, trips: 0,
  };
  const row = persisted(name);
  if (row) {
    h.consecutiveMisses = row.consecutive_misses || 0;
    h.trippedUntil = row.tripped_until || null;
    h.trips = row.trips || 0;
    h.lastMissTitle = row.last_miss_title || null;
    h.lastOkAt = row.last_ok_at || null;
  }
  return h;
}

// Latency EWMA weight, as ott's provider_health.
const EMA_ALPHA = 0.4;
// ott budgetFor: a provider with at least this many judged attempts and no
// success ever gets PROBATION_MS instead of the full deadline.
const MIN_ATTEMPTS_TO_JUDGE = 5;
const PROBATION_MS = 8000;

function recordProviderOutcome(name, outcome, ms, streamCount, countsTowardBreaker = true, titleKey = null) {
  const h = healthEntry(name);
  h[outcome] = (h[outcome] || 0) + 1;
  if (typeof ms === 'number') h.lastMs = ms;
  if (outcome === 'hit') {
    h.streams += streamCount || 0;
    h.lastOkAt = Date.now();
    // Any success clears the breaker outright - a provider that works is not
    // on probation for its past.
    h.consecutiveMisses = 0;
    h.trippedUntil = null;
    h.lastMissTitle = null;
  } else if ((outcome === 'empty' || outcome === 'error') && titleKey && h.lastMissTitle === titleKey) {
    // Same title missed again (empty or error): already counted once. Errors
    // follow the same rule: one title whose upstream page is broken must not
    // trip the breaker for every title.
  } else if ((outcome === 'empty' || outcome === 'error') && countsTowardBreaker === false) {
    // An empty result for a title that does not exist upstream says nothing
    // about the provider's health, so it must not count toward the breaker.
    // Measured 2026-09-21: a few requests for a nonexistent tmdbId pushed
    // onetouchtv to consecutiveMisses=5 - one short of tripping - while the
    // provider was working perfectly for real titles.
  } else {
    if (outcome === 'empty' || outcome === 'error') h.lastMissTitle = titleKey;
    h.consecutiveMisses = (h.consecutiveMisses || 0) + 1;
    if (h.consecutiveMisses >= BREAKER_THRESHOLD && !h.trippedUntil) {
      h.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
      h.trips = (h.trips || 0) + 1;
      console.warn(`[api] provider ${name} tripped breaker after ${h.consecutiveMisses} consecutive misses; skipping for ${Math.round(BREAKER_COOLDOWN_MS/60000)}m`);
    }
  }
  // Probation evidence. An 'empty' is not judged: the provider answered and
  // simply lacks the title, and the breaker already handles a provider that
  // is empty for everything. Only a hit, an error or a timeout counts, and
  // only when the title is real (countsTowardBreaker).
  const row = persisted(name) || {};
  const extra = {};
  if (countsTowardBreaker !== false && (outcome === 'hit' || outcome === 'error' || outcome === 'timeout')) {
    extra.attempts = (row.attempts || 0) + 1;
    extra.successes = (row.successes || 0) + (outcome === 'hit' ? 1 : 0);
  }
  if (outcome === 'hit' && typeof ms === 'number' && ms >= 0) {
    const ema = row.ema_latency_ms;
    extra.ema_latency_ms = ema == null ? Math.round(ms) : Math.round(EMA_ALPHA * ms + (1 - EMA_ALPHA) * ema);
  }
  persist(name, h, extra);
}

/**
 * How long to let a provider run. A provider that has been judged (>= 5
 * hit/error/timeout attempts on real titles) and has NEVER succeeded gets
 * PROBATION_MS; everything else gets the full deadline unchanged.
 */
function budgetFor(name, fullBudgetMs) {
  const row = persisted(name);
  if (!row) return fullBudgetMs;
  if ((row.attempts || 0) < MIN_ATTEMPTS_TO_JUDGE) return fullBudgetMs;
  if ((row.successes || 0) > 0) return fullBudgetMs;
  return Math.min(PROBATION_MS, fullBudgetMs);
}

/** Persisted latency EWMA in ms, or null when the provider never hit. */
function latencyEwma(name) {
  const row = persisted(name);
  return row && row.ema_latency_ms != null ? row.ema_latency_ms : null;
}

// Returns true when the provider should be skipped right now. Expiring the
// cooldown resets the miss counter so exactly one probe call goes through; if
// that probe misses too, the breaker trips again immediately.
function breakerOpen(name) {
  // Read through healthEntry so a breaker tripped before a restart is still
  // open after it.
  const h = metrics.providerHealth[name] || (persisted(name) ? healthEntry(name) : null);
  if (!h || !h.trippedUntil) return false;
  if (Date.now() < h.trippedUntil) return true;
  h.trippedUntil = null;
  h.consecutiveMisses = BREAKER_THRESHOLD - 1;
  h.lastMissTitle = null;
  persist(name, h);
  console.log(`[api] provider ${name} breaker cooled down; allowing one probe`);
  return false;
}

// Express middleware: count every request.
function requestCounter(req, res, next) {
  metrics.requestsTotal++;
  metrics.lastRequestAt = Date.now();
  next();
}

module.exports = {
  metrics,
  recordProviderOutcome,
  breakerOpen,
  budgetFor,
  latencyEwma,
  requestCounter,
  PROBATION_MS,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
};
