'use strict';
// GET /api/resolve-config: the override config the Android app's
// ResolveConfigStore fetches (android/.../resolve/ResolveConfig.kt). It lets a
// provider-site change (host, path, front list, token regex, timeout) reach the
// app as a server edit instead of an app update.
//
// Since 2026-11-21 (provider self-heal) it serves the merged view from
// lib/selfheal/config.js: built-in routes/resolve-config.json < remote
// RESOLVE_CONFIG_URL < verified heals (data/provider-heals.json). The built-in
// file is still re-read when it changes, so an edit on the VM takes effect
// without a restart.
//
// The app treats any missing or invalid field as its built-in default and
// ignores unknown keys, so a broken file degrades to defaults, never to a
// crash. The built-in JSON ships with the app's own defaults exactly
// (test/resolveConfig.test.js checks it).

// Short: the app keeps its own copy for ttlSec, and the Vercel edge in front of
// /api/resolve-config must not pin a stale config for long.
const CACHE_CONTROL = 'public, max-age=300';

function registerResolveConfigRoute(app, source = null) {
    app.get('/api/resolve-config', (req, res) => {
        let text;
        try {
            const src = source || require('../lib/selfheal/config');
            text = JSON.stringify(src.snapshot());
        } catch (e) {
            console.error(`[resolve-config] snapshot failed: ${e.message}`);
            return res.status(500).json({ error: 'resolve-config unavailable' });
        }
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Cache-Control', CACHE_CONTROL);
        res.send(text);
    });
}

module.exports = { registerResolveConfigRoute };
