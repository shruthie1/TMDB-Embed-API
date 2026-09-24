'use strict';

// Runtime metrics and the per-provider circuit breaker.
//
// Extracted from apiServer.js, where a single `metrics` object was read and
// mutated from ~38 places. Threading that through function parameters would
// have been churn for its own sake; giving it a module with a named interface
// keeps the state in one file while the call sites stay as short as before.
//
// Deliberately in-process. On serverless each instance keeps its own counters,
// so /api/status reports that instance only and the breaker protects that
// instance only - see lib/runtime/environment.js.

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
function recordProviderOutcome(name, outcome, ms, streamCount, countsTowardBreaker = true) {
  const h = metrics.providerHealth[name] || (metrics.providerHealth[name] = {
    hit: 0, empty: 0, error: 0, timeout: 0, streams: 0, lastMs: null, lastOkAt: null, lastErr: null,
    consecutiveMisses: 0, trippedUntil: null, trips: 0,
  });
  h[outcome] = (h[outcome] || 0) + 1;
  if (typeof ms === 'number') h.lastMs = ms;
  if (outcome === 'hit') {
    h.streams += streamCount || 0;
    h.lastOkAt = Date.now();
    // Any success clears the breaker outright - a provider that works is not
    // on probation for its past.
    h.consecutiveMisses = 0;
    h.trippedUntil = null;
  } else if (outcome === 'empty' && countsTowardBreaker === false) {
    // An empty result for a title that does not exist upstream says nothing
    // about the provider's health, so it must not count toward the breaker.
    // Measured 2026-09-21: a few requests for a nonexistent tmdbId pushed
    // onetouchtv to consecutiveMisses=5 - one short of tripping - while the
    // provider was working perfectly for real titles.
  } else {
    h.consecutiveMisses = (h.consecutiveMisses || 0) + 1;
    if (h.consecutiveMisses >= BREAKER_THRESHOLD && !h.trippedUntil) {
      h.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
      h.trips = (h.trips || 0) + 1;
      console.warn(`[api] provider ${name} tripped breaker after ${h.consecutiveMisses} consecutive misses; skipping for ${Math.round(BREAKER_COOLDOWN_MS/60000)}m`);
    }
  }
}

// Returns true when the provider should be skipped right now. Expiring the
// cooldown resets the miss counter so exactly one probe call goes through; if
// that probe misses too, the breaker trips again immediately.
function breakerOpen(name) {
  const h = metrics.providerHealth[name];
  if (!h || !h.trippedUntil) return false;
  if (Date.now() < h.trippedUntil) return true;
  h.trippedUntil = null;
  h.consecutiveMisses = BREAKER_THRESHOLD - 1;
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
  requestCounter,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
};
