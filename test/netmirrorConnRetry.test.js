'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { nmFetch } = require('../providers/netmirror');

function connErr(code) {
    const e = new TypeError('fetch failed');
    e.cause = { code };
    return e;
}

// Prod VM 2026-11-15: most TLS handshakes to the NetMirror mirrors were reset
// (ECONNRESET in ~60ms), and every lookup gave up after one try per mirror,
// so NetMirror returned 0 on 12 of 14 bench titles while local returned 13.
test('nmFetch retries a reset connection and returns the later success', async () => {
    let n = 0;
    const fake = async () => { n++; if (n < 3) throw connErr('ECONNRESET'); return { ok: true, n }; };
    const r = await nmFetch('https://net27.cc/x', {}, fake);
    assert.equal(r.ok, true);
    assert.equal(n, 3);
});

test('nmFetch does not retry a non-connection error', async () => {
    let n = 0;
    const fake = async () => { n++; throw connErr('ENOTFOUND'); };
    await assert.rejects(nmFetch('https://iosmirror.cc/x', {}, fake));
    assert.equal(n, 1);
});

test('nmFetch gives up after the retry limit', async () => {
    let n = 0;
    const fake = async () => { n++; throw connErr('ECONNRESET'); };
    await assert.rejects(nmFetch('https://net27.cc/x', {}, fake));
    assert.ok(n > 1 && n <= 10, `attempts ${n}`);
});
