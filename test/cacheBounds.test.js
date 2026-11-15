'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('ttlCache evicts the oldest entry past its cap and expires by TTL', async () => {
    const { createTtlCache } = require('../lib/runtime/ttlCache');
    const c = createTtlCache({ ttlMs: 50, maxEntries: 3 });
    for (const k of ['a', 'b', 'c', 'd']) c.set(k, k);
    assert.equal(c.size, 3);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.get('d'), 'd');
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(c.get('d'), undefined);
});

// Before: the proxy segment cache was capped at 2000 ENTRIES only. HLS
// segments are 1-4 MB, so it could hold GBs while PM2 restarts the API at
// 500 MB. It is now capped in bytes as well.
test('proxy segment cache stays under its byte cap', () => {
    process.env.PROXY_SEGMENT_CACHE_MAX_BYTES = String(5 * 1024 * 1024);
    delete require.cache[require.resolve('../proxy/proxyServer')];
    const { _segmentCache } = require('../proxy/proxyServer');
    for (let i = 0; i < 20; i++) _segmentCache.cacheSegment(`https://cdn/seg${i}.ts`, new Uint8Array(1024 * 1024), {});
    const st = _segmentCache.stats();
    assert.ok(st.bytes <= 5 * 1024 * 1024, `bytes ${st.bytes}`);
    assert.equal(st.entries, 5);
    assert.ok(_segmentCache.getCachedSegment('https://cdn/seg19.ts'));
    assert.equal(_segmentCache.getCachedSegment('https://cdn/seg0.ts'), null);
});
