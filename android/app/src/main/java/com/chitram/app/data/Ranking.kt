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
    /** The provider returned usable rows while more catalogs/dubs remain unresolved. */
    val incomplete: Boolean = false,
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
    private val LANGUAGE_CODE = Regex("^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$")

    /** Provider codes and display labels share one language identity in menus. */
    fun languageLabel(value: String?): String? {
        val raw = value?.trim()?.takeIf(String::isNotEmpty) ?: return null
        val code = raw.lowercase(java.util.Locale.ROOT).replace('_', '-')
        val language = code.substringBefore('-')
        if (language in setOf("und", "mul", "zxx", "unknown")) return null
        if (!LANGUAGE_CODE.matches(code)) return raw
        val iso2 = iso3ToIso2[language] ?: language
        val display = java.util.Locale(iso2).getDisplayLanguage(java.util.Locale.ENGLISH)
        return display.takeUnless { it.isBlank() || it.equals(iso2, true) || it.equals(language, true) } ?: raw
    }

    private fun languageLabels(values: List<String>): List<String> =
        values.mapNotNull(::languageLabel).distinctBy { it.lowercase() }

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
        val audioLanguages = s.audio?.mapNotNull { languageLabel(it.language) }
            ?.distinctBy { it.lowercase() }
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
        val want = languageLabel(preferred)
        val pref = want != null && playable.any { languageLabel(it)?.equals(want, ignoreCase = true) == true }
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
