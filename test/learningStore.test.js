'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Fake ffprobe: same fixture as mp4AudioProbe.test.js.
const FAKE = path.join(__dirname, 'fixtures', 'fake-ffprobe.js');
process.env.FFPROBE_PATH = FAKE;
const LOG = path.join(os.tmpdir(), `fake-ffprobe-learn-${process.pid}.log`);
process.env.FAKE_FFPROBE_LOG = LOG;
const probeCount = () => {
    try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).length; }
    catch { return 0; }
};

const store = require('../utils/store');
const { openStore, _setStore, mediaIdentityOf } = store;
const tmpFile = (ext = 'sqlite') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-')), `learning.${ext}`);

beforeEach(() => { try { fs.unlinkSync(LOG); } catch { /* none yet */ } });

// ---- G2: the store itself -------------------------------------------------

test('sqlite store: WAL mode, schema version set, data survives a reopen', () => {
    const file = tmpFile();
    const a = openStore(file);
    assert.strictEqual(a.backend, 'sqlite');
    assert.strictEqual(a.userVersion(), store.MIGRATIONS.length);
    a.recordPlayback({ tmdbId: 5, type: 'movie', provider: 'CastleTV', ok: true, startupMs: 1200 });
    a.saveProviderHealth('castletv', { attempts: 3, successes: 1 });
    a.close();
    // WAL mode is a property of the file, so a fresh connection reports it.
    const Database = require('better-sqlite3');
    const raw = new Database(file);
    assert.strictEqual(raw.pragma('journal_mode', { simple: true }), 'wal');
    raw.close();

    const b = openStore(file);
    const rows = b.sourceStatsFor({ tmdbId: 5, type: 'movie' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].provider, 'castletv');
    assert.strictEqual(rows[0].startup_ms, 1200);
    assert.ok(rows[0].played_ok_at > 0);
    assert.strictEqual(b.providerHealth('CastleTV').attempts, 3);
    // Reopening re-runs no migration and keeps the version.
    assert.strictEqual(b.userVersion(), store.MIGRATIONS.length);
    b.close();
});

test('JSON fallback keeps the same interface and survives a reopen', async () => {
    const file = tmpFile();
    const a = openStore(file, { backend: 'json' });
    assert.strictEqual(a.backend, 'json');
    a.recordPlayback({ tmdbId: 7, type: 'tv', season: 1, episode: 2, provider: 'x', ok: false, reason: 'stall' });
    a.recordPlayback({ tmdbId: 7, type: 'series', season: 1, episode: 2, provider: 'x', ok: false });
    a.putAudioEvidence({ mediaIdentity: 'cdn/a.mp4', source: 'viewer', lang: 'Telugu' });
    a.saveProviderHealth('x', { tripped_until: 123 });
    a.close();
    const jsonFile = file.replace(/\.sqlite$/, '.json');
    assert.ok(fs.existsSync(jsonFile));
    const b = openStore(file, { backend: 'json' });
    const rows = b.sourceStatsFor({ tmdbId: 7, type: 'tv', season: 1, episode: 2 });
    assert.strictEqual(rows.length, 1, "'tv' and 'series' are one key");
    assert.strictEqual(rows[0].play_fails, 2);
    assert.strictEqual(b.audioEvidenceFor('cdn/a.mp4')[0].lang, 'Telugu');
    assert.strictEqual(b.providerHealth('x').tripped_until, 123);
});

test('a success clears play_fails; a failure counts up', () => {
    const s = openStore(':memory:');
    const k = { tmdbId: 9, type: 'movie', provider: 'p' };
    s.recordPlayback({ ...k, ok: false });
    s.recordPlayback({ ...k, ok: false });
    assert.strictEqual(s.sourceStatsFor(k)[0].play_fails, 2);
    s.recordPlayback({ ...k, ok: true, startupMs: 500 });
    assert.strictEqual(s.sourceStatsFor(k)[0].play_fails, 0);
});

test('the DB file under data/ is git-ignored', () => {
    const root = path.join(__dirname, '..');
    const out = execFileSync('git', ['check-ignore', '-v', 'data/learning.sqlite', 'data/learning.sqlite-wal'],
        { cwd: root, encoding: 'utf8' });
    assert.match(out, /data\/\.gitignore/);
});

