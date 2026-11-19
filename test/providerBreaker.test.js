'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Fresh module per test: metrics.js keeps its state in a module-level object.
const MOD = require.resolve('../lib/runtime/metrics');
function fresh() { delete require.cache[MOD]; return require('../lib/runtime/metrics'); }

// Prod 2026-11-15 19:01-19:02 UTC: castletv got 5 requests for the SAME title
// (tmdb 1376856, which Castle does not carry). Empty results are not memoized,
// so each retry re-ran Castle, and the 5 empties tripped its breaker. Castle was
// the only provider still returning streams from the VM, so every title then
// returned count:0 instantly for 10 minutes.
test('repeated empty results for one title do not trip the breaker', () => {
    const m = fresh();
    for (let i = 0; i < m.BREAKER_THRESHOLD + 2; i++) {
        m.recordProviderOutcome('castletv', 'empty', 400, 0, true, 'movie:1376856::');
    }
    assert.equal(m.breakerOpen('castletv'), false);
    assert.equal(m.metrics.providerHealth.castletv.consecutiveMisses, 1);
    assert.equal(m.metrics.providerHealth.castletv.empty, m.BREAKER_THRESHOLD + 2);
});

test('empty results across distinct titles still trip the breaker', () => {
    const m = fresh();
    for (let i = 0; i < m.BREAKER_THRESHOLD; i++) {
        m.recordProviderOutcome('videasy', 'empty', 8000, 0, true, `movie:${1000 + i}::`);
    }
    assert.equal(m.breakerOpen('videasy'), true);
});

test('callers without a title key keep the old counting', () => {
    const m = fresh();
    for (let i = 0; i < m.BREAKER_THRESHOLD; i++) m.recordProviderOutcome('x', 'empty', 1, 0);
    assert.equal(m.breakerOpen('x'), true);
});

// Errors now follow the same-title rule. Since 2026-11-19 an upstream 404 on
// one title's episode page is an 'error', not an 'empty' (it is no longer
// cached as empty), so five retries of that one title must not trip the
// provider for every title. Errors across titles still trip it.
test('errors for one title count once; errors across titles trip', () => {
    const m = fresh();
    for (let i = 0; i < m.BREAKER_THRESHOLD; i++) {
        m.recordProviderOutcome('y', 'error', 1, 0, true, 'movie:1::');
    }
    assert.equal(m.breakerOpen('y'), false);
    for (let i = 0; i < m.BREAKER_THRESHOLD; i++) {
        m.recordProviderOutcome('z', 'error', 1, 0, true, `movie:${i}::`);
    }
    assert.equal(m.breakerOpen('z'), true);
});
