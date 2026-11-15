// One definition of "is this catalogue row the film we asked for?".
//
// WHY THIS EXISTS
// Five providers each grew their own title normaliser, and each was fixed only
// where someone happened to look. Measured 2026-09-21, all on real traffic:
//
//   castletv      "Bahubali" (a-macron) normalised to "b hubali the beginning"
//                 - the macron fell outside [a-z0-9] and became a SPACE - then
//                 a substring fallback matched a DIFFERENT film titled
//                 "Beginning" at rows[0]. We played the wrong movie and
//                 reported the title as Tamil-only.
//   netmirror     same deaccent bug; also needed "Bahubali" ~ "Baahubali".
//   onetouchtv    upstream 404s on the accented spelling, 200 on the plain one.
//   4khdhub       same bare [^a-z0-9] strip, no deaccent at all.
//   dahmermovies  title goes into a URL PATH, so the macron percent-encoded
//                 into a directory that does not exist.
//
// A census of 15 real Indic titles found 11 normalised to garbage:
//   "Arya" -> "rya"   "Kantara" -> "k nt r"   "Sita Ramam" -> "s t ramam"
//
// THE RULE
// Matching is fuzzy, so a WRONG match must lose to NO match. A provider that
// cannot identify the title returns nothing and lets another provider win; a
// wrong stream that plays is undetectable downstream and strands the viewer on
// another film. Every helper here is built to fail closed.

// Sequel/part noise a catalogue may omit. Castle lists "Devara" where TMDB
// says "Devara: Part 1" - the same film, and rejecting it cost a real stream.
//
// The part NUMBER is captured, not just skipped: "Ponniyin Selvan" must match
// "Ponniyin Selvan: Part I" but NOT the row sitting beside it in the same
// result set, "Ponniyin Selvan: Part Two" (measured on 660046). A suffix that
// names a different part is a different film.
//
// A subtitle after the part number ("Salaar: Part 1 - Ceasefire", measured on
// 770906 where Castle lists bare "Salaar") is allowed: the part number already
// pins the entry, so trailing words only add detail.
const ORDINALS = {
    i: 1, ii: 2, iii: 3, iv: 4, v: 5,
    one: 1, two: 2, three: 3, four: 4, five: 5,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
};
const SUFFIX_NOISE = /^(?:part|chapter|vol|volume|book|season|pt)?\s*\d*\s*$/;
const PART_SUFFIX = /^(?:part|chapter|vol|volume|book|season|pt)\s*([0-9]+|[a-z]+)\b(.*)$/;

/** The part number a title's trailing suffix names, or null. */
function partNumber(rest) {
    const m = String(rest || '').trim().match(PART_SUFFIX);
    if (!m) return null;
    const tok = m[1];
    if (/^[0-9]+$/.test(tok)) return Number(tok);
    return Object.prototype.hasOwnProperty.call(ORDINALS, tok) ? ORDINALS[tok] : null;
}

// Tags some catalogues append to the title itself, which name an EDITION or a
// dub rather than a different film:
//   "Kalki 2898 AD (Hindi)"                for TMDB's "Kalki 2898-AD"      (801688)
//   "Pushpa 2: The Rule (Reloaded Version)" for "Pushpa 2 - The Rule"       (857598)
// NetMirror models dubs this way too. Stripped for COMPARISON only - the row
// object is returned untouched, so the caller still sees the language/edition.
//
// Deliberately NOT stripped: anything naming a different cut of the STORY
// (a part or chapter number), which is handled by the part-number logic above.
const LANG_WORDS = 'hindi|telugu|tamil|malayalam|kannada|english|bengali|marathi'
    + '|punjabi|gujarati|urdu|odia|assamese|bhojpuri|dubbed|dub';
const EDITION_WORDS = 'reloaded|extended|uncut|remastered|restored|theatrical'
    + '|director\'s|directors|special|deluxe|final';
