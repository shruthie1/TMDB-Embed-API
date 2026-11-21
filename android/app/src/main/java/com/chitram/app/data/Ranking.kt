package com.chitram.app.data

/**
 * Kotlin port of web/lib/backend.js (toSource, sourceHeight, rankSources and the
 * remembered-provider reorder in resolveLive) and web/lib/player/trackChoices.js.
 *
 * Telugu-first: the scarce resource is LANGUAGE, not pixels, so resolution
 * never re-sorts inside a tier (the server's order stands). A row the device
 * cannot decode ranks last.
 */
data class Source(
    val id: String,
    val provider: String,
    val label: String,
    val url: String,
    val progressive: Boolean,
    val quality: String,
    val levels: List<Level>,
    val languages: List<String>,
    val selectableAudio: Boolean,
    val hybrid: Boolean,
    val subtitles: List<SubtitleRef>,
    val videoCodec: String?,
    val codecString: String?,
    val unsupported: Boolean,
    /** Set for a row resolved on this device (mapple, VaPlayer); null for backend rows. */
    val onDevice: String? = null,
    /** Sent on every player request for this row (provider Referer/Origin). */
    val headers: Map<String, String> = emptyMap(),
    /** vaplayer host token: appended as ?token= to every request that lacks one. */
    val segmentToken: String? = null,
    /** Actual known rendition languages; null keeps legacy metadata fallback. */
    val audioLanguages: List<String>? = null,
    /** Read-only catalog availability, separate from playable language choices. */
    val catalogLanguages: List<String> = emptyList(),
    val netmirrorCatalog: String? = null,
    /** The provider returned usable rows while more catalogs/dubs remain unresolved. */
    val incomplete: Boolean = false,
    /**
     * Languages whose first in-stream rendition has its own uri (web
     * sourceAudioRenditions `uri`). Add-audio tries these donors first (I4).
     */
    val uriLanguages: List<String> = emptyList(),
    /** Upstream url the APK may play directly (route.apk == "direct"); null = proxy only. */
    val directUrl: String? = null,
    /** Headers for [directUrl] (provider Referer/Origin/UA). */
    val directHeaders: Map<String, String> = emptyMap(),
    /** Set while this row plays direct: the proxied url to fall back to (player.DirectRoute). */
    val proxyUrl: String? = null,
)

/** Answers "can this device decode this video codec family?" null = unknown. */
fun interface CodecSupport {
    fun supports(videoCodec: String?, codecString: String?): Boolean?
}

object Ranking {
    private val HLS_URL = Regex("""\.m3u8(\?|$)""", RegexOption.IGNORE_CASE)
    private val HLS_PROXY = Regex("""m3u8-proxy|[?&]url=[^&]*m3u8""", RegexOption.IGNORE_CASE)
    private val HEIGHT = Regex("""(\d{3,4})p""")

    // Locale understands bibliographic "cze" but not terminologic "ces" on
    // every Android/JVM version. Map the ISO3 code through the ISO2 locale first.
    private val iso3ToIso2: Map<String, String> = java.util.Locale.getISOLanguages().mapNotNull { code ->
        runCatching { java.util.Locale(code).isO3Language to code }.getOrNull()
    }.toMap()
    private val LANGUAGE_CODE = Regex("^[a-z]{2,3}$")
    // BCP-47 region or script subtag: IN, Hant, 419. Anything else (Telugu-Hindi, eng-sub) is not stripped.
    private val SUBTAG = Regex("^(?:[a-z]{2}|[a-z]{4}|\\d{3})$")
    // A regional variety the web player names apart from its base language.
    private val KEEP_REGION = setOf("pt-br")
    /** Lower-case English display name -> display name, for every ISO 639 language. */
    private val knownNames: Map<String, String> = java.util.Locale.getISOLanguages().mapNotNull { code ->
        codeName(code)?.let { it.lowercase(java.util.Locale.ROOT) to it }
    }.toMap()
    private val WORD = Regex("[A-Za-z]+")
    private val INDEX_PREFIX = Regex("^\\[\\d+]\\s*")
    private val NOT_A_LANGUAGE = Regex("^(?:track|audio|default|unknown|und|original)(?:\\s*[-#]?\\s*\\d+)?$", RegexOption.IGNORE_CASE)

    /** English name for a 2-3 letter lower-case ISO 639 code, or null when the JVM does not know it. */
    private fun codeName(code: String): String? {
        val iso2 = iso3ToIso2[code] ?: code
        val display = java.util.Locale(iso2).getDisplayLanguage(java.util.Locale.ENGLISH)
            // CLDR (JDK 17, newer Android ICU) names bn "Bangla"; the server and web say "Bengali" (review R2-M1).
            .let { if (it.equals("Bangla", true)) "Bengali" else it }
        return display.takeUnless { it.isBlank() || it.equals(iso2, true) || it.equals(code, true) }
    }

