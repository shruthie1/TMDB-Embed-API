'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// providers/__nm_s.js is an unused copy of netmirror.js with no entry in the
// function map. The registry still listed it as enabled, so every fan-out ran
// it, it returned [] in ~4ms, and it counted toward its own breaker (prod
// 2026-11-15: __nm_s hit 0 / empty 8, trips 4) and showed up in providerTimings.
test('registry only lists provider files that have a mapped entry function', () => {
    const { listProviders } = require('../providers/registry');
    const names = listProviders().map((p) => p.name);
    assert.ok(!names.includes('__nm_s'), `listed: ${names.join(',')}`);
    assert.ok(names.includes('netmirror'));
    assert.ok(names.includes('castletv'));
});
