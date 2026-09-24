'use strict';

// Where the application's own files live.
//
// These used to be resolved with process.cwd(). That is the directory the
// process was STARTED from, not where the code lives, so it is only correct
// when the server happens to be launched from the repo root. On Vercel the
// function's working directory is not guaranteed to be the project root, and
// a wrong cwd here does not throw - it silently resolves to a path that does
// not exist. The failure modes are quiet and severe:
//
//   providers/  -> readdirSync returns nothing -> ZERO providers register,
//                  so every lookup returns "no streams" rather than an error
//   public/     -> express.static serves nothing -> blank UI, 404s
//
// __dirname is resolved by the module loader from the file's own location, so
// it is correct regardless of how or from where the process was started.
// This file sits at <root>/lib/runtime/, hence two levels up.

const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');

const paths = {
    root: APP_ROOT,
    public: path.join(APP_ROOT, 'public'),
    providers: path.join(APP_ROOT, 'providers'),
    utils: path.join(APP_ROOT, 'utils'),
};

// Resolve anything else relative to the app root.
function fromRoot(...segments) {
    return path.join(APP_ROOT, ...segments);
}

module.exports = { APP_ROOT, paths, fromRoot };