    /** Display name for a bare code or full language name in any case; null when not a known language. */
    private fun knownLanguage(key: String): String? =
        (if (LANGUAGE_CODE.matches(key)) codeName(key) else null) ?: knownNames[key] ?: NAME_ALIASES[key]?.let(::codeName)

    // CLDR (JDK 17, newer Android ICU) says "Bangla" for bn; the server and web say "Bengali".
    private val NAME_ALIASES = mapOf("bengali" to "bn", "bangla" to "bn", "oriya" to "or", "odia" to "or")

    /**
     * Provider codes and display labels share one language identity in menus.
     * te, tel, Telugu, TELUGU and tel-IN all give "Telugu". Mirrors the server's
     * canonicalLanguage: a region/script subtag is stripped only when it is 2
     * letters, 4 letters or 3 digits and the base is a known language, so
     * Telugu-Hindi is never split. pt-BR stays as given. Unknown values are kept raw.
     */
    fun languageLabel(value: String?): String? {
        val raw = value?.trim()?.takeIf(String::isNotEmpty) ?: return null
        val key = raw.lowercase(java.util.Locale.ROOT).replace('_', '-')
        if (key.substringBefore('-') in setOf("und", "mul", "zxx", "unknown")) return null
        if (key in KEEP_REGION) return raw
        knownLanguage(key)?.let { return it }
        val sep = key.indexOf('-')
        if (sep > 0 && SUBTAG.matches(key.substring(sep + 1))) knownLanguage(key.substring(0, sep))?.let { return it }
        return raw
    }

    /**
     * The known language a value names, or null (server streamSchema
     * knownLanguage): no raw fallback, so "Hindi dubbed" or "Dual" is null.
     */
    fun knownLanguageName(value: String?): String? {
        val raw = value?.trim()?.takeIf(String::isNotEmpty) ?: return null
        val key = raw.lowercase(java.util.Locale.ROOT).replace('_', '-')
        if (key in setOf("und", "unknown", "original", "mul", "zxx")) return null
        knownLanguage(key)?.let { return it }
        val sep = key.indexOf('-')
        if (sep > 0 && SUBTAG.matches(key.substring(sep + 1))) knownLanguage(key.substring(0, sep))?.let { return it }
        return null
    }

    /** ISO 639-1 code for a language in any spelling (Telugu, tel, tel-IN -> te), or null. */
    fun languageCode(value: String?): String? {
        val name = languageLabel(value) ?: return null
        return java.util.Locale.getISOLanguages().firstOrNull { codeName(it)?.equals(name, true) == true }
    }

    /** The one audio-language comparison key: lower-case canonical label, null for unknown/und. */
    fun canonLang(value: String?): String? = languageLabel(value)?.lowercase(java.util.Locale.ROOT)?.replace('_', '-')

    /** True when both values name the same known language (te == Telugu == tel-IN). */
    fun sameLanguage(a: String?, b: String?): Boolean {
        val x = canonLang(a) ?: return false
        return x == canonLang(b)
    }

    /** False for placeholders such as "Audio", "Track 2", "und" or "Original". */
    fun isKnownAudioLanguage(value: String?): Boolean = !value.isNullOrBlank() && !NOT_A_LANGUAGE.matches(value.trim())

    /**
     * Language named in a track label (web languageFromTrackName): 'Telugu 5.1',
     * 'TEL - Stereo', '[2] Telugu (AAC)', 'HE-AAC Telugu'. Pass 1: the first word
     * that is a full language name in any case wins, anywhere in the label.
     * Pass 2, only when pass 1 found nothing: an ALL-CAPS 2-3 letter code that is
     * not an audio/codec word (HE, AAC, DD, CH ...). Lower-case short words such as
     * 'per', 'it' or 'de' never count. With no such word the cleaned label is kept
     * when it is not a placeholder.
     */
    fun languageFromTrackName(name: String?): String? {
        val cleaned = name.orEmpty().replace(INDEX_PREFIX, "").trim()
        val tokens = WORD.findAll(cleaned).map { it.value }.toList()
        for (token in tokens) {
            val word = token.lowercase(java.util.Locale.ROOT)
            (knownNames[word] ?: NAME_ALIASES[word]?.let(::codeName))?.let { return it }
        }
        for (token in tokens) {
            if (token.length in 2..3 && token == token.uppercase(java.util.Locale.ROOT) && token !in CODEC_WORDS) {
                codeName(token.lowercase(java.util.Locale.ROOT))?.let { return it }
            }
        }
        return cleaned.takeIf(::isKnownAudioLanguage)
    }

