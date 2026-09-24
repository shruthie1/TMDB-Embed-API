'use strict';

// Where am I running, and what am I allowed to do here?
//
// The same codebase runs as a long-lived local/Docker process and as Vercel
// serverless functions, and those two disagree about almost everything that
// matters: whether state survives between requests, whether the filesystem is
// writable, whether a child process exists, and how long a request may take.
//
// Guessing wrong is silent. A Map-backed cache on serverless does not error -
// it just misses every time, and a feature built on it (the Castle demux job
// store) hands out URLs that 404 on the very next request because that request
// landed on a different instance. So the environment is detected once, stated
// explicitly, and features check their capability instead of assuming.

const os = require('os');

// Vercel sets VERCEL=1 in every runtime; AWS_LAMBDA_FUNCTION_NAME covers a
// bare Lambda. NOW_REGION is the legacy Vercel variable, kept for old projects.
function detectPlatform() {
    if (process.env.VERCEL || process.env.NOW_REGION) return 'vercel';
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'lambda';
    if (process.env.KUBERNETES_SERVICE_HOST) return 'kubernetes';
    if (process.env.DOCKER_CONTAINER || require('fs').existsSync('/.dockerenv')) return 'docker';
    return 'node';
}

const platform = detectPlatform();

// Serverless: every request may hit a cold, separate instance. Anything held
// in a module-level Map is best-effort at most, and must never be the only
// copy of something a later request needs.
const isServerless = platform === 'vercel' || platform === 'lambda';

// Only /tmp is writable on serverless, and even that is per-instance and
// ephemeral. Config and auth writes must therefore be refused rather than
// silently lost - see the guards in utils/config.js and utils/auth.js.
const writableRoot = isServerless ? os.tmpdir() : process.cwd();

// Spawning ffmpeg needs the binary to exist in the runtime image. Vercel's
// Node runtime does not ship one, and nothing in package.json bundles it
// (checked 2026-09-21: no ffmpeg-static / ffmpeg-installer dependency), so
// child-process media work is unavailable there unless a layer provides it.
function detectFfmpeg() {
    if (process.env.FFMPEG_PATH || process.env.FFPROBE_PATH) return true;
    if (isServerless) return false;
    return true; // a local/Docker run is expected to have it on PATH
}

const capabilities = {
    // State held in this process is trusted across requests.
    persistentMemory: !isServerless,
    // A background timer will still be running on the next request.
    backgroundTimers: !isServerless,
    // Files written now can be read back later by another request.
    persistentFilesystem: !isServerless,
    // ffmpeg / ffprobe can be spawned.
    childProcesses: detectFfmpeg(),
    // Long-running responses are allowed (serverless caps request duration).
    longRunningRequests: !isServerless,
};

// Features that cannot work without a capability, so the reason a route is
// disabled is stated once here rather than discovered at runtime.
const features = {
    // Republishing muxed audio as separate renditions needs BOTH a job store
    // that survives between requests and ffmpeg to cut the segments.
    castleDemux: capabilities.persistentMemory && capabilities.childProcesses,
    // Writing config/auth back to disk.
    configPersistence: capabilities.persistentFilesystem,
    // In-process result and probe caches are merely less effective when
    // serverless, not incorrect, so they stay on everywhere.
    inProcessCache: true,
};

function describe() {
    return { platform, isServerless, writableRoot, capabilities, features };
}

module.exports = { platform, isServerless, writableRoot, capabilities, features, describe };
