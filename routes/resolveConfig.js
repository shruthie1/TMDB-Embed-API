'use strict';
// GET /api/resolve-config: the override config the Android app's
// ResolveConfigStore fetches (android/.../resolve/ResolveConfig.kt). It lets a
// provider-site change (host, path, front list, token regex, timeout) reach the
// app as a server edit instead of an app update. Edit routes/resolve-config.json
// and deploy; the app re-fetches after ttlSec. The file is read per request, so
// an edit on the VM takes effect without a restart.
//
// The app treats any missing or invalid field as its built-in default, so a
// broken file degrades to defaults, never to a crash. The JSON ships with the
// app's own defaults exactly (test/resolveConfig.test.js checks it).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'resolve-config.json');
// Short: the app keeps its own copy for ttlSec, and the Vercel edge in front of
// /api/resolve-config must not pin a stale config for long.
const CACHE_CONTROL = 'public, max-age=300';

function registerResolveConfigRoute(app, file = FILE) {
    app.get('/api/resolve-config', (req, res) => {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
            JSON.parse(text);
        } catch (e) {
            console.error(`[resolve-config] unreadable ${file}: ${e.message}`);
            return res.status(500).json({ error: 'resolve-config unavailable' });
        }
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Cache-Control', CACHE_CONTROL);
        res.send(text);
    });
}

module.exports = { registerResolveConfigRoute };
