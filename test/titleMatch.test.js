'use strict';
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Regression suite for the 2026-09-21 diacritics defect.
//
// castletv.js normalised "Bāhubali: The Beginning" to "b hubali the beginning"
// - the macron fell outside [a-z0-9] and became a SPACE. Both match passes
// missed Castle's "Baahubali: The Beginning", and a substring fallback then
// matched a DIFFERENT film literally titled "Beginning" at rows[0]. We played
// that film and reported the title as Tamil-only.
//
// These tests pin the three properties that prevent a recurrence.

const PROVIDERS = path.join(__dirname, '..', 'providers');
const src = (f) => fs.readFileSync(path.join(PROVIDERS, f), 'utf8');

// Every provider that matches on a TITLE string must deaccent before it
// strips to [a-z0-9]. Providers that match on an IMDB/TMDB id are immune and
// are deliberately not listed.
const TITLE_MATCHERS = ['castletv.js', 'netmirror.js', 'onetouchtv.js', '4khdhub.js'];

test('every title-matching provider deaccents before stripping', () => {
    // The rule now lives in one place, so pin it there by BEHAVIOUR rather
    // than grepping each provider for the NFD literal - a grep passes happily
    // while the actual comparison is broken.
    const { normalizeTitle } = require('../utils/titleMatch');
    assert.equal(normalizeTitle('B\u0101hubali'), 'bahubali',
        'the shared normaliser lets a macron become a space again');

    // And every title-based provider must route through it. Providers that
    // match on an IMDB/TMDB id are immune and are deliberately not listed.
    for (const f of TITLE_MATCHERS.concat('dahmermovies.js')) {
        assert.match(src(f), /require\(['"]\.\.\/utils\/titleMatch['"]\)/,
            `${f} does not use the shared title matcher`);
    }
});

// The substring fallback is what turned "no match" into "wrong film". A
// matcher that cannot identify the title must return nothing so another
// provider can win - a wrong stream that plays is undetectable downstream.
test('castletv has no blind rows[0] fallback', () => {
    const s = src('castletv.js');
    const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /\|\|\s*rows\[0\]/,
        'castletv fell back to rows[0], which serves a confidently wrong film');
});

// --- the normaliser's actual behaviour -----------------------------------

// Import the real implementation - a local copy here would keep passing while
// the shipped normaliser regressed.
const { deaccent, normalizeTitle, looseTitle } = require('../utils/titleMatch');

test('diacritics survive normalisation instead of becoming spaces', () => {
    // Each of these produced garbage before the fix.
    const cases = [
        ['Bāhubali: The Beginning', 'bahubali the beginning'],
        ['Ārya', 'arya'],                       // was "rya" - leading vowel eaten
        ['Kāntārā', 'kantara'],                 // was "k nt r"
        ['Sītā Ramam', 'sita ramam'],           // was "s t ramam"
        ['Pōnniyin Selvan: I', 'ponniyin selvan i'],
        ['Vikram Vēdha', 'vikram vedha'],
    ];
    for (const [input, want] of cases) {
        assert.equal(normalizeTitle(input), want, `normalising ${input}`);
    }
});

test('doubled-vowel transliteration matches across spellings', () => {
    // TMDB writes "Bahubali", Castle writes "Baahubali".
    assert.equal(looseTitle('Bāhubali: The Beginning'), looseTitle('Baahubali: The Beginning'));
    assert.equal(looseTitle('Bāhubali 2: The Conclusion'), looseTitle('Baahubali 2: The Conclusion'));
});

test('the loose pass does not match unrelated films', () => {
    // The real Castle rows returned for this search. Only one is the film;
    // "Beginning" at rows[0] is the decoy that used to win.
    const rows = ['Beginning', 'Baahubali: The Beginning', 'L.U.C.A.: The Beginning',
        'Exorcist: The Beginning', 'B: The Beginning', 'Jan Dara The Beginning'];
    const want = looseTitle('Bāhubali: The Beginning');
    const hits = rows.filter((r) => looseTitle(r) === want);
    assert.deepEqual(hits, ['Baahubali: The Beginning']);
});

test('a short common word cannot win by containment', () => {
    // "beginning" IS a substring of "bahubali the beginning". The guard has to
    // reject it on length ratio, or rows[0] wins again.
    const containsMeaningfully = (a, b) => {
        if (!a || !b) return false;
        const [short, long] = a.length <= b.length ? [a, b] : [b, a];
        if (short.length < 6) return false;
        if (short.length / long.length < 0.6) return false;
        return long.includes(short);
    };
    const title = normalizeTitle('Bāhubali: The Beginning');
    assert.equal(containsMeaningfully(normalizeTitle('Beginning'), title), false);
    // A genuine longer-form variant still matches.
    assert.equal(containsMeaningfully(normalizeTitle('Bahubali The Beginning 2015'), title), true);
});

// --- asking upstream in plain alphabet ------------------------------------
//
// Deaccenting only helps if the PLAIN spelling is also sent to the provider's
// own search. Comparing locally while querying in the accented spelling still
// returns zero rows when the upstream index is ASCII-only, and zero rows is
// indistinguishable downstream from "this provider has no copy".

test('title-matching providers query the plain-alphabet spelling too', () => {
    // searchSpellings is the single ladder every searching provider now uses.
    // Assert what it actually emits, then that each provider calls it.
    const { searchSpellings } = require('../utils/titleMatch');
    const spellings = searchSpellings('B\u0101hubali: The Beginning');
    assert.ok(spellings.includes('Bahubali: The Beginning'),
        'the deaccented spelling is never sent upstream');
    // Measured on movie/256040: this is the ONLY spelling that returned the
    // real row from NetMirror's search.
    assert.ok(spellings.includes('Baahubali'),
        'the doubled-vowel spelling is never sent upstream');

    for (const file of ['castletv.js', 'netmirror.js', 'onetouchtv.js']) {
        assert.match(src(file), /searchSpellings\(/,
            `${file} never sends a deaccented query upstream`);
    }
});

// dahmermovies puts the title straight into a URL PATH, so encodeURIComponent
// turns a macron into %C4%81 and requests a directory that does not exist.
test('dahmermovies tries both spellings of a path', () => {
    // UNVERIFIED against the live host: a.111477.xyz is FortiGuard-blocked on
    // this network, so the 403 seen there is a web-filter page, not the origin.
    // The accented path is tried FIRST, so this can only add a candidate.
    const s = src('dahmermovies.js');
    assert.match(s, /require\(['"]\.\.\/utils\/titleMatch['"]\)/,
        'dahmermovies does not deaccent');
    assert.match(s, /plainTitle/, 'dahmermovies does not build a plain-alphabet path');
});

test('a plain-alphabet title is not fetched twice', () => {
    // The variant list must collapse when deaccenting changes nothing,
    // otherwise every ASCII title doubles its upstream requests.
    const deaccent = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const paths = (title) => {
        const plain = deaccent(title);
        return (plain !== title ? [title, plain] : [title]);
    };
    assert.equal(paths('Pushpa The Rise').length, 1);
    assert.equal(paths('Bahubali The Beginning'.replace('Bah', 'B\u0101h')).length, 2);
});

// --- Castle track selection -----------------------------------------------
//
// Two defects found on Devara: Part 1 (811941), a Telugu original that played
// in Kannada with no language switcher at all.

// existIndividualVideo is ADVISORY. Castle sets it false on tracks that do
// serve their own file, and the code said so at the call site while
// pickPreferredTracks still used it as a hard filter. Devara returned
// [Telugu eiv:false, Hindi eiv:true, Tamil false, Malayalam false, Kannada
// false] - exactly one flagged - so four languages were discarded and the film
// came back Hindi-only.
test('castletv keeps every language track, not just existIndividualVideo ones', () => {
    const s = src('castletv.js');
    const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /filter\([^)]*existIndividualVideo === true/,
        'pickPreferredTracks is filtering on the advisory eiv flag again');
});

// The matcher must accept a catalogue title that merely omits a part suffix.
// Castle lists "Devara"; TMDB says "Devara: Part 1". A pure length ratio
// rejected it (0.46) while still letting "Beginning" through.
test('a missing part suffix still matches, a dropped title word does not', () => {
    // The real implementation, not a copy of it.
    const { isPrefixWithSuffixNoise: containsMeaningfully } = require('../utils/titleMatch');
    const n = normalizeTitle;

    // Castle omits the part suffix - same film.
    assert.equal(containsMeaningfully(n('Devara'), n('Devara: Part 1')), true);
    assert.equal(containsMeaningfully(n('Mirza'), n('Mirza: Part 1')), true);
    // A trailing common word that drops the DISTINCTIVE part is not a match.
    assert.equal(containsMeaningfully(n('Beginning'), n('Bahubali: The Beginning')), false);
    // Nor is a real extra word, only sequel noise.
    assert.equal(containsMeaningfully(n('Kantara'), n('Kantara A Legend')), false);
});

// DEFAULT=YES decides what the speakers actually play. Index 0 is whichever
// track Castle muxed first: on Devara that is Kannada, on a Telugu film.
test('the demux master defaults to the preferred language', () => {
    const langs = ['kan', 'mal', 'tam', 'tel'];
    const names = ['Kannada', 'Malayalam', 'Tamil', 'Telugu'];
    const preferred = 'telugu';
    const defaultIndex = Math.max(0, names.findIndex((nm, i) =>
        nm.toLowerCase() === preferred || langs[i].toLowerCase() === preferred));
    assert.equal(defaultIndex, 3, 'Telugu must be the default rendition');
    assert.notEqual(defaultIndex, 0, 'index 0 is Kannada here - the original bug');

    // With no Telugu present, fall back to the first track rather than none.
    const only = ['Hindi', 'Tamil'];
    const fallback = Math.max(0, only.findIndex((nm) => nm.toLowerCase() === preferred));
    assert.equal(fallback, 0);
});

test('republish reads PREFERRED_AUDIO_LANGUAGE instead of hardcoding index 0', () => {
    const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media', 'republish.js'), 'utf8');
    assert.match(s, /PREFERRED_AUDIO_LANGUAGE/, 'republish ignores the preferred language');
    const code = s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /DEFAULT=\$\{i === 0 \? 'YES'/,
        'the default rendition is hardcoded to index 0 again');
});

// ---------------------------------------------------------------------------
// utils/titleMatch.js - the shared module the five title-based providers now
// use instead of each keeping its own copy of these rules.
// ---------------------------------------------------------------------------
// --- utils/titleMatch shared module ---
const tm = require('../utils/titleMatch');

test('utils/titleMatch shared module: deaccents before stripping punctuation, so a macron never becomes a space', () => {
    // The original defect: "ā" is outside [a-z0-9], so a bare strip turned
    // "Bāhubali: The Beginning" into "b hubali the beginning".
    assert.strictEqual(tm.normalizeTitle('Bāhubali: The Beginning'), 'bahubali the beginning');
    assert.strictEqual(tm.normalizeTitle('Ārya'), 'arya');
    assert.strictEqual(tm.normalizeTitle('Kāntārā'), 'kantara');
    assert.strictEqual(tm.normalizeTitle('Sītā Ramam'), 'sita ramam');
});

test('utils/titleMatch shared module: matches across the doubled-vowel transliteration gap', () => {
    const rows = [{ title: 'Baahubali: The Beginning' }];
    assert.strictEqual(tm.findTitleMatch(rows, 'Bāhubali: The Beginning'), rows[0]);
});

test('utils/titleMatch shared module: returns null rather than the wrong film when nothing matches', () => {
    // The exact decoy that shipped: Castle row[0] was a different film
    // literally titled "Beginning", and a substring test picked it.
    const rows = [{ title: 'Beginning' }, { title: 'Some Other Film' }];
    assert.strictEqual(tm.findTitleMatch(rows, 'Bāhubali: The Beginning'), null);
});

test('utils/titleMatch shared module: still finds the real film when the decoy sorts first', () => {
    const rows = [{ title: 'Beginning' }, { title: 'Baahubali: The Beginning' }];
    assert.strictEqual(tm.findTitleMatch(rows, 'Bāhubali: The Beginning').title,
        'Baahubali: The Beginning');
});

test('utils/titleMatch shared module: allows a catalogue to omit a sequel suffix', () => {
    // Castle lists "Devara"; TMDB says "Devara: Part 1". Same film.
    assert.strictEqual(tm.findTitleMatch([{ title: 'Devara' }], 'Devara: Part 1').title, 'Devara');
    assert.strictEqual(tm.findTitleMatch([{ title: 'Kantara' }], 'Kantara Chapter 1').title, 'Kantara');
});

test('utils/titleMatch shared module: refuses a prefix whose remainder is a real title word', () => {
    // "Kantara" must not swallow "Kantara A Legend" - the remainder is
    // meaning, not part-number noise.
    assert.strictEqual(tm.findTitleMatch([{ title: 'Kantara A Legend' }], 'Kantara Chapter 1'), null);
    assert.strictEqual(tm.findTitleMatch([{ title: 'Devara Rising' }], 'Devara'), null);
});

test('utils/titleMatch shared module: will not let a short common word win by prefix', () => {
    assert.strictEqual(tm.findTitleMatch([{ title: 'RRR' }], 'RRR 2'), null);
    assert.strictEqual(tm.findTitleMatch([{ title: 'RRR' }], 'RRR').title, 'RRR');
});

test('utils/titleMatch shared module: rejects a year mismatch only when both sides state one', () => {
    const rows = [{ title: 'Kantara', year: 1998 }, { title: 'Kantara', year: 2022 }];
    const get = (r) => r.year;
    assert.strictEqual(tm.findTitleMatch(rows, 'Kantara', { year: 2022, getYear: get }).year, 2022);
    // An unknown year on the row must never reject it.
    const unknown = [{ title: 'Kantara', year: null }];
    assert.ok(tm.findTitleMatch(unknown, 'Kantara', { year: 2022, getYear: get }));
});

test('utils/titleMatch shared module: queries the spellings that were measured to actually find the film', () => {
    // movie/256040: only "Baahubali" returned the real row upstream.
    const spellings = tm.searchSpellings('Bāhubali: The Beginning');
    assert.ok(spellings.includes('Bāhubali: The Beginning'), 'accented spelling');
    assert.ok(spellings.includes('Bahubali: The Beginning'), 'deaccented spelling');
    assert.ok(spellings.includes('Baahubali'), 'doubled-vowel head');
});

test('utils/titleMatch shared module: does not fetch the same spelling twice for a plain ASCII title', () => {
    const spellings = tm.searchSpellings('Inception');
    assert.strictEqual(new Set(spellings).size, spellings.length, 'no duplicates');
    assert.strictEqual(spellings[0], 'Inception', 'faithful spelling first');
});

test('utils/titleMatch shared module: tolerates a leading article differing between catalogues', () => {
    assert.strictEqual(tm.findTitleMatch([{ title: 'Batman' }], 'The Batman').title, 'Batman');
});

// Every title-based provider must now source the rules from the shared module
// rather than carry its own copy - that divergence is what let each fix land in
// only one provider.
// --- providers share one title-matching implementation ---
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'providers', f), 'utf8');

for (const file of ['castletv.js', 'netmirror.js', 'onetouchtv.js', '4khdhub.js', 'dahmermovies.js']) {
    test(`providers share one title-matching implementation: ${file} imports utils/titleMatch`, () => {
        const src = read(file);
        assert.ok(/require\(['"]\.\.\/utils\/titleMatch['"]\)/.test(src),
            `${file} must require ../utils/titleMatch`);
        assert.ok(!/const deaccent = \(v\) =>/.test(src),
            `${file} still defines its own deaccent`);
    });
}

test('providers share one title-matching implementation: castletv never falls back to rows[0]', () => {
    assert.ok(!/\|\|\s*rows\[0\]/.test(read('castletv.js')),
        'a bad match must lose to no match');
});

// --- recall: real false negatives found by resolving live titles ------------
// Found 2026-09-21 by resolving the top Telugu titles and reading the rows
// CastleTV actually offered. All three were REAL films we were skipping.

test('a catalogue may omit a subtitle after the part number', () => {
    // 770906: Castle lists bare "Salaar"; TMDB says "Salaar: Part 1 - Ceasefire".
    // Recovered 1 -> 13 streams once this matched.
    const rows = [{ title: 'Salaar' }, { title: 'Viduthalai: Part 1' }];
    assert.equal(tm.findTitleMatch(rows, 'Salaar: Part 1 - Ceasefire').title, 'Salaar');
});

test('a language tag in the row title does not block the match', () => {
    // 801688: Castle lists "Kalki 2898 AD (Hindi)" for TMDB's "Kalki 2898-AD".
    const rows = [{ title: 'Kalki 2898 AD (Hindi)' }, { title: 'Kalki' }];
    assert.equal(tm.findTitleMatch(rows, 'Kalki 2898-AD').title, 'Kalki 2898 AD (Hindi)');
});

test('the base entry matches a numbered part, its sibling part does not', () => {
    // 660046: BOTH rows came back in one result set. Matching the bare base is
    // right; matching the WRONG part is the Bahubali failure all over again.
    // Recovered 1 -> 7 streams.
    const rows = [{ title: 'Ponniyin Selvan' }, { title: 'Ponniyin Selvan: Part Two' }];
    assert.equal(tm.findTitleMatch(rows, 'Ponniyin Selvan: Part I').title, 'Ponniyin Selvan');
    assert.equal(tm.findTitleMatch([{ title: 'Ponniyin Selvan: Part Two' }],
        'Ponniyin Selvan: Part I'), null, 'Part Two must never answer Part I');
});

test('the same part spelled differently still matches', () => {
    assert.equal(tm.findTitleMatch([{ title: 'Ponniyin Selvan: Part Two' }],
        'Ponniyin Selvan: Part II').title, 'Ponniyin Selvan: Part Two');
});

test('different parts of one series never match each other', () => {
    // The guard that makes the looser passes safe to have at all.
    assert.equal(tm.findTitleMatch([{ title: 'Viduthalai: Part 1' }], 'Viduthalai: Part 2'), null);
    assert.equal(tm.findTitleMatch([{ title: 'Pushpa: The Rise' }], 'Pushpa 2 - The Rule'), null);
});

test('an edition tag in the row title does not block the match', () => {
    // 857598: Castle lists "Pushpa 2: The Rule (Reloaded Version)". A
    // re-release edition is the same film; a part number is not.
    const rows = [{ title: 'Pushpa 2: The Rule (Reloaded Version)' }, { title: 'Pushpa' },
        { title: 'Pushpa Impossible' }, { title: 'Pushpa: The Rise - Part 1' }];
    assert.equal(tm.findTitleMatch(rows, 'Pushpa 2 - The Rule').title,
        'Pushpa 2: The Rule (Reloaded Version)');
    // The prequel sitting in the same result set must not answer the sequel.
    assert.equal(tm.findTitleMatch([{ title: 'Pushpa: The Rise - Part 1' }],
        'Pushpa 2 - The Rule'), null);
});
