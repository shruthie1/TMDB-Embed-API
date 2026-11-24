package com.chitram.app.resolve

import com.chitram.app.data.SubtitleRef
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Vidrift "Orion" (embed.vidrift.net, mirror embed.vidrift.in), resolved on the
 * device (port of providers/vidrift.js). VM down or failed only, like MultiMovies.
 *
 * One page GET (/embed/movie/<tmdb>) carries `var embedMeta = {...}`, whose
 * orionStreams[] lists one HLS master per language ("Orion · Telugu"). Each
 * master is fetched with the host's own Referer + Origin (403 without them);
 * the row carries those headers, so the APK plays it direct.
 *
 * Language (server twin, exactly): a rendition's own LANGUAGE wins. The page
 * label applies only when the master has exactly ONE untagged AUDIO rendition
 * (or none, audio muxed). "Original" names no language, never the TMDB one
 * ([pageLanguage]). Of two entries that say Telugu only the last keeps it
 * ([teluguClaimWinner]). A label ending in sub/subs/subbed/subtitles is never
 * an audio language.
 *
 * Hosts: tried in order, a dead page moves to the next. The host that last
 * answered goes first while fresh ([HEAL_TTL_MS]), the twin of the server's
 * healed-host-in-front list; the configured first host clears it.
 */