test('media identity drops the signature and the rotating suffix, and unwraps the proxy', () => {
    assert.strictEqual(mediaIdentityOf('https://cdn.x/v/abc/index_preview_123.m3u8?sign=1&expire=2'),
        'cdn.x/v/abc/index_preview.m3u8');
    assert.strictEqual(mediaIdentityOf('https://cdn.x/v/abc/index_preview_456.m3u8?sign=9'),
        'cdn.x/v/abc/index_preview.m3u8');
    const proxied = `/m3u8-proxy?url=${encodeURIComponent('https://cdn.x/f/a.mp4?token=z')}`;
    assert.strictEqual(mediaIdentityOf(proxied), 'cdn.x/f/a.mp4');
    assert.notStrictEqual(mediaIdentityOf('https://a.cdn/index.m3u8'), mediaIdentityOf('https://b.cdn/index.m3u8'));
});

// ---- G10: audio evidence ---------------------------------------------------

function freshProbe() {
    const id = require.resolve('../lib/media/mp4AudioProbe');
    delete require.cache[id];
    return require('../lib/media/mp4AudioProbe');
}

test('a stored ffprobe answer skips ffprobe, even after a restart', async () => {
    const file = tmpFile();
    _setStore(openStore(file));
    let probe = freshProbe();
    const first = await probe.probeAudioTracks('https://cdn.test/f/a.mp4?sign=AAA#multi');
    assert.deepStrictEqual(first.map((t) => t.language), ['tel', 'hin', null]);
    assert.strictEqual(probeCount(), 1);

    // "Restart": new module (empty memory cache), new store instance on the
    // same file, freshly signed url for the same file.
    _setStore(openStore(file));
    probe = freshProbe();
    const second = await probe.probeAudioTracks('https://cdn.test/f/a.mp4?sign=BBB#multi');
    assert.deepStrictEqual(second, first);
    assert.strictEqual(probeCount(), 1, 'no second ffprobe');
    assert.deepStrictEqual(probe.cachedAudioTracks('https://cdn.test/f/a.mp4?sign=CCC'), first);
});

test('a failed probe is not stored as evidence', async () => {
    _setStore(openStore(':memory:'));
    const probe = freshProbe();
    await probe.probeAudioTracks('https://cdn.test/dead.mp4#fail');
    assert.strictEqual(store.getStore().audioEvidenceFor('cdn.test/dead.mp4').length, 0);
});

test('a viewer Telugu label wins over an und tag', async () => {
    _setStore(openStore(':memory:'));
    store.getStore().putAudioEvidence({ mediaIdentity: 'cdn.test/u.mp4', source: 'viewer', lang: 'Telugu' });
    const probe = freshProbe();
    const tracks = await probe.probeAudioTracks('https://cdn.test/u.mp4#und');
    assert.deepStrictEqual(tracks, [{ language: 'Telugu', codec: 'aac', channels: 2 }]);
});

test('a provider Telugu label also wins over und; und alone stays unlabelled', async () => {
    _setStore(openStore(':memory:'));
    let probe = freshProbe();
    assert.deepStrictEqual((await probe.probeAudioTracks('https://cdn.test/p.mp4#und'))[0].language, null);
    store.getStore().putAudioEvidence({ mediaIdentity: 'cdn.test/p.mp4', source: 'provider', lang: 'tel' });
    probe = freshProbe();
    assert.deepStrictEqual((await probe.probeAudioTracks('https://cdn.test/p.mp4#und'))[0].language, 'Telugu');
    assert.strictEqual(probeCount(), 1, 'second call used the stored probe');
});

test('viewer langOk=false overrides a stored ffprobe label, and keeps the track', async () => {
    _setStore(openStore(':memory:'));
    const probe = freshProbe();
    await probe.probeAudioTracks('https://cdn.test/m.mp4#multi');
    store.getStore().putAudioEvidence({ mediaIdentity: 'cdn.test/m.mp4', source: 'viewer', lang: 'Telugu',
        refuted: true });
    const after = await probe.probeAudioTracks('https://cdn.test/m.mp4#multi');
    assert.strictEqual(after.length, 3, 'no track dropped');
    assert.deepStrictEqual(after.map((t) => t.language), [null, 'hin', null]);
    // A later viewer confirmation reverses the refutation.
    store.getStore().putAudioEvidence({ mediaIdentity: 'cdn.test/m.mp4', source: 'viewer', lang: 'Telugu',
        refuted: false });
    assert.deepStrictEqual((await probe.probeAudioTracks('https://cdn.test/m.mp4#multi')).map((t) => t.language),
        ['tel', 'hin', null]);
});

