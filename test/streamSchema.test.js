'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const s = require('../utils/streamSchema');

test('a stream without a url is rejected', () => {
  assert.equal(s.normaliseStream({ provider: 'X' }), null);
  assert.equal(s.normaliseStream(null), null);
});

// An untagged track is unknown, not a language. Mapping it invents information.
test('und/unknown/original are not languages', () => {
  for (const v of ['und', 'unknown', 'original', '', null]) {
    assert.equal(s.canonicalLanguage(v), null, `${v} should not be a language`);
  }
  assert.equal(s.canonicalLanguage('tel'), 'Telugu');
  assert.equal(s.canonicalLanguage('TE'), 'Telugu');
});

test('duplicate language spellings collapse to one', () => {
  const r = s.normaliseStream({ url: 'u', provider: 'X', languages: ['tel', 'Telugu', 'te'] });
  assert.deepEqual(r.languages, ['Telugu']);
});

test('a structured field beats a label', () => {
  const r = s.normaliseStream({ url: 'u', provider: 'X', name: 'X [Hindi]', languages: ['tel'] });
  assert.deepEqual(r.languages, ['Telugu']);
});

// Regression: a stale bracket used to survive and the UI reads the name.
test('the display name is re-stamped from canonical languages', () => {
  const r = s.normaliseStream({ url: 'u', provider: 'X', name: 'X [Hindi]', languages: ['tel'] });
  assert.match(r.name, /\[Telugu\]/);
  assert.doesNotMatch(r.name, /Hindi/);
});

test('an explicit selectableAudio:false is not overridden', () => {
  const r = s.normaliseStream({
    url: 'u', provider: 'X', selectableAudio: false,
    audio: [{ language: 'tel' }, { language: 'hin' }],
  });
  assert.equal(r.selectableAudio, false);
});

test('selectableAudio is inferred only when unstated', () => {
  const two = s.normaliseStream({ url: 'u', provider: 'X', audio: [{ language: 'tel' }, { language: 'hin' }] });
  assert.equal(two.selectableAudio, true);
  const one = s.normaliseStream({ url: 'u', provider: 'X', audio: [{ language: 'tel' }] });
  assert.equal(one.selectableAudio, false);
});

test('quality falls back to the title, and 4k normalises', () => {
  assert.equal(s.normaliseStream({ url: 'u', provider: 'X', title: 'Movie 1080p WEBRip' }).quality, '1080p');
  assert.equal(s.normaliseStream({ url: 'u', provider: 'X', quality: '4k' }).quality, '2160p');
  assert.equal(s.normaliseStream({ url: 'u', provider: 'X' }).quality, 'Auto');
});

test('container is inferred from the url, including proxied ones', () => {
  assert.equal(s.normaliseStream({ url: 'http://h/m3u8-proxy?url=x', provider: 'X' }).container, 'hls');
  assert.equal(s.normaliseStream({ url: 'http://h/a.mkv', provider: 'X' }).container, 'mkv');
});

test('every stream carries the full field contract', () => {
  const REQ = ['url','provider','title','quality','languages','audio','subtitles','size','container','selectableAudio','name'];
  const r = s.normaliseStream({ url: 'u', provider: 'X' });
  for (const k of REQ) assert.ok(k in r, `missing ${k}`);
});

// --- levels: the ladder a UI quality menu is built from -------------------

test('levels are normalised, sorted best-first, and junk dropped', () => {
    const out = s.normaliseStream({
        url: 'https://x/a.m3u8', provider: 'P',
        levels: [
            { height: 536 },
            { height: 804, bandwidth: 1200 },
            { height: 0 },            // invalid
            { height: 'abc' },        // invalid
            null,                     // invalid
            { height: 268 },
        ],
    });
    assert.deepEqual(out.levels.map((l) => l.height), [804, 536, 268]);
    assert.equal(out.levels[0].bandwidth, 1200);
    assert.equal(out.levels[1].bandwidth, null);
    // Each level carries a display label for the menu.
    assert.equal(out.levels[0].quality, '720p'); // 804 snaps to the 720 tier
});

