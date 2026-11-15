'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// utils/user-config.json is gitignored (it can hold a TMDB key). A clean
// checkout or a `git archive` deploy has only the tracked example. Without a
// fallback the loader saw no override at all and normalizeConfig() defaults
// every provider flag to TRUE, so a fresh deploy silently enabled providers
// that prod keeps off (showsst, 4khdhub, ...).
const { overrideReadPath } = require('../utils/config');

function dir(files) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    for (const f of files) fs.writeFileSync(path.join(d, f), '{}');
    return { real: path.join(d, 'user-config.json'), example: path.join(d, 'user-config.example.json') };
}

test('the real override file wins when present', () => {
    const p = dir(['user-config.json', 'user-config.example.json']);
    assert.equal(overrideReadPath(p), p.real);
});

test('a checkout with only the example reads the example', () => {
    const p = dir(['user-config.example.json']);
    assert.equal(overrideReadPath(p), p.example);
});

test('neither file: no override', () => {
    assert.equal(overrideReadPath(dir([])), null);
});

test('the tracked example carries no TMDB key and keeps showsst off', () => {
    const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'utils', 'user-config.example.json'), 'utf8'));
    assert.deepEqual(ex.tmdbApiKeys, []);
    assert.equal(ex.enableShowsstProvider, false);
});
