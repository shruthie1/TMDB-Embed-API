'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// These run in-process, so the environment module must be re-evaluated with a
// patched process.env. require() caches, so the cache entry is dropped first.
const ENV_MODULE = require.resolve('../lib/runtime/environment');
function loadEnvWith(vars) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; 
        if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
    delete require.cache[ENV_MODULE];
    try { return require('../lib/runtime/environment'); }
    finally {
        for (const k of Object.keys(saved)) {
            if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
        delete require.cache[ENV_MODULE];
    }
}

test('paths resolve from the app root, not the current working directory', () => {
    const { paths, APP_ROOT } = require('../lib/runtime/paths');
    // The real bug this guards: resolving via process.cwd() silently produced
    // a non-existent path whenever the process was started elsewhere.
    assert.ok(fs.existsSync(paths.public), 'public/ must resolve');
    assert.ok(fs.existsSync(paths.providers), 'providers/ must resolve');
    assert.ok(fs.existsSync(path.join(APP_ROOT, 'package.json')), 'root must hold package.json');
});

test('vercel is detected as serverless and disables stateful features', () => {
    const env = loadEnvWith({ VERCEL: '1', FFMPEG_PATH: undefined, FFPROBE_PATH: undefined });
    assert.equal(env.platform, 'vercel');
    assert.equal(env.isServerless, true);
    assert.equal(env.capabilities.persistentFilesystem, false);
    assert.equal(env.capabilities.childProcesses, false);
    // Demux needs a cross-request job store AND ffmpeg; neither exists there.
    assert.equal(env.features.castleDemux, false);
    assert.equal(env.features.configPersistence, false);
});

test('a plain node process keeps every stateful feature', () => {
    const env = loadEnvWith({ VERCEL: undefined, NOW_REGION: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined });
    assert.equal(env.isServerless, false);
    assert.equal(env.features.castleDemux, true);
    assert.equal(env.features.configPersistence, true);
});

test('an explicit FFMPEG_PATH re-enables child processes on serverless', () => {
    // A bundled ffmpeg layer is the one way demux could run there, so the
    // capability must follow the binary rather than the platform name alone.
    const env = loadEnvWith({ VERCEL: '1', FFMPEG_PATH: '/opt/ffmpeg' });
    assert.equal(env.capabilities.childProcesses, true);
    // Still no persistent job store, so the feature stays off.
    assert.equal(env.features.castleDemux, false);
});

test('writableRoot points at the OS temp dir when serverless', () => {
    // Not a literal '/tmp' check: os.tmpdir() is /var/folders/... on macOS and
    // /tmp on Linux, so compare against os.tmpdir() itself. What matters is
    // that it is NOT the (read-only) app root.
    const os = require('os');
    const { APP_ROOT } = require('../lib/runtime/paths');
    const env = loadEnvWith({ VERCEL: '1' });
    assert.equal(env.writableRoot, os.tmpdir());
    assert.notEqual(env.writableRoot, APP_ROOT);
});