test('a stream with no levels reports [] rather than inventing one', () => {
    // [] must mean "ladder unknown", never "exactly one level" - a UI that
    // renders a single-entry menu from a guess is worse than rendering none.
    const out = s.normaliseStream({ url: 'https://x/a.m3u8', provider: 'P', quality: '1080p' });
    assert.deepEqual(out.levels, []);
    assert.equal(out.quality, '1080p');
});

test('levels survive independently of the headline quality', () => {
    // The real VaPlayer case: the release name claimed 1080p while the
    // manifest topped out at 804p. The provider now reports the measured
    // value, and the ladder must still come through intact.
    const out = s.normaliseStream({
        url: 'https://x/a.m3u8', provider: 'VaPlayer', quality: '720p',
        levels: [{ height: 804 }, { height: 536 }, { height: 268 }],
    });
    assert.equal(out.quality, '720p');
    assert.equal(out.levels.length, 3);
});

// --- language from a scene release name -------------------------------------
// Measured 2026-09-21: of the enabled providers, only CastleTV states its
// languages structurally. VaPlayer returns torrent-derived files whose NAME
// carries the language, and we were throwing that away - on 628241 (Ala
// Vaikunthapurramuloo, a TELUGU original) it returned a file explicitly marked
// HINDI with languages:[], so nothing warned the viewer it was a dub.

test('a bare language token in a release name is read', () => {
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'VaPlayer', name: 'VaPlayer',
        title: 'VaPlayer · Ala Vaikunthapurramuloo 2020 1080p HINDI 10bit DDP 5 1 x265',
    });
    assert.deepEqual(out.languages, ['Hindi']);
});

test('a release name with no language stays honestly empty', () => {
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'VaPlayer', name: 'VaPlayer',
        title: 'VaPlayer · Devara Part 1 2024 1080p WEBRip x264 AAC5 1-[YTS MX]',
    });
    assert.deepEqual(out.languages, []);
});

test('a language inside a longer word is not a language', () => {
    // "Tamilrockers" must never be read as Tamil - a wrong language is worse
    // than none, because the viewer acts on it.
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'X', title: 'Movie Tamilrockers.com 1080p',
    });
    assert.deepEqual(out.languages, []);
});

test('"dual audio" is not resolved to specific languages', () => {
    // We do not know WHICH two. Claiming one would be inventing information.
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'X', title: 'Movie 2024 Dual Audio 1080p',
    });
    assert.deepEqual(out.languages, []);
});

test('a structured field still beats anything parsed from the name', () => {
    // The name says Hindi, the provider says Telugu. The field wins.
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'X', languages: ['tel'],
        title: 'Movie 2020 1080p HINDI x265',
    });
    assert.deepEqual(out.languages, ['Telugu']);
});

test('a release-group tag in brackets is not a language', () => {
    // "...AAC5 1-[YTS MX]" produced languages:["Yts mx"], which the UI then
    // offered as an audio choice. canonicalLanguage title-cases anything it
    // does not recognise, so the bracket parser must gate on known languages.
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'VaPlayer', name: 'VaPlayer',
        title: 'VaPlayer · Devara Part 1 2024 1080p WEBRip x264 AAC5 1-[YTS MX]',
    });
    assert.deepEqual(out.languages, []);
    assert.deepEqual(s.languagesFromLabel('X [RARBG]'), []);
    // A real language in a bracket must still work - this is CastleTV's shape.
    assert.deepEqual(s.languagesFromLabel('CastleTV [Hindi/Telugu]'), ['Hindi', 'Telugu']);
});

test('an unusual language still works through the structured field', () => {
    // The bracket parser is strict; the field is not, so nothing is lost.
    const out = s.normaliseStream({
        url: 'http://x/a.mp4', provider: 'X', languages: ['Tulu'],
    });
    assert.deepEqual(out.languages, ['Tulu']);
});
