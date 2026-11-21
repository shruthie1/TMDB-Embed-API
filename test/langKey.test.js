const assert = require('node:assert/strict');
const { test } = require('node:test');
const { canonicalLanguage } = require('../utils/streamSchema');
const { defaultAudioIndex } = require('../utils/hybridStream');

// audioFromManifest is private to capabilities.js and only reachable through
// resolveCapabilities, which probes the network. Stub probeStream before the
// module loads, because capabilities.js destructures it at require time.
function capabilitiesWithProbe(probeResult) {
    const probeMod = require('../lib/media/probe');
    probeMod.probeStream = async () => probeResult;
    delete require.cache[require.resolve('../lib/media/capabilities')];
    return require('../lib/media/capabilities');
}

test('canonicalLanguage folds Telugu spellings to one key', () => {
    assert.equal(canonicalLanguage('te'), 'Telugu');
    assert.equal(canonicalLanguage('tel-IN'), 'Telugu');
    assert.equal(canonicalLanguage('TELUGU'), 'Telugu');
    assert.equal(canonicalLanguage('en'), 'English');
    assert.equal(canonicalLanguage(null), null);
});

test('audioFromManifest carries rendition name and uri', async () => {
    const { resolveCapabilities } = capabilitiesWithProbe({
        ok: true,
        kind: 'master',
        audio: [{ url: 'https://x/a.m3u8', name: 'Telugu', languageCode: 'tel', isDefault: true, channels: 2 }],
    });
    const caps = await resolveCapabilities(
        { url: 'https://x/m.m3u8', provider: 'X', languages: [], audio: [], subtitles: [] },
    );
    assert.equal(caps.audioSource, 'manifest');
    const a = caps.audio[0];
    assert.equal(a.uri, 'https://x/a.m3u8');
    assert.equal(a.name, 'Telugu');
    assert.equal(a.language, 'Telugu');
    // Existing fields stay.
    assert.equal(a.languageCode, 'tel');
    assert.equal(a.channels, 2);
    assert.equal(a.default, true);
    assert.equal(a.switchable, true);
});

test('defaultAudioIndex matches a language code canonically', () => {
    assert.equal(defaultAudioIndex([{ language: 'en' }, { language: 'te' }]), 1);
});

test('defaultAudioIndex matches a name-only rendition', () => {
    assert.equal(defaultAudioIndex([{ name: 'English' }, { name: 'Telugu' }]), 1);
});

test('defaultAudioIndex falls back to 0 when nothing matches', () => {
    assert.equal(defaultAudioIndex([{ language: 'en' }, { name: 'Hindi' }]), 0);
});

test('canonicalLanguage strips a region subtag to the base code', () => {
    assert.equal(canonicalLanguage('hi-IN'), canonicalLanguage('hi'));
    assert.equal(canonicalLanguage('ta-IN'), canonicalLanguage('ta'));
    assert.equal(canonicalLanguage('en-US'), canonicalLanguage('en'));
    assert.equal(canonicalLanguage('tel-IN'), 'Telugu');
});

test('defaultAudioIndex matches by name when language is und', () => {
    assert.equal(defaultAudioIndex([{ language: 'en' }, { language: 'und', name: 'Telugu' }]), 1);
});

test('canonicalLanguage keeps compound tags whole', () => {
    // Pre-Task-2 behaviour: no LANG_CANON hit, so the full key is title-cased.
    assert.equal(canonicalLanguage('Telugu-Hindi'), 'Telugu-hindi');
    assert.equal(canonicalLanguage('eng-sub'), 'Eng-sub');
    assert.equal(canonicalLanguage('Hin-Eng'), 'Hin-eng');
});