    // ALL-CAPS label words that are audio/codec/accessibility terms, never language codes.
    private val CODEC_WORDS = setOf("HE", "LC", "AAC", "AC", "EAC", "DD", "DDP", "DTS", "ATMOS", "CH", "SD", "HD",
        "SDH", "DV", "PCM", "HI", "AD", "VO", "ORI", "LAT", "ALT", "BR", "IN", "MA")

    // Words a label may carry beside its language and still name only that
    // language: codec, channel and track words. Not BR, LAT or IN: those qualify
    // the language (Portuguese BR, Spanish LAT). Same list as server streamSchema.js
    // and web languageSources.js TRACK_WORDS.
    private val TRACK_WORDS = setOf("he", "lc", "aac", "ac", "eac", "dd", "ddp", "dts", "atmos", "ch", "sd", "hd", "sdh",
        "dv", "pcm", "hi", "ad", "vo", "ori", "alt", "ma", "e", "stereo", "mono", "surround", "audio", "track",
        "dolby", "digital", "plus", "original", "main", "default", "kbps")

    /**
     * The ONE language a label names ('Telugu 5.1', 'Hindi AAC 2.0', 'TEL'), or null.
     * Strict form of languageFromTrackName, same as server and web trackNameLanguage:
     * a word is a language when it is a full name in any case, or an ALL-CAPS 2-3
     * letter code not in CODEC_WORDS. Null when the label names two languages or
     * carries any other word ('Portuguese (Brazil)'), so nothing is lost.
     */
    fun trackNameLanguage(name: String?): String? {
        val cleaned = name.orEmpty().replace(INDEX_PREFIX, "").trim()
        val found = LinkedHashSet<String>()
        for (token in WORD.findAll(cleaned).map { it.value }) {
            val word = token.lowercase(java.util.Locale.ROOT)
            val lang = knownNames[word] ?: NAME_ALIASES[word]?.let(::codeName)
                ?: if (token.length in 2..3 && token == token.uppercase(java.util.Locale.ROOT) && token !in CODEC_WORDS) codeName(word) else null
            if (lang != null) found += lang else if (word !in TRACK_WORDS) return null
        }
        return found.singleOrNull()
    }

    /** A label that names a real language (Telugu, tel-IN, pt-BR); false for raw text such as 'Telugu 5.1'. */
    private fun resolved(label: String?): Boolean =
        label != null && (languageCode(label) != null || label.lowercase(java.util.Locale.ROOT).replace('_', '-') in KEEP_REGION)

    /**
     * Final-review I1 (2026-11-21): providers copy an und rendition's NAME into the
     * tag ('Telugu 5.1'). A tag that is a real language wins; else the tag read as a
     * label; else the label. Null when none names one.
     */
    private fun tagOrNameLanguage(language: String?, label: String?): String? {
        val tag = languageLabel(language)?.takeIf(::isKnownAudioLanguage)
        if (resolved(tag)) return tag
        return tag?.let(::trackNameLanguage) ?: trackNameLanguage(label)
    }

    /** Language of one player track: tag, then tag and label read as labels (I1), then the raw tag, then the label. */
    fun trackLanguage(language: String?, label: String?): String? =
        tagOrNameLanguage(language, label)
            ?: languageLabel(language)?.takeIf(::isKnownAudioLanguage) ?: languageFromTrackName(label)

    /**
     * Preference matching only: a track is in [want] when its tag OR the language
     * read from its label is [want]. Display keeps tag-wins (trackLanguage).
     */
    fun trackMatches(language: String?, label: String?, want: String?): Boolean =
        sameLanguage(languageLabel(language)?.takeIf(::isKnownAudioLanguage), want) || sameLanguage(languageFromTrackName(label), want) ||
            sameLanguage(tagOrNameLanguage(language, label), want)

    // A languages[] entry such as 'Telugu 5.1' (I1) resolves through its text.
    private fun languageLabels(values: List<String>): List<String> =
        values.mapNotNull { v -> languageLabel(v)?.let { l -> if (resolved(l)) l else trackNameLanguage(l) ?: l } }
            .distinctBy { it.lowercase() }

    /** Decided by `container`, not the url: every url is proxy-wrapped. */
    fun isHls(s: RawStream): Boolean {
        val c = s.container?.lowercase().orEmpty()
        if (c.isNotEmpty()) return c == "hls"
        val u = s.url.orEmpty()
        return HLS_URL.containsMatchIn(u) || HLS_PROXY.containsMatchIn(u)
    }

