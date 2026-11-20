// Canonical stream contract.
//
// Every provider returns objects of different shapes, and the UI compensated by
// parsing display strings: public/watch.js:40 pulls the language out of the
// `name` with /\[([^\]]+)\]/. That is why a provider had to spell its languages
// into a label to make the audio menu work at all, and why a stream with a real
// `language` field but no bracket in its name showed nothing.
//
// This module is the single definition of a stream. Providers emit whatever is
// natural to them; normaliseStream() converts it once, at the registry boundary,
// so the API and the UI see one shape.
//
// FIELD CONTRACT
//   url        string   required. Playable URL, pre-proxy.
//   provider   string   required. Stable id, e.g. "CastleTV". Grouping key.
//   title      string   human label for the card. Never parsed by code.
//   quality    string   one of QUALITIES. "Auto" when the manifest decides.
//   languages  string[] display names, e.g. ["Telugu","Hindi"]. [] = unknown.
//                       NOT a joined string: joining forced the UI to re-split.
//   audio      object[] {language, codec, channels} per known audio track.
//   subtitles  object[] {url, lang, id}
//   size       string   human readable, e.g. "10.1 GB". null when unknown.
//   headers    object   request headers the URL needs.
//   container  string   "hls" | "mp4" | "mkv" | null
//   selectableAudio bool true = the URL exposes switchable audio renditions.
//   codecs     string   RFC 6381 CODECS of the HLS master, e.g.
//                       "hvc1.1.6.L150.90,mp4a.40.2". null when unknown.
//   videoCodec string   "hevc" | "avc" | "av1" | "vp9" | null (unknown).
//                       Lets a player skip a codec its browser cannot decode.
//
// `language` (joined string) and `name` are still emitted for backward
// compatibility with the current UI; they are DERIVED from languages, never
// the source of truth. Remove them once watch.js reads `languages` directly.

const QUALITIES = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'Auto'];
// Snapping a pixel height to a display tier is HLS knowledge, and it already
// lives in the manifest parser. Reuse it so 804p cannot mean 720p in one place
// and something else in another.
const { heightToTier, videoCodecFamily } = require('../lib/media/hlsManifest');

// ISO 639-2 and the loose spellings providers actually use.
const LANG_CANON = {
    hin: 'Hindi', hi: 'Hindi', hindi: 'Hindi',
    tel: 'Telugu', te: 'Telugu', telugu: 'Telugu',
    tam: 'Tamil', ta: 'Tamil', tamil: 'Tamil',
    mal: 'Malayalam', ml: 'Malayalam', malayalam: 'Malayalam',
    kan: 'Kannada', kn: 'Kannada', kannada: 'Kannada',
    eng: 'English', en: 'English', english: 'English',
    ben: 'Bengali', bengali: 'Bengali', mar: 'Marathi', marathi: 'Marathi',
    guj: 'Gujarati', gujarati: 'Gujarati', pan: 'Punjabi', punjabi: 'Punjabi',
    urd: 'Urdu', urdu: 'Urdu', ori: 'Odia', odia: 'Odia',
    asm: 'Assamese', assamese: 'Assamese', spa: 'Spanish', fra: 'French',
    deu: 'German', ger: 'German', jpn: 'Japanese', kor: 'Korean',
    zho: 'Chinese', chi: 'Chinese', por: 'Portuguese', rus: 'Russian',
    tur: 'Turkish', ara: 'Arabic', tha: 'Thai', ind: 'Indonesian',
};

// `und` and `unknown` are deliberately absent: an untagged track is NOT a
// language, and mapping it to a name invents information we do not have.
function canonicalLanguage(value) {
    if (!value) return null;
    const key = String(value).trim().toLowerCase();
    if (!key || key === 'und' || key === 'unknown' || key === 'original') return null;
    if (LANG_CANON[key]) return LANG_CANON[key];
    // Unrecognised but non-empty: title-case it rather than drop it.
    return key.charAt(0).toUpperCase() + key.slice(1);
}

function canonicalQuality(value, fallbackText) {
    const probe = `${value || ''} ${fallbackText || ''}`;
    const m = probe.match(/\b(2160p|1440p|1080p|720p|480p|360p)\b/i);
    if (m) return m[1].toLowerCase().replace('P', 'p');
    if (/\b(4k|uhd)\b/i.test(probe)) return '2160p';
    return 'Auto';
}