class VidriftResolver(
    client: OkHttpClient,
    private val bases: List<String> = BASES,
    private val pageStepMs: Long = PAGE_STEP_MS,
    private val masterStepMs: Long = MASTER_STEP_MS,
) {
    internal val http = client.newBuilder()
        .connectTimeout(com.chitram.app.data.Api.DEVICE_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(BUDGET_MS, TimeUnit.MILLISECONDS).build()

    /**
     * A hard cap on one call, body read included (the server's AbortSignal):
     * withTimeoutOrNull alone waits for a blocking body read to finish.
     * Shares the connection pool.
     */
    private fun capped(ms: Long) = http.newBuilder().callTimeout(ms.coerceAtLeast(1), TimeUnit.MILLISECONDS).build()

    /**
     * One row per Orion master. Empty for a page that lists none, or a tv
     * request without season/episode (never guess S1E1). Throws when every host
     * failed the page, or every master failed: the caller's breaker counts it.
     * `originalLang` is accepted for the caller and not used ([pageLanguage]).
     */
    @Suppress("UNUSED_PARAMETER")
    suspend fun resolveAll(type: String, tmdbId: Long, season: Int, episode: Int, originalLang: String? = null, budgetMs: Long = BUDGET_MS): List<Resolved> = coroutineScope {
        val t0 = System.currentTimeMillis()
        val tv = type == "tv" || type == "series"
        if (tv && (season <= 0 || episode <= 0)) {
            android.util.Log.i("Chitram", "[vidrift] tv $tmdbId without season/episode - no rows")
            return@coroutineScope emptyList()
        }
        fun left() = budgetMs - (System.currentTimeMillis() - t0)
        val configured = bases.map { it.trimEnd('/') }
        val order = (listOfNotNull(healed()) + configured).distinct()

        // Page: first host whose page carries embedMeta with an orionStreams array.
        val errors = mutableListOf<String>()
        var page: Pair<String, JsonArray>? = null
        var lastCode = 0
        // A host said orionStreams null: the title has no rows there yet (server twin titleEmpty).
        var titleEmpty = false
        for (base in order) {
            val step = minOf(pageStepMs, left())
            if (step <= 0) { errors += "$base: budget spent"; break }
            val p0 = System.currentTimeMillis()
            val msg = try {
                val r = withTimeoutOrNull(step) {
                    capped(step).fetch(Request.Builder().url(embedUrl(base, tmdbId, tv, season, episode))
                        .header("User-Agent", UA).header("Referer", PAGE_REFERER).build())
                }
                when {
                    r == null -> "no answer in ${System.currentTimeMillis() - p0}ms"
                    !r.ok -> { lastCode = r.code; "HTTP ${r.code}" }
                    else -> {
                        val meta = parseEmbedMeta(r.body)
                        val streams = meta?.get("orionStreams")
                        when {
                            meta == null -> "no embedMeta in page"
                            streams is kotlinx.serialization.json.JsonNull -> { titleEmpty = true; "orionStreams null" }
                            streams !is JsonArray -> "orionStreams missing"
                            else -> { page = base to streams; null }
                        }
                    }
                }
            } catch (x: Exception) {
                if (x is kotlinx.coroutines.CancellationException) throw x
                if (x is java.io.InterruptedIOException) "no answer in ${System.currentTimeMillis() - p0}ms" else x.message ?: x.javaClass.simpleName
            }
            if (msg == null) {
                android.util.Log.i("Chitram", "[vidrift] page $base ${System.currentTimeMillis() - p0}ms")
                remember(base, configured)
                break
            }
            errors += "$base: $msg"
            android.util.Log.i("Chitram", "[vidrift] host $base failed for $tmdbId (${System.currentTimeMillis() - p0}ms): $msg")
        }
        if (page == null && titleEmpty) throw VidriftTitleEmpty("every host failed for $tmdbId: ${errors.joinToString("; ")}")
        val (pageBase, streams) = page ?: throw StepException("vidrift page", lastCode, "every host failed for $tmdbId: ${errors.joinToString("; ")}")
        val hosts = listOf(pageBase) + order.filter { it != pageBase }

        val entries = streams.mapNotNull { it as? JsonObject }.mapNotNull { o ->
            val path = str(o, "url")?.takeIf { it.isNotEmpty() } ?: str(o, "proxyUrl")?.takeIf { it.isNotEmpty() }
            path?.takeIf { (str(o, "type") ?: "hls").ifEmpty { "hls" } == "hls" }?.let { Entry(str(o, "name").orEmpty(), it) }
        }
        if (entries.isEmpty()) {
            android.util.Log.i("Chitram", "[vidrift] page lists no orion streams for $tmdbId")
            return@coroutineScope emptyList()
        }

        // Two entries that say Telugu: only the last keeps it (server teluguClaimWinner).
        val winner = teluguClaimWinner(entries.map { it.name })

        // Masters in parallel: the page host first, then the mirrors, inside the budget.
        val jobs = entries.mapIndexed { i, e ->
            val dropLabel = winner != null && i != winner && pageLanguage(e.name).first == "Telugu"
            if (dropLabel) android.util.Log.i("Chitram", "[vidrift] telugu-claim dropped for $tmdbId: entry $i \"${e.name}\" listed Telugu, kept entry $winner (listed later)")
            async {
                val errs = mutableListOf<String>()
                for (base in hosts) {
                    val cap = minOf(masterStepMs, left())
                    if (cap <= 0) { errs += "${hostOf(base)} budget spent"; break }
                    val url = resolveAgainst("$base/", e.path) ?: continue
                    val m0 = System.currentTimeMillis()
                    val got = try {
                        withTimeoutOrNull(cap) {
                            val r = capped(cap).fetch(Request.Builder().url(url).apply { streamHeaders(base).forEach { (k, v) -> header(k, v) } }.build())
                            if (!r.ok) "HTTP ${r.code}" else rowFor(e, r.body, url, base, dropLabel) ?: "no variants"
                        } ?: "no answer in ${System.currentTimeMillis() - m0}ms"
                    } catch (x: Exception) {
                        if (x is kotlinx.coroutines.CancellationException) throw x
                        if (x is java.io.InterruptedIOException) "no answer in ${System.currentTimeMillis() - m0}ms" else x.message ?: x.javaClass.simpleName
                    }
                    if (got is Resolved) return@async got
                    errs += "${hostOf(base)} $got"
                }
                "\"${e.name}\" ${errs.joinToString(", ")}"
            }
        }
        val results = jobs.map { it.await() }
        val seen = HashSet<String>()
        val rows = results.filterIsInstance<Resolved>().filter { seen.add(it.url) }
        val failed = results.filterIsInstance<String>()
        if (rows.isEmpty()) throw StepException("vidrift master", 0, "every master failed for $tmdbId: ${failed.joinToString("; ")}")
        if (failed.isNotEmpty()) android.util.Log.i("Chitram", "[vidrift] ${failed.size} master(s) dropped for $tmdbId: ${failed.joinToString("; ")}")
        android.util.Log.i("Chitram", "[vidrift] ${rows.size} row(s) for $tmdbId in ${System.currentTimeMillis() - t0}ms: " +
            rows.joinToString { (Hls.languages(it.audio) + it.languages).distinct().joinToString("/").ifEmpty { "unlabelled" } })
        // 1.2.67: a dropped master makes the answer partial (server twin vidrift.js:404): kept 5 min, not 30.
        if (failed.isNotEmpty()) rows.map { it.copy(incomplete = true) } else rows
    }

    internal class Entry(val name: String, val path: String)

    companion object {
        /** Server BASES, same order. */
        val BASES = listOf("https://embed.vidrift.net", "https://embed.vidrift.in")
        /** The scraper sent MultiMovies' site as Referer on the embed page. */
        const val PAGE_REFERER = "https://m1.multimovies.courses/"
        const val UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
        /** Server budgetMs / pageTimeoutMs / masterTimeoutMs. */
        const val BUDGET_MS = 15_000L
        const val PAGE_STEP_MS = 5_000L
        const val MASTER_STEP_MS = 5_000L
        const val HEAL_TTL_MS = 7 * 24 * 3600 * 1000L

        @Volatile private var healedHost: Pair<String, Long>? = null
        internal fun healed(): String? = healedHost?.takeIf { System.currentTimeMillis() - it.second < HEAL_TTL_MS }?.first
        internal fun remember(base: String, configured: List<String>) {
            healedHost = if (base == configured.firstOrNull()) null else base to System.currentTimeMillis()
        }
        /** Tests only. */
        internal fun resetHeal() { healedHost = null }

        fun streamHeaders(base: String) = mapOf("User-Agent" to UA, "Referer" to "$base/", "Origin" to base)

        internal fun embedUrl(base: String, tmdbId: Long, tv: Boolean, season: Int, episode: Int) =
            if (tv) "$base/embed/tv/$tmdbId/$season/$episode" else "$base/embed/movie/$tmdbId"

        private fun hostOf(base: String) = base.substringAfter("://").substringBefore('/')
        private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        /** `var embedMeta = {...};` -> object, or null when the page has none (server parseEmbedMeta). */
        internal fun parseEmbedMeta(html: String?): JsonObject? {
            val s = html ?: return null
            val at = Regex("""embedMeta\s*=\s*\{""").find(s)?.range?.first ?: return null
            val start = s.indexOf('{', at)
            var depth = 0; var inStr = false; var esc = false
            for (i in start until s.length) {
                val c = s[i]
                if (inStr) {
                    if (esc) esc = false else if (c == '\\') esc = true else if (c == '"') inStr = false
                    continue
                }
                when (c) {
                    '"' -> inStr = true
                    '{' -> depth++
                    '}' -> if (--depth == 0) return try { Json.parseToJsonElement(s.substring(start, i + 1)) as? JsonObject } catch (_: Exception) { null }
                }
            }
            return null
        }

        /** Server LABEL_LANG. */
        private val LABEL_LANG = mapOf(
            "te" to "Telugu", "tel" to "Telugu", "telugu" to "Telugu",
            "hi" to "Hindi", "hin" to "Hindi", "hindi" to "Hindi",
            "ta" to "Tamil", "tam" to "Tamil", "tamil" to "Tamil",
            "ml" to "Malayalam", "mal" to "Malayalam", "malayalam" to "Malayalam",
            "kn" to "Kannada", "kan" to "Kannada", "kannada" to "Kannada",
            "bn" to "Bengali", "ben" to "Bengali", "bangla" to "Bengali", "bengali" to "Bengali",
            "mr" to "Marathi", "mar" to "Marathi", "marathi" to "Marathi",
            "en" to "English", "eng" to "English", "english" to "English",
        )
        private val NO_LANGUAGE = Regex("^(und|unk|mul|zxx|original)$", RegexOption.IGNORE_CASE)
        private val SUBBED = Regex("""\bsub(s|bed|titles?)?$""", RegexOption.IGNORE_CASE)

        /**
         * Server langName: a label or code as a language name, or null. Unknown
         * labels pass through as written so no tag is lost. "<lang> sub/subs/
         * subbed/subtitles" is the original audio with subtitles: null.
         */
        internal fun langName(raw: String?): String? {
            val k = raw?.trim().orEmpty()
            if (k.isEmpty() || NO_LANGUAGE.matches(k) || SUBBED.containsMatchIn(k)) return null
            return LABEL_LANG[k.lowercase()] ?: k
        }

        /**
         * Server pageLanguage: "Orion · Telugu" -> (Telugu, Telugu). "Orion · Original"
         * -> (null, "Original"), always: "Original" is not the TMDB language.
         * 1261763 (TMDB te): Original is the Tamil track (2026-11-21). Live
         * 2026-11-22: RRR (TMDB te) listed only Original, labelled Telugu, and its
         * audio is byte-identical to MultiMovies' "English" RRR source (speech ID
         * ta/hi, the phone played lang=und); Jailer (TMDB ta) Original is
         * byte-identical to a MovieBox Malayalam source (ml 1.00).
         */
        internal fun pageLanguage(name: String?): Pair<String?, String?> {
            val label = (name ?: "").replace(Regex("""^.*·\s*"""), "").replace(Regex("""\s*\(.*\)\s*$"""), "").trim()
            if (label.isEmpty()) return null to null
            if (label.equals("original", true)) return null to "Original"
            val lang = langName(label)
            return lang to lang
        }

        /**
         * Server teluguClaimWinner: index of the last entry that says Telugu when
         * two or more do, else null. Telugu only: a wrong Telugu row plays first.
         */
        internal fun teluguClaimWinner(names: List<String?>): Int? {
            val idx = names.indices.filter { pageLanguage(names[it]).first == "Telugu" }
            return if (idx.size >= 2) idx.last() else null
        }

        /**
         * Server streamFromMaster precedence: each rendition's own LANGUAGE wins;
         * only a lone untagged rendition takes the page language. Nothing is dropped.
         */
        internal fun withPageLanguage(audio: List<AudioTrack>, pageLang: String?): List<AudioTrack> {
            if (pageLang == null || audio.size != 1) return audio
            val a = audio.single()
            return if (langName(a.language) == null) listOf(a.copy(language = pageLang)) else audio
        }

        private val ORION_ID = Regex("""/orion/([0-9a-f]{16,})/""", RegexOption.IGNORE_CASE)
        private val HLS_PLAYLIST = Regex("""\.m3u8?(?=$|[?#&\s])""", RegexOption.IGNORE_CASE)

        /** Stable row id: the orion id (same on both hosts), else the multimovies master hash. */
        internal fun rowKey(url: String) = "vidrift-" + (ORION_ID.find(url)?.groupValues?.get(1)?.lowercase() ?: MultiMoviesResolver.masterKey(url))

        /**
         * The row for one fetched master, or null when it has no variants.
         * [dropLabel]: this entry's Telugu lost to a later entry's; the page
         * label is not stamped (a master LANGUAGE tag still stands).
         */
        internal fun rowFor(e: Entry, text: String, url: String, base: String, dropLabel: Boolean = false): Resolved? {
            val m = Hls.parse(text, url)
            if (m.levels.isEmpty()) return null
            val pageLang = if (dropLabel) null else pageLanguage(e.name).first
            val audio = withPageLanguage(m.audio, pageLang)
            if (m.audio.size == 1 && pageLang != null) {
                val stated = langName(m.audio[0].language)
                if (stated != null && stated != pageLang) android.util.Log.i("Chitram", "[vidrift] page says $pageLang, master says $stated for ${e.name} - master wins")
            }
            // Audio muxed (no rendition): the page language names the stream.
            val languages = if (m.audio.isEmpty()) listOfNotNull(pageLang) else emptyList()
            val subtitles = text.lines().map { it.trim() }.filter { it.startsWith("#EXT-X-MEDIA:") }.map { Hls.attrs(it) }
                .filter { it["TYPE"] == "SUBTITLES" }.mapNotNull { a -> a["URI"]?.let { Hls.resolve(it, url) to a } }
                .filterNot { (u, _) -> HLS_PLAYLIST.containsMatchIn(u + " " + runCatching { java.net.URLDecoder.decode(u, "UTF-8") }.getOrDefault("")) }
                .mapIndexed { i, (u, a) -> SubtitleRef(u, a["LANGUAGE"] ?: a["NAME"] ?: "Subtitle ${i + 1}", "vr-sub-$i") }
            return Resolved(
                provider = "vidrift",
                label = "Vidrift",
                url = url,
                headers = streamHeaders(base),
                segmentToken = null,
                audio = audio,
                levels = m.levels.sortedByDescending { it.height },
                codecs = m.codecs,
                key = rowKey(url),
                subtitles = subtitles,
                languages = languages,
            )
        }
    }
}

/**
 * Every host failed and at least one said orionStreams null: the title has no Orion rows
 * yet (null was seen to be transient on Krack, so it is not cached as "none" either).
 * Not the provider's failure, so the breaker never counts it (server twin: err.titleEmpty).
 */
class VidriftTitleEmpty(detail: String) : StepException("vidrift page", 0, detail), SelfImposedSkip
