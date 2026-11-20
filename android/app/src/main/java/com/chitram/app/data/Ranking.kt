package com.chitram.app.data

/**
 * Kotlin port of web/lib/backend.js (toSource, sourceHeight, rankSources and the
 * remembered-provider reorder in resolveLive) and web/lib/player/trackChoices.js.
 *
 * Telugu-first: the scarce resource is LANGUAGE, not pixels, so resolution only
 * breaks ties inside a tier. A row the device cannot decode ranks last.
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
)

/** Answers "can this device decode this video codec family?" null = unknown. */
fun interface CodecSupport {
    fun supports(videoCodec: String?, codecString: String?): Boolean?
}

object Ranking {
    private val HLS_URL = Regex("""\.m3u8(\?|$)""", RegexOption.IGNORE_CASE)
    private val HLS_PROXY = Regex("""m3u8-proxy|[?&]url=[^&]*m3u8""", RegexOption.IGNORE_CASE)
    private val HEIGHT = Regex("""(\d{3,4})p""")

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
        return Source(
            id = "${s.provider ?: "src"}-$i",
            provider = provider,
            label = s.title ?: s.provider ?: "Stream",
            url = url,
            progressive = !isHls(s),
            quality = s.quality ?: "Auto",
            levels = s.levels,
            languages = s.languages,
            selectableAudio = s.selectableAudio,
            hybrid = s.hybrid,
            subtitles = s.subtitles.filter { it.url.isNotEmpty() },
            videoCodec = s.videoCodec,
            codecString = s.codecs,
            unsupported = codecs.supports(s.videoCodec, s.codecs) == false,
        )
    }

    /** Pixel height of a source's best level. 0 when unknown. */
    fun height(s: Source): Int {
        val fromLevels = s.levels.maxOfOrNull { it.height } ?: 0
        if (fromLevels > 0) return fromLevels
        return HEIGHT.find(s.quality)?.groupValues?.get(1)?.toInt() ?: 0
    }

    fun tier(s: Source, preferred: String): Int {
        val pref = s.languages.any { it.equals(preferred, ignoreCase = true) }
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
                .thenBy { if (it.progressive) 1 else 0 }
                .thenByDescending { height(it) },
        )

    /**
     * Honour the remembered provider by ORDER: the best selectable-audio row stays
     * first, then the pinned provider's rows, then the rest, unsupported last.
     */
    fun applyPin(sources: List<Source>, provider: String?): List<Source> {
        if (provider.isNullOrEmpty()) return sources
        val best = sources.firstOrNull { it.selectableAudio && !it.unsupported }
        val wanted = { s: Source -> s.provider.equals(provider, ignoreCase = true) }
        val pinned = sources.filter { wanted(it) && it !== best && !it.unsupported }
        val rest = sources.filter { !wanted(it) && it !== best && !it.unsupported }
        val last = sources.filter { it.unsupported }
        return listOfNotNull(best) + pinned + rest + last
    }

    fun fromResponse(r: StreamsResponse, preferred: String, codecs: CodecSupport, pin: String? = null): List<Source> =
        applyPin(rank(r.streams.mapIndexedNotNull { i, s -> toSource(s, i, codecs) }, preferred), pin)

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
        val seen = exclude.map { it.lowercase() }.toMutableSet()
        val out = ArrayList<Pair<String, Source>>()
        for (s in sources) {
            if (s.id == currentId || s.unsupported) continue
            val offered = if (s.selectableAudio) s.languages else s.languages.take(1)
            for (lang in offered) {
                if (lang.isBlank() || !seen.add(lang.lowercase())) continue
                out += lang to s
            }
        }
        return out
    }
}