// Providers that spell languages into the label - "CastleTV [Hindi/Telugu]" -
// are the reason watch.js parses names. Read it here ONCE so the rest of the
// pipeline never has to.
function languagesFromLabel(label) {
    const m = String(label || '').match(/\[([^\]]+)\]/);
    if (!m) return [];
    // Only RECOGNISED languages. canonicalLanguage title-cases anything it does
    // not know, which turned a release-group tag into a language: measured
    // 2026-09-21, "...AAC5 1-[YTS MX]" came out as languages:["Yts mx"] and the
    // UI offered "Yts mx" in the audio list. A bracket in a scene name is far
    // more often a group tag than a language, so an unknown token is dropped
    // here rather than invented. A provider that really means an unusual
    // language should send the structured `languages` field, which still
    // accepts anything.
    return m[1].split(/[\/,|]/)
        .map((tok) => String(tok).trim().toLowerCase())
        .filter((tok) => Object.prototype.hasOwnProperty.call(LANG_CANON, tok))
        .map(canonicalLanguage)
        .filter(Boolean);
}

// Scene release names state the language as a bare token rather than in a
// bracket: "Ala Vaikunthapurramuloo 2020 1080p HINDI 10bit DDP 5 1 x265".
// Measured 2026-09-21 on 628241, a TELUGU original - VaPlayer returned that
// file with languages:[] so the UI could not warn that it is a Hindi dub, and
// the Audio menu had to leave it out entirely.
//
// Deliberately conservative, because a title is a guess and the cost of a
// wrong language is a viewer hearing the wrong dub:
//   - whole words only, so "Tamilrockers" or "HINDIzone" never match;
//   - "dual"/"multi" audio is NOT resolved to a language list, since we do not
//     know WHICH languages, and claiming one would be worse than claiming none;
//   - read only when nothing structured and no bracket was given.
const RELEASE_LANG = new RegExp(
    '(?:^|[^a-z])(hindi|telugu|tamil|malayalam|kannada|bengali|marathi|punjabi'
    + '|gujarati|urdu|english)(?:[^a-z]|$)', 'gi');

function languagesFromReleaseName(label) {
    const text = String(label || '');
    const out = [];
    let m;
    RELEASE_LANG.lastIndex = 0;
    while ((m = RELEASE_LANG.exec(text)) !== null) {
        const lang = canonicalLanguage(m[1]);
        if (lang && !out.includes(lang)) out.push(lang);
        // Overlapping separators ("HINDI-TAMIL") would otherwise skip a token.
        RELEASE_LANG.lastIndex = m.index + m[0].length - 1;
    }
    return out;
}

