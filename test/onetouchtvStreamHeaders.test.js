'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { STREAM_HEADERS } = require('../providers/onetouchtv');

// Measured 2026-11-15 on akm-cdn-play.hitv.ltd (the OneTouchTV/loklok CDN):
// the signed playlist returns 200 with no Referer or with only a User-Agent,
// and 403 with Referer api3.devcorp.me or onetouchtv.xyz. The proxy forwards
// these headers, so every OneTouchTV row failed with "M3U8 fetch failed: 403"
// and the player could not switch to it.
test('OneTouchTV playback headers send no Referer', () => {
    assert.ok(STREAM_HEADERS, 'STREAM_HEADERS is exported');
    assert.equal(Object.keys(STREAM_HEADERS).some((k) => k.toLowerCase() === 'referer'), false);
    assert.ok(STREAM_HEADERS['User-Agent']);
});