const LANGUAGE_TAG = new RegExp(
    '\\s*[\\(\\[]\\s*(?:' + LANG_WORDS + '|(?:[a-z\']+\\s+)?(?:' + EDITION_WORDS + ')'
    + '(?:\\s+(?:version|cut|edition))?|(?:' + EDITION_WORDS + ')?\\s*(?:version|cut|edition))'
    + '\\s*[\\)\\]]\\s*$|\\s*\\b(?:' + LANG_WORDS + ')\\s*$', 'i');

function stripLanguageTag(value) {
    let out = String(value || '');
    let prev;
    do { prev = out; out = out.replace(LANGUAGE_TAG, '').trim(); } while (out !== prev);
    return out;
}

// Leading articles differ between catalogues far more often than they mean
// anything ("The Beginning" vs "Beginning").
const LEADING_ARTICLE = /^(?:the|a|an)\s+/;

/** Strip combining marks: "Bāhubali" -> "Bahubali". Always run FIRST. */
function deaccent(value) {
    return String(value == null ? '' : value).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Canonical comparison form: deaccented, lowercased, punctuation to spaces.
 * "Bāhubali: The Beginning" -> "bahubali the beginning"
 */
function normalizeTitle(value) {
    return deaccent(value)
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Looser form for transliteration spelling drift. Indic romanisation doubles
 * vowels inconsistently: TMDB writes "Bahubali", Castle writes "Baahubali".
 * Collapsing vowel runs makes the two comparable without loosening anything
 * else. Applied to BOTH sides, so it never widens one side alone.
 */
function looseTitle(value) {
    return normalizeTitle(value).replace(/([aeiou])\1+/g, '$1');
}

/** Drop a leading article for comparison only. */
function withoutArticle(value) {
    return String(value || '').replace(LEADING_ARTICLE, '').trim();
}

/**
 * Does `row` name the same film as `want`, allowing only a missing sequel
 * suffix?
 *
 * A plain substring test is what let "Beginning" match "Bahubali The
 * Beginning". A pure length ratio then rejected "Devara" against "Devara:
 * Part 1". Neither is about length - it is about WHERE the shorter title sits
 * and whether the words it drops carry meaning:
 *
 *   "Devara"    is a PREFIX of "devara part 1"; the remainder is sequel noise.
 *   "Beginning" is a SUFFIX; the words it drops ("bahubali") are the
 *               distinctive ones, so it must NOT match.
 */
function isPrefixWithSuffixNoise(row, want) {
    if (!row || !want) return false;
    const [short, long] = row.length <= want.length ? [row, want] : [want, row];
    if (short.length < 4) return false;          // "RRR" must match exactly
    if (short === long) return true;
    if (!long.startsWith(short + ' ')) return false;
    const rest = long.slice(short.length).trim();
    // Bare noise: "Devara" vs "devara part 1", or a trailing number.
    if (SUFFIX_NOISE.test(rest)) return true;
    // "part 1 ceasefire" - a numbered part with a subtitle after it. The part
    // number pins the entry, so the extra words are detail, not a new film.
    return partNumber(rest) !== null;
}

/**
 * True when two titles name DIFFERENT parts of the same series.
 *
 * "Ponniyin Selvan: Part I" and "Ponniyin Selvan: Part Two" share a prefix and
 * differ only in a suffix that isPrefixWithSuffixNoise would wave through.
 * Both appeared in one Castle result set (660046), so this has to be checked
 * before any loose pass can be trusted.
 */
/**
 * True when two titles name the SAME part of the same series in different
 * notation: "Ponniyin Selvan Part II" vs "Ponniyin Selvan Part Two".
 */
function samePart(a, b) {
    if (!a || !b) return false;
    const sa = splitPart(a);
    const sb = splitPart(b);
    if (sa.part === null || sb.part === null) return false;
    if (sa.part !== sb.part) return false;
    if (!sa.base || sa.base.length < 4) return false;
    return sa.base === sb.base;
}

/**
 * Split "ponniyin selvan part two" into {base: 'ponniyin selvan', part: 2}.
 *
 * Done on the WHOLE title rather than on the remainder after a shared prefix:
 * commonPrefix("...part two", "...part ii") consumes the word "part" itself,
 * leaving "two" and "ii" with no keyword left for partNumber to anchor on.
 */
function splitPart(value) {
    const v = String(value || '').trim();
    const m = v.match(/^(.*?)\s+((?:part|chapter|vol|volume|book|season|pt)\s+(?:[0-9]+|[a-z]+))(?:\s+.*)?$/);
    if (!m) return { base: v, part: null };
    const part = partNumber(m[2]);
    return part === null ? { base: v, part: null } : { base: m[1].trim(), part };
}

/** Longest shared whole-word prefix of two normalised titles. */
function commonPrefix(a, b) {
    const wa = a.split(' ');
    const wb = b.split(' ');
    const out = [];
    for (let i = 0; i < Math.min(wa.length, wb.length); i += 1) {
        if (wa[i] !== wb[i]) break;
        out.push(wa[i]);
    }
    return out.join(' ');
}

function conflictingParts(a, b) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    const pa = partNumber(a.startsWith(shorter) ? a.slice(shorter.length).trim() : '');
    const pb = partNumber(b.startsWith(shorter) ? b.slice(shorter.length).trim() : '');
    void longer;
    if (pa === null || pb === null) return false;
    return pa !== pb;
}

/**
 * Search spellings to ASK a provider for, best first.
 *
 * Deaccenting only helps if the PLAIN spelling also reaches the provider's own
 * search: comparing locally while querying in the accented spelling still
 * returns zero rows when the upstream index is ASCII-only, and zero rows is
 * indistinguishable from "this provider has no copy".
 *
 * Measured on movie/256040 against NetMirror: "Bāhubali" returned 1 unrelated
 * row, "Bahubali" returned 1 unrelated row, and "Baahubali" returned the real
 * "Baahubali - The Beginning". So neither deaccenting NOR the accented spelling
 * alone can find the film - the doubled-vowel spelling has to be queried too.
 *
 * Ordered most-faithful first; the caller stops at the first spelling that
 * returns rows, so an ASCII title that works as-is still costs exactly one
 * request. findTitleMatch still verifies whatever comes back, so a speculative
 * spelling can never pull in a wrong film.
 *
 * @param {string} title
 * @param {{year?: string|number|null, head?: boolean}} [opts]
 *   `year` prepends year-qualified spellings (some search endpoints rank
 *   better with it). `head` (default true) adds the text before the first
 *   colon/dash - "Kantara" for "Kantara: A Legend" - which some catalogues
 *   index without the subtitle.
 */
function searchSpellings(title, { year = null, head = true } = {}) {
    const raw = String(title || '').trim();
    if (!raw) return [];
    const out = [];
    const add = (v) => { const t = String(v || '').trim(); if (t && !out.includes(t)) out.push(t); };

    const plain = deaccent(raw);
    // Punctuation between the same two words differs by catalogue:
    // "Kantara - A Legend: Chapter 1" vs "Kantara A Legend Chapter 1".
    const depunct = (v) => String(v).replace(/[-\u2013\u2014:]/g, ' ').replace(/\s+/g, ' ').trim();

    if (year) { add(`${raw} ${year}`); add(`${plain} ${year}`); }
    add(raw);
    add(plain);
    add(depunct(raw));
    add(depunct(plain));

    if (head) {
        const headRaw = raw.split(/[:\u2013\u2014]/)[0].trim();
        const headPlain = deaccent(headRaw);
        add(depunct(headRaw));
        add(headRaw);
        add(headPlain);
        // Doubled first vowel: "Bahubali" -> "Baahubali". Only for a single
        // alphabetic word, so it never mangles a sentence-like title.
        if (headPlain && /^[a-z]+$/i.test(headPlain)) {
            const m = headPlain.match(/^([b-df-hj-np-tv-z]*)([aeiou])(.*)$/i);
            if (m) add(`${m[1]}${m[2]}${m[2]}${m[3]}`);
        }
    }
    return out;
}

/**
 * Pick the row that names `title`, or NULL.
 *
 * Passes run strictest first and stop at the first hit. There is deliberately
 * no "best guess" fallback: returning rows[0] is what made castletv serve a
 * different film. `getTitle` reads the title off a row (default: r.title or
 * r.name), and `year`/`getYear` gate the match when both sides know a year.
 */
function findTitleMatch(rows, title, { getTitle, year = null, getYear = null } = {}) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length || !title) return null;

    const readTitle = getTitle || ((r) => (typeof r === 'string' ? r : (r.title || r.name || '')));
    const want = normalizeTitle(title);
    const wantLoose = looseTitle(title);
    const wantBare = withoutArticle(want);
    if (!want) return null;

    // A year mismatch is a hard reject when BOTH sides state one: it is the
    // cheapest way to separate a remake from the original.
    const yearOk = (row) => {
        if (!year || !getYear) return true;
        const y = getYear(row);
        if (!y) return true;                      // unknown year never rejects
        return String(y) === String(year);
    };
    const candidates = list.filter(yearOk);
    const pool = candidates.length ? candidates : list;

    // A language tag in the row title ("Kalki 2898 AD (Hindi)") is stripped for
    // comparison only; the row itself is returned untouched.
    const rowNorm = (r) => normalizeTitle(stripLanguageTag(readTitle(r)));
    const rowLoose = (r) => looseTitle(stripLanguageTag(readTitle(r)));

    const passes = [
        (r) => rowNorm(r) === want,
        (r) => rowLoose(r) === wantLoose,
        (r) => withoutArticle(rowNorm(r)) === wantBare,
        // Same base title, same part, spelled differently: "Part II" vs
        // "Part Two". Strict - the numbers must be EQUAL and both present.
        (r) => samePart(rowNorm(r), want),
        // Looser passes only from here. Each is guarded by conflictingParts so
        // "Ponniyin Selvan: Part Two" can never answer a request for Part I.
        (r) => !conflictingParts(rowNorm(r), want) && isPrefixWithSuffixNoise(rowNorm(r), want),
        (r) => !conflictingParts(rowLoose(r), wantLoose)
            && isPrefixWithSuffixNoise(rowLoose(r), wantLoose),
    ];
    for (const pass of passes) {
        const hit = pool.find(pass);
        if (hit) return hit;
    }
    return null;
}