// Remove a trailing "[...]" language bracket so it can be re-stamped from the
// canonical languages array instead of being trusted as-is.
function stripLangBracket(label) {
    return String(label || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function inferContainer(url) {
    const u = String(url || '').toLowerCase();
    if (/\.m3u8(\?|$)/.test(u) || u.includes('m3u8-proxy')) return 'hls';
    if (/\.mkv(\?|$)/.test(u)) return 'mkv';
    if (/\.mp4(\?|$)/.test(u)) return 'mp4';
    return null;
}

function normaliseStream(raw) {
    if (!raw || typeof raw !== 'object' || !raw.url) return null;

    const label = raw.name || raw.title || '';

    // Precedence: an explicit structured field beats anything parsed from a
    // display string, because a label is a guess and a field is a statement.
    let languages = [];
    if (Array.isArray(raw.languages)) languages = raw.languages.map(canonicalLanguage).filter(Boolean);
    else if (raw.language) languages = String(raw.language).split(/[\/,|]/).map(canonicalLanguage).filter(Boolean);
    if (!languages.length) languages = languagesFromLabel(label);
    // Last resort: a bare language token in a scene release name.
    //
    // Read `name` AND `title`, not just `label`. `label` is `name || title`,
    // and VaPlayer sets name:'VaPlayer' with the release string in `title` -
    // so looking at `label` alone examined the literal word "VaPlayer" and
    // found nothing. Measured on 628241, where the file is marked HINDI.
    if (!languages.length) {
        languages = languagesFromReleaseName(`${raw.name || ''} ${raw.title || ''}`);
    }
    languages = [...new Set(languages)];

    const audio = Array.isArray(raw.audio)
        ? raw.audio.map((t) => ({
            language: canonicalLanguage(t && (t.language || t.lang)),
            codec: (t && t.codec) || null,
            channels: (t && Number(t.channels)) || null,
        }))
        : [];

    const subtitles = Array.isArray(raw.subtitles)
        ? raw.subtitles.filter((s) => s && s.url).map((s, i) => ({
            url: s.url,
            lang: canonicalLanguage(s.lang || s.language || s.label) || s.lang || `Subtitle ${i + 1}`,
            id: s.id || `sub-${i}`,
        }))
        : [];

    let quality = canonicalQuality(raw.quality, `${label} ${raw.title || ''}`);

    // The selectable video ladder, when the provider knows it (normally read
    // from an HLS master). A UI quality menu needs the individual heights, not
    // just the single best one in `quality`. Normalised to {height, quality}
    // and sorted best-first; [] means "not known", never "only one level".
    const levels = Array.isArray(raw.levels)
        ? raw.levels
            .map((l) => {
                const height = Number(l && l.height);
                if (!Number.isFinite(height) || height <= 0) return null;
                return {
                    height,
                    quality: (l && l.quality) || heightToTier(height) || 'Auto',
                    bandwidth: Number(l && l.bandwidth) || null,
                    codecs: (l && l.codecs) || null,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.height - a.height)
        : [];

    // A provider that reports a ladder has already STATED its best height, so
    // "Auto" there is a worse answer than the number it just gave us. Measured
    // 2026-09-22: mapple returned levels [2160,1080,720,360] and the card still
    // read "Auto", because canonicalQuality only ever looked at display text
    // and mapple puts nothing about resolution in its label. Only fills a gap -
    // an explicit quality from the provider still wins.
    if (quality === 'Auto' && levels.length) {
        quality = heightToTier(levels[0].height) || 'Auto';
    }

    return {
        url: raw.url,
        provider: raw.provider || raw.name || 'Unknown',
        title: raw.title || label || raw.provider || 'Stream',
        quality,
        ...(raw.netmirrorCatalog ? { netmirrorCatalog: String(raw.netmirrorCatalog) } : {}),
        levels,
        languages,
        ...(Array.isArray(raw.catalogLanguages) ? { catalogLanguages: [...new Set(raw.catalogLanguages.map(canonicalLanguage).filter(Boolean))] } : {}),
        audio,
        subtitles,
        size: raw.size || null,
        container: raw.container || inferContainer(raw.url),
        // An explicit false must survive: a provider that KNOWS it has no
        // switcher should not be overridden by audio.length. Only infer when
        // the provider said nothing.
        selectableAudio: raw.selectableAudio !== undefined
            ? Boolean(raw.selectableAudio)
            : audio.length > 1,
        headers: raw.headers || {},
        codecs: raw.codecs || null,
        videoCodec: raw.videoCodec || videoCodecFamily(raw.codecs) || null,

        // Derived, for the current UI. watch.js reads `name` for the [lang]
        // bracket and `language` for the details line; keep both consistent
        // with `languages` so the two can never disagree.
        //
        // The bracket is REWRITTEN, not merely appended when absent. Skipping a
        // label that already had one let a stale bracket outrank the canonical
        // field: {name:"X [Hindi]", languages:["tel"]} normalised to languages
        // ["Telugu"] while name kept "[Hindi]", and watch.js:40 reads the name -
        // so the UI showed Hindi for a Telugu stream. No live provider hits this
        // today (0/33 streams on 2026-09-21), but the whole point of this module
        // is that the structured field wins, and `name` is derived from it.
        name: languages.length
            ? `${stripLangBracket(label) || raw.provider || raw.name || 'Stream'} [${languages.join('/')}]`
            : label || raw.provider || 'Stream',
        language: languages.join('/') || undefined,

        ...(raw.__noProxy ? { __noProxy: true } : {}),
        // Survives normalisation so the player can pick its buffering profile.
        ...(raw.hybrid ? { hybrid: true } : {}),
    };
}

function normaliseStreams(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normaliseStream).filter(Boolean);
}

module.exports = {
    QUALITIES, LANG_CANON,
    canonicalLanguage, canonicalQuality, languagesFromLabel, languagesFromReleaseName,
    inferContainer, stripLangBracket, normaliseStream, normaliseStreams,
};