test('castle demux probe is read back by media identity, not by the signed url', () => {
    _setStore(openStore(':memory:'));
    const id = require.resolve('../utils/castleDemux');
    delete require.cache[id];
    const demux = require('../utils/castleDemux');
    const layout = { videoIndex: 0, videoWidth: 1920, videoHeight: 1080,
        audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2, language: 'tel' },
            { index: 2, codec: 'aac', sampleRate: 48000, channels: 2, language: 'hin' }] };
    demux.setProbe('https://castle.cdn/m/xyz/index_preview_101.m3u8?sig=A', layout);
    assert.deepStrictEqual(demux.getProbe('https://castle.cdn/m/xyz/index_preview_202.m3u8?sig=B'), layout);
    // An empty-audio probe is never persisted.
    demux.setProbe('https://castle.cdn/m/empty/index.m3u8?sig=A', { videoIndex: 0, audio: [] });
    assert.strictEqual(demux.getProbe('https://castle.cdn/m/empty/index.m3u8?sig=OTHER'), null);
});

// ---- G6: persistent breaker and probation ----------------------------------

function freshMetrics() {
    const id = require.resolve('../lib/runtime/metrics');
    delete require.cache[id];
    return require('../lib/runtime/metrics');
}

test('a tripped breaker is still open after a restart (new store instance, new module)', () => {
    const file = tmpFile();
    _setStore(openStore(file));
    let m = freshMetrics();
    for (let i = 0; i < m.BREAKER_THRESHOLD; i++) m.recordProviderOutcome('deadprov', 'error', 5, 0, true, `movie:${i}::`);
    assert.strictEqual(m.breakerOpen('deadprov'), true);

    _setStore(openStore(file));
    m = freshMetrics();
    assert.strictEqual(m.breakerOpen('deadprov'), true, 'breaker state came back from provider_health');
    assert.strictEqual(m.metrics.providerHealth.deadprov.trips, 1);
});

test('probation: >=5 attempts and 0 successes gets 8000ms; one success restores the full deadline', () => {
    _setStore(openStore(tmpFile()));
    const m = freshMetrics();
    assert.strictEqual(m.budgetFor('newprov', 20000), 20000, 'unknown provider: full budget');
    for (let i = 0; i < 4; i++) m.recordProviderOutcome('newprov', 'timeout', 20000, 0);
    assert.strictEqual(m.budgetFor('newprov', 20000), 20000, '4 attempts is not enough to judge');
    m.recordProviderOutcome('newprov', 'error', 100, 0, true, 'movie:x::');
    assert.strictEqual(m.budgetFor('newprov', 20000), 8000);
    m.recordProviderOutcome('newprov', 'hit', 3000, 2);
    assert.strictEqual(m.budgetFor('newprov', 20000), 20000);
});

test('empties are not judged attempts, so an empty-only provider keeps its full deadline', () => {
    _setStore(openStore(':memory:'));
    const m = freshMetrics();
    for (let i = 0; i < 10; i++) m.recordProviderOutcome('emptyprov', 'empty', 50, 0, true, `movie:${i}::`);
    assert.strictEqual(m.budgetFor('emptyprov', 20000), 20000);
});

test('latency EWMA (alpha 0.4) is persisted from hits only', () => {
    const file = tmpFile();
    _setStore(openStore(file));
    const m = freshMetrics();
    m.recordProviderOutcome('fast', 'hit', 1000, 1);
    m.recordProviderOutcome('fast', 'timeout', 20000, 0);
    m.recordProviderOutcome('fast', 'hit', 2000, 1);
    _setStore(openStore(file));
    assert.strictEqual(freshMetrics().latencyEwma('fast'), 1400); // 0.4*2000 + 0.6*1000
});
