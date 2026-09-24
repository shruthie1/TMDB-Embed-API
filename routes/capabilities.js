'use strict';

// Playback capability routes.
//
// Extracted from apiServer.js. These are the endpoints a player UI calls to
// build its quality and audio menus, so they are kept together and away from
// the provider fan-out logic.
//
// The resolving itself lives in lib/media/capabilities.js - this file is only
// the HTTP shell around it.

const { resolveCapabilities, resolveMany } = require('../lib/media/capabilities');
const { normaliseStream } = require('../utils/streamSchema');

function registerCapabilityRoutes(app) {
    // ---------------------------------------------------------------------------
    // Playback capability API.
    //
    // What a UI needs to draw a quality menu and an audio menu BEFORE pressing
    // play. Until this existed the browser had to load the stream in hls.js and
    // wait for MANIFEST_PARSED, which is why public/watch.js:176 throws the API's
    // audio data away and trusts only what hls.js discovered. These routes make
    // the server the authority instead.
    //
    // POST /api/capabilities   body {streams:[...]} - resolve a list in one call
    // GET  /api/capabilities?url=...  - resolve a single URL
    // ---------------------------------------------------------------------------
    app.post('/api/capabilities', async (req, res) => {
      try {
        const streams = (req.body && req.body.streams) || [];
        if (!Array.isArray(streams) || !streams.length) {
          return res.status(400).json({ success: false, error: 'NO_STREAMS' });
        }
        if (streams.length > 40) {
          return res.status(400).json({ success: false, error: 'TOO_MANY_STREAMS', max: 40 });
        }
        const caps = await resolveMany(streams.map(normaliseStream).filter(Boolean));
        res.json({ success: true, count: caps.length, capabilities: caps });
      } catch (e) {
        res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
      }
    });

    app.get('/api/capabilities', async (req, res) => {
      const url = req.query.url;
      if (!url) return res.status(400).json({ success: false, error: 'MISSING_URL' });
      try {
        const stream = normaliseStream({
          url,
          provider: req.query.provider || 'Unknown',
          quality: req.query.quality || null,
        });
        if (!stream) return res.status(400).json({ success: false, error: 'INVALID_URL' });
        // normaliseStream only requires a truthy url, so an unparseable string gets
        // this far and would come back 200 with an empty capability set - which
        // reads as "this stream has no audio or quality" rather than "bad input".
        try { new URL(url); } catch {
          return res.status(400).json({ success: false, error: 'INVALID_URL' });
        }
        const caps = await resolveCapabilities(stream);
        res.json({ success: true, capabilities: caps });
      } catch (e) {
        res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
      }
    });
}

module.exports = { registerCapabilityRoutes };