// Adapter for the older call shape still used by onetouchtv.js,
// tmdbTitleToImdb.js and hdghartv.js: (query, candidates) -> { best }.
// Candidates are { title, year?, raw }. The shared module dropped this name,
// and those callers then threw "findBestMatch is not a function" on every
// title (prod 2026-11-15, OneTouchTV 0 streams on all 14 bench titles).
function findBestMatch(query, candidates) {
    const q = query || {};
    const best = findTitleMatch(candidates, q.title, {
        getTitle: (c) => c.title || '',
        year: q.year || null,
        getYear: (c) => c.year || null,
    });
    return { best: best || null };
}

// hdghartv: try each spelling through `search` until one matches.
async function findBestMatchWithRetry(query, variants, search) {
    for (const v of (variants && variants.length ? variants : [query.title])) {
        const rows = await search(v);
        const { best } = findBestMatch(query, rows);
        if (best) return { best };
    }
    return { best: null };
}

module.exports = {
    findBestMatch, findBestMatchWithRetry,
    SUFFIX_NOISE,
    deaccent, normalizeTitle, looseTitle, withoutArticle, stripLanguageTag,
    partNumber, conflictingParts, samePart, splitPart,
    isPrefixWithSuffixNoise, searchSpellings, findTitleMatch,
};