    fun toSource(s: RawStream, i: Int, codecs: CodecSupport): Source? {
        val url = s.url
        if (url.isNullOrEmpty()) return null
        val provider = s.provider ?: s.name ?: "Unknown"
        // Tag first (language, then languageCode). A tag that is not a real language
        // ('Telugu 5.1', a name copied in by the provider, I1) is read as a label, then
        // the name is; only then does the raw tag stand, as before. A name-only value
        // counts only when it is a real ISO language, so 'Commentary' never becomes one.
        val trackLanguages = s.audio?.mapNotNull { t ->
            (tagOrNameLanguage(t.language, t.name) ?: tagOrNameLanguage(t.languageCode, null)
                ?: trackLanguage(t.language, null) ?: trackLanguage(t.languageCode, null)
                ?: languageFromTrackName(t.name)?.takeIf { languageCode(it) != null })?.let { it to t }
        }
        val audioLanguages = trackLanguages?.map { it.first }?.distinctBy { it.lowercase() }
        // The first rendition of each language decides, as on web (renditions.find).
        val uriLanguages = trackLanguages.orEmpty().distinctBy { canonLang(it.first) ?: it.first.lowercase() }
            .filter { !it.second.uri.isNullOrBlank() }.map { it.first }
        val languages = when {
            !audioLanguages.isNullOrEmpty() -> audioLanguages
            s.selectableAudio && audioLanguages != null -> emptyList()
            else -> languageLabels(s.languages)
        }
        return Source(
            // Supplemental replies have different indexes than aggregate replies.
            // URL+quality identity keeps catalogs distinct and contains no ':' menu delimiter.
            id = if (provider.equals("netmirror", true)) "netmirror-" + java.net.URLEncoder.encode(
                kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.JsonPrimitive(url),
                    kotlinx.serialization.json.JsonPrimitive(s.quality ?: "Auto"))).toString(), "UTF-8")
                else "${s.provider ?: "src"}-$i",
            provider = provider,
            label = s.title ?: s.provider ?: "Stream",
            url = url,
            progressive = !isHls(s),
            quality = s.quality ?: "Auto",
            levels = s.levels,
            languages = languages,
            selectableAudio = s.selectableAudio && s.audio?.isNotEmpty() != false,
            hybrid = s.hybrid,
            subtitles = s.subtitles.filter { it.url.isNotEmpty() },
            videoCodec = s.videoCodec,
            codecString = s.codecs,
            unsupported = codecs.supports(s.videoCodec, s.codecs) == false,
            audioLanguages = audioLanguages,
            catalogLanguages = languageLabels(s.catalogLanguages),
            netmirrorCatalog = s.netmirrorCatalog,
            uriLanguages = uriLanguages,
            directUrl = s.directUrl?.takeIf { it.isNotBlank() && s.route?.apk == "direct" },
            directHeaders = if (s.route?.apk == "direct") s.directHeaders.mapNotNull { (k, v) ->
                (v as? kotlinx.serialization.json.JsonPrimitive)?.content?.let { k to it }
            }.toMap() else emptyMap(),
        )
    }

    /** Pixel height of a source's best level. 0 when unknown. */
    fun height(s: Source): Int {
        val fromLevels = s.levels.maxOfOrNull { it.height } ?: 0
        if (fromLevels > 0) return fromLevels
        return HEIGHT.find(s.quality)?.groupValues?.get(1)?.toInt() ?: 0
    }

    fun tier(s: Source, preferred: String): Int {
        val playable = if (s.selectableAudio) s.audioLanguages ?: s.languages else s.languages
        val pref = playable.any { sameLanguage(it, preferred) }
        return when {
            s.hybrid -> 0
            pref && s.selectableAudio -> 1
            pref -> 2
            s.selectableAudio -> 3
            else -> 4
        }
    }

    fun rank(sources: List<Source>, preferred: String): List<Source> =
        sources.sortedWith(
            compareBy<Source> { if (it.unsupported) 1 else 0 }
                .thenBy { tier(it, preferred) }
                // Same tier: on-device vaplayer goes after mapple and the backend
                // rows (its token is bound to an IP that can change under CGNAT).
                .thenBy { if (it.onDevice == VAPLAYER) 1 else 0 }
                .thenBy { if (it.progressive) 1 else 0 },
            // Within a tier the server's order stands (web backend.js rankSources):
            // the server ranks by learned playback outcomes and already weights
            // quality, so a height re-sort here would throw that away. Stable sort.
        )

    /**
     * Server menu order (web trackChoices.videoChoices): best picture first,
     * progressive after HLS, rows this device cannot decode at the bottom.
     * Label it with [labels] so numbering runs once across the whole menu.
     */
    fun menuOrder(sources: List<Source>): List<Source> =
        sources.sortedWith(
            compareBy<Source> { if (it.unsupported) 1 else 0 }
                .thenBy { if (it.progressive) 1 else 0 }
                .thenByDescending { height(it) },
        )

    /**
     * Honour the remembered provider by ORDER, never over the viewer's language
     * (A8): rows in the preferred language (tier 0-2) stay ahead of the rest.
     * Inside each part the best selectable-audio row stays first, then the
     * pinned provider's rows, then the others; unsupported last.
     * `manual`: the viewer picked that provider by hand, so it leads outright.
     */
    fun applyPin(sources: List<Source>, provider: String?, preferred: String = "Telugu", manual: Boolean = false): List<Source> {
        if (provider.isNullOrEmpty()) return sources
        val wanted = { s: Source -> s.provider.equals(provider, ignoreCase = true) }
        val ok = sources.filter { !it.unsupported }
        val last = sources.filter { it.unsupported }
        if (manual) return ok.filter(wanted) + ok.filterNot(wanted) + last
        fun part(rows: List<Source>): List<Source> {
            val best = rows.firstOrNull { it.selectableAudio }
            return listOfNotNull(best) + rows.filter { wanted(it) && it !== best } + rows.filter { !wanted(it) && it !== best }
        }
        val (inLang, other) = ok.partition { tier(it, preferred) <= 2 }
        return part(inLang) + part(other) + last
    }

    fun fromResponse(r: StreamsResponse, preferred: String, codecs: CodecSupport, pin: String? = null, extra: List<Source> = emptyList(), manual: Boolean = false): List<Source> =
        merge(r.streams.mapIndexedNotNull { i, s -> toSource(s, i, codecs) }, extra, preferred, pin, manual)

    /** Backend rows plus on-device rows, ranked together. A row id appears once. */
    fun merge(sources: List<Source>, extra: List<Source>, preferred: String, pin: String? = null, manual: Boolean = false): List<Source> {
        val ids = extra.map { it.id }.toSet()
        return applyPin(rank(sources.filter { it.id !in ids } + extra, preferred), pin, preferred, manual)
    }

    /**
     * A9: rows of the ?full=1 answer join the list on screen. A row already
     * shown (same provider and url) stays as it is, so a source that started
     * keeps its id; new rows get ids that cannot collide; then one re-rank.
     */
    fun mergeMore(sources: List<Source>, more: StreamsResponse, preferred: String, codecs: CodecSupport, pin: String? = null, manual: Boolean = false): List<Source> {
        val seen = sources.map { it.provider.lowercase() to it.url }.toHashSet()
        val ids = sources.map { it.id }.toHashSet()
        val fresh = more.streams.mapIndexedNotNull { i, s -> toSource(s, i, codecs) }
            .filter { seen.add(it.provider.lowercase() to it.url) }
            .map { s -> var id = "${s.id}-full"; var n = 2; while (id in ids) id = "${s.id}-full${n++}"; ids += id; s.copy(id = id) }
        if (fresh.isEmpty()) return sources
        return merge(sources, fresh, preferred, pin, manual)
    }

    const val VAPLAYER = "VaPlayer"

    /** Server menu labels: "CastleTV 1", "CastleTV 2" when a name repeats. */
    fun labels(sources: List<Source>): List<String> {
        val total = sources.groupingBy { it.provider }.eachCount()
        val shown = HashMap<String, Int>()
        return sources.map { s ->
            if ((total[s.provider] ?: 0) < 2) s.provider
            else {
                val n = (shown[s.provider] ?: 0) + 1
                shown[s.provider] = n
                "${s.provider} $n"
            }
        }
    }

    /**
     * Audio choices from OTHER sources (trackChoices.audioChoices "whole-source").
     * Each language appears once; a non-switchable source offers its first language.
     * In-file tracks are added by the player, ahead of these.
     */
    fun otherSourceLanguages(sources: List<Source>, currentId: String?, exclude: Set<String>): List<Pair<String, Source>> {
        val seen = exclude.mapNotNull(::languageLabel).map { it.lowercase() }.toMutableSet()
        val out = ArrayList<Pair<String, Source>>()
        for (s in sources) {
            if (s.id == currentId || s.unsupported) continue
            val offered = if (s.selectableAudio) s.audioLanguages ?: s.languages else s.languages.take(1)
            for (raw in offered) {
                val lang = languageLabel(raw) ?: continue
                if (!seen.add(lang.lowercase())) continue
                out += lang to s
            }
        }
        return out
    }
}
