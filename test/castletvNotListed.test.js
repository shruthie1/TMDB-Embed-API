'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createCipheriv } = require('crypto');

// Audit 11-24: 4 of 4 castletv breaker trips came from empties (61 were
// "no-playable isPreview"), then 112 skips over 29 titles. Castle answering
// "not in my catalogue" (search miss, no confident match, preview/VIP-gated
// only) is notListed, so the fan-out keeps it out of the breaker. A failed
// video call is still an error.
function stub(rel, exports) {
    const id = require.resolve(path.join(__dirname, '..', rel));
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
const realTmdb = require('../utils/tmdb');
stub('utils/tmdb.js', { ...realTmdb, getDetails: async () => ({ title: 'Amaran', release_date: '2024-10-31' }) });
const castle = require('../providers/castletv');

const SEC = Buffer.from('0123456789abcdef').toString('base64');
function enc(obj) {
    const key = castle._deriveKey(SEC);
    const c = createCipheriv('aes-128-cbc', key, key);
    return Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]).toString('base64');
}
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
function route({ rows, video }) {
    global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('getSecurityKey')) return new Response(JSON.stringify({ code: 200, data: SEC }), { status: 200 });
        if (u.includes('searchByKeyword')) return new Response(JSON.stringify({ data: enc({ data: { rows } }) }), { status: 200 });
        if (/\/movie\?/.test(u)) {
            return new Response(JSON.stringify({ data: enc({ data: { episodes: [{ id: 11, number: 1, tracks: [{ languageId: 1, languageName: 'Tamil', isDefault: true }] }] } }) }), { status: 200 });
        }
        if (u.includes('getVideo')) return video();
        return new Response('', { status: 404 });
    };
}

test('castletv: search with no rows is notListed', async () => {
    route({ rows: [] });
    const out = await castle.getCastletvStreams('927342', 'movie');
    assert.deepEqual([...out], []);
    assert.equal(out.notListed, true);
});

test('castletv: no confident title match is notListed', async () => {
    route({ rows: [{ id: 5, title: 'Something Else Entirely' }] });
    const out = await castle.getCastletvStreams('927342', 'movie');
    assert.equal(out.notListed, true);
});

test('castletv: every video answer isPreview is notListed (not a provider failure)', async () => {
    route({ rows: [{ id: 5, title: 'Amaran' }],
        video: () => new Response(JSON.stringify({ data: enc({ data: { isPreview: true, videoUrl: 'https://x/index_preview_1.m3u8' } }) }), { status: 200 }) });
    const out = await castle.getCastletvStreams('927342', 'movie');
    assert.deepEqual([...out], []);
    assert.equal(out.notListed, true);
});

test('castletv: every video call failing (HTTP 502) still throws', async () => {
    route({ rows: [{ id: 5, title: 'Amaran' }], video: () => new Response('bad', { status: 502 }) });
    await assert.rejects(castle.getCastletvStreams('927342', 'movie'), /video call\(s\) failed/);
});
