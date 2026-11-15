'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// mapple.fun renamed its session endpoints by 2026-11-15. The old
// /api/playback-init answered 401 "Invalid request token", so the provider
// returned 0 streams on all 14 bench titles. Stub fetch and check the chain.
test('mapple calls /api/ui/session then /api/media-session', async (t) => {
    const calls = [];
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async (url, opts = {}) => {
        const u = new URL(String(url));
        calls.push(`${opts.method || 'GET'} ${u.pathname}`);
        const headers = { get: () => null, getSetCookie: () => [] };
        const res = (o, status = 200) => ({ ok: status < 400, status, headers, json: async () => o, text: async () => JSON.stringify(o) });
        if (u.pathname === '/api/ui/session') return res({ token: 'RT' });
        if (u.pathname === '/api/media-session') return res({ success: false }, 401);
        return res({});
    };
    delete require.cache[require.resolve('../providers/mapple')];
    const { getMappleStreams } = require('../providers/mapple');
    await getMappleStreams('693134', 'movie');
    assert.ok(calls.includes('POST /api/ui/session'), calls.join(', '));
    assert.ok(calls.includes('POST /api/media-session'), calls.join(', '));
    assert.ok(!calls.some((c) => c.includes('/api/request-token') || c.includes('/api/playback-init')));
});
