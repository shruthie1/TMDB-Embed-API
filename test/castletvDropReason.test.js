'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../providers/castletv');

// Soak 1: RRR (579974) logged "Got 0 stream(s)" 23 times with no rejection
// and no reason. dropReason names the gate that emptied a video payload.
test('dropReason names each gate buildCastleStreams applies, null for a playable payload', () => {
    const { dropReason } = _internal;
    assert.equal(dropReason({ data: { permissionDenied: true } }), 'permissionDenied');
    assert.equal(dropReason({ data: { isPreview: true, videoUrl: 'https://x/a.m3u8' } }), 'isPreview');
    assert.equal(dropReason({ data: { videoUrl: 'https://x/480/index_preview_1.m3u8' } }), 'preview-url');
    assert.equal(dropReason({ data: {} }), 'no-url');
    assert.equal(dropReason({ data: { videoUrl: 'https://x/1080/index.m3u8' } }), null);
});
