package com.chitram.app.resolve

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * MultiMovies (VidBolt), resolved on the device (port of providers/multimovies.js).
 * Used when the VM is down or its multimovies row failed: one JSON call gives the
 * HLS master, whose EXT-X-MEDIA renditions carry the languages.
 *
 * Not ported: the server's dead-audio-rendition probe and its "segments disguised
 * as images" probe. A row that cannot play fails in the player and the start
 * moves on; no language tag is dropped.
 */
class MultiMoviesResolver(
    client: OkHttpClient,
    private val origin: String = ORIGIN,
    /** Per-master cap (server MASTER_TIMEOUT_MS): a slow master drops only its own row. */
    private val masterTimeoutMs: Long = MASTER_TIMEOUT_MS,
) {
    /**
     * 8 s connect (review I1): covers the measured 7.6 s connect to a live
     * Cloudflare host. The resolver has no proxy fallback, so no 3 s here.
     */
    internal val http = client.newBuilder()
        .connectTimeout(com.chitram.app.data.Api.DEVICE_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()

    /** The first row of [resolveAll], or null when there is none. Throws when the API call failed. */
    suspend fun resolve(type: String, tmdbId: Long, season: Int, episode: Int): Resolved? =
        resolveAll(type, tmdbId, season, episode).firstOrNull()

    /**
     * One row per VidBolt HLS master from EVERY VidBolt server (server twin:
     * providers/multimovies.js). The plain /api/resolve returns whichever server
     * VidBolt picks (RRR: `luna`, one unlabelled 720p row, while `callisto` had
     * the two Telugu masters, 2026-11-21), so each server is also asked with
     * `only=<id>` in parallel. Server ids come from the embed page's "servers"
     * JSON (cached [SERVER_LIST_TTL_MS]), [FALLBACK_SERVERS] until it is read.
     * Each call is capped at [RESOLVE_STEP_MS]; the ask phase ends when all have
     * answered, or once the plain resolve has answered and [SETTLE_MS] has
     * passed. Masters start as each answer lands, each capped at
     * [masterTimeoutMs] and by what is left of [budgetMs]; a dead or slow one
     * drops only its row. Rows keep ask order (plain first, then servers),
     * one per master ([masterKey]). Each source's own `language` labels a lone
     * generic rendition. `originalLang`: the title's TMDB original language,
     * for an "Original" source. Throws when no ask got a 2xx answer.
     */
    suspend fun resolveAll(type: String, tmdbId: Long, season: Int, episode: Int, originalLang: String? = null, budgetMs: Long = Long.MAX_VALUE): List<Resolved> = coroutineScope {
        val t0 = System.currentTimeMillis()
        val tv = type == "tv" || type == "series"
        val s = season.coerceAtLeast(1)
        val e = episode.coerceAtLeast(1)
        val path = if (tv) "tv/$tmdbId/$s/$e" else "movie/$tmdbId"
        val api = if (tv) "$origin/api/resolve?type=tv&id=$tmdbId&season=$s&episode=$e" else "$origin/api/resolve?type=movie&id=$tmdbId"
        val referer = "$origin/$path"
        fun left() = if (budgetMs == Long.MAX_VALUE) Long.MAX_VALUE else budgetMs - (System.currentTimeMillis() - t0) - BUDGET_MARGIN_MS
        val headers = streamHeaders(origin)

        val throttled = System.currentTimeMillis() < throttledUntil
        val listed = if (throttled) emptyList() else knownServers()
        val servers = (listed ?: FALLBACK_SERVERS).toMutableList()
        // Servers asked this call; cooled ones are skipped (server twin: per-server cooldown).
        val asked = mutableListOf<String>()
        val cooled = mutableListOf<String>()
        if (throttled) android.util.Log.i("Chitram", "[multimovies] vidbolt throttled (429): plain resolve only for $tmdbId")

        val events = Channel<Any>(Channel.UNLIMITED)
        val askJobs = mutableListOf<kotlinx.coroutines.Job>()
        val answers = HashMap<String, Answer>()
        val masters = LinkedHashMap<String, kotlinx.coroutines.Deferred<Resolved?>>()
        var pending = 0

        fun ask(label: String, server: String?) {
            pending++
            askJobs += launch {
                val url = if (server == null) api else "$api&only=${java.net.URLEncoder.encode(server, "UTF-8")}"
                val step = minOf(RESOLVE_STEP_MS, left())
                val a = if (step <= 0) Answer(label, timedOut = true) else try {
                    withTimeoutOrNull(step) {
                        val r = http.fetch(Request.Builder().url(url).header("User-Agent", UA).header("Referer", referer).build())
                        if (!r.ok) return@withTimeoutOrNull Answer(label, code = r.code)
                        val body = MappleResolver.obj(r.body) ?: return@withTimeoutOrNull Answer(label, code = r.code, error = "not JSON")
                        val stream = body["stream"] as? JsonObject
                        val sources = (stream?.get("sources") as? JsonArray).orEmpty()
                            .mapNotNull { it as? JsonObject }
                            .filter { str(it, "kind") == "hls" }
                            .mapNotNull { o -> str(o, "url")?.let { it to str(o, "language") } }
                        Answer(label, ok = true, code = r.code, server = stream?.let { str(it, "server") }, sources = sources)
                    } ?: Answer(label, timedOut = true)
                } catch (x: Exception) {
                    if (x is kotlinx.coroutines.CancellationException) throw x
                    Answer(label, error = x.message ?: x.javaClass.simpleName)
                }
                events.trySend(a)
            }
        }

        // Every source VidBolt listed this call (raw language), complete once the ask phase ends.
        val listedLanguages = kotlinx.coroutines.CompletableDeferred<List<String?>>()

        fun master(url: String, raw: String?) = async {
            val cap = minOf(masterTimeoutMs, left())
            if (cap <= 0) return@async null
            val m = withTimeoutOrNull(cap) {
                try {
                    val reply = http.fetch(Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
                    if (reply.ok) Hls.parse(reply.body, url) else null
                } catch (x: Exception) {
                    if (x is kotlinx.coroutines.CancellationException) throw x
                    null
                }
            }
            if (m == null || m.levels.isEmpty()) return@async null
            // "Original" names the TMDB language only when no other source names it
            // (server originalLanguageFor); the phase ends before any row is read.
            val lang = if (isOriginal(raw)) {
                val kept = originalLanguageFor(listedLanguages.await(), originalLang)
                if (kept == null && com.chitram.app.data.Ranking.knownLanguageName(originalLang) != null) {
                    android.util.Log.i("Chitram", "[multimovies] \"Original\" not labelled ${com.chitram.app.data.Ranking.knownLanguageName(originalLang)} for $tmdbId: another source names it - stays unlabelled")
                }
                sourceLanguage(raw, kept)
            } else sourceLanguage(raw, originalLang)
            Resolved(
                provider = "multimovies",
                label = "MultiMovies",
                url = url,
                headers = headers,
                segmentToken = null,
                audio = withSourceLanguage(m.audio, lang),
                levels = m.levels.sortedByDescending { it.height },
                codecs = m.codecs,
                // Stable id from the master (review I4): a re-resolve in another order keeps each row's language.
                key = "multimovies-${masterKey(url)}",
            )
        }

        ask(DEFAULT, null)
        fun askServer(id: String) {
            if (cooling(id)) { cooled += id; return }
            asked += id
            ask(id, id)
        }
        servers.toList().forEach { askServer(it) }
        if (listed == null) {
            pending++
            askJobs += launch {
                val ids = try {
                    withTimeoutOrNull(minOf(RESOLVE_STEP_MS, left()).coerceAtLeast(1)) {
                        val r = http.fetch(Request.Builder().url(referer).header("User-Agent", UA).header("Referer", "$origin/").build())
                        if (r.ok) parseServerIds(r.body) else null
                    }
                } catch (x: Exception) {
                    if (x is kotlinx.coroutines.CancellationException) throw x
                    null
                }
                events.trySend(EmbedIds(ids))
            }
        }

        // Ask phase. Only this loop touches servers / answers / masters.
        var why = "all answered"
        while (pending > 0) {
            val elapsed = System.currentTimeMillis() - t0
            val stopAt = if (answers.containsKey(DEFAULT)) minOf(SETTLE_MS, RESOLVE_STEP_MS) else RESOLVE_STEP_MS
            if (elapsed >= stopAt) { why = if (stopAt == RESOLVE_STEP_MS) "step cap" else "settled"; break }
            val ev = withTimeoutOrNull(stopAt - elapsed) { events.receive() } ?: continue
            pending--
            when (ev) {
                is Answer -> {
                    answers[ev.label] = ev
                    if (ev.code == 429) throttledUntil = System.currentTimeMillis() + THROTTLE_COOLDOWN_MS
                    val named = ev.server
                    if (!throttled && ev.ok && named != null && named !in servers) { servers += named; askServer(named) }
                    for ((url, lang) in ev.sources) masterKey(url).let { k -> if (k !in masters) masters[k] = master(url, lang) }
                }
                is EmbedIds -> {
                    val ids = ev.ids
                    if (ids == null) {
                        android.util.Log.i("Chitram", "[multimovies] server list unreadable, using ${servers.joinToString(",")}")
                    } else {
                        serverList = ids to System.currentTimeMillis()
                        ids.filter { it !in servers }.forEach { servers += it; askServer(it) }
                    }
                }
            }
        }
        askJobs.forEach { it.cancel() }
        events.close()
        listedLanguages.complete(answers.values.filter { it.ok }.flatMap { a -> a.sources.map { it.second } })

        // A 429 is VidBolt limiting our whole IP, not this server: the streak is left as is.
        asked.forEach { if (answers[it]?.code == 429) releaseProbe(it) else recordServer(it, answers[it]?.ok == true) }
        val labels = listOf(DEFAULT) + asked
        val summary = labels.joinToString(" ") { l ->
            val a = answers[l]
            when {
                a == null -> "$l=cut"
                a.timedOut -> "$l=timeout"
                !a.ok -> "$l=error(${a.code.takeIf { it > 0 }?.let { "HTTP $it" } ?: a.error})"
                else -> "$l=${a.sources.size}" + if (l == DEFAULT && a.server != null) "(${a.server})" else ""
            }
        }
        android.util.Log.i("Chitram", "[multimovies] servers for $tmdbId after ${System.currentTimeMillis() - t0}ms ($why): $summary" + if (cooled.isEmpty()) "" else " cooled=${cooled.joinToString(",")}")

        if (masters.isEmpty()) {
            val def = answers[DEFAULT]
            // Empty is trusted only when VidBolt said so: the plain resolve (which
            // walks every server) or every listed server answered 2xx.
            if (def?.ok == true || (asked.isNotEmpty() && asked.all { answers[it]?.ok == true })) {
                android.util.Log.i("Chitram", "[multimovies] no hls source for $tmdbId")
                return@coroutineScope emptyList()
            }
            throw StepException("multimovies resolve", def?.code ?: 0, summary)
        }

        val done = masters.mapValues { it.value.await() }
        val seen = HashSet<String>()
        val rows = labels.flatMap { l -> answers[l]?.sources.orEmpty() }
            .mapNotNull { (url, _) -> masterKey(url).takeIf { seen.add(it) }?.let { done[it] } }
        android.util.Log.i("Chitram", "[multimovies] ${rows.size} of ${masters.size} master(s) for $tmdbId in ${System.currentTimeMillis() - t0}ms")
        rows
    }

    private class Answer(
        val label: String,
        val ok: Boolean = false,
        val timedOut: Boolean = false,
        val code: Int = 0,
        val error: String? = null,
        val server: String? = null,
        val sources: List<Pair<String, String?>> = emptyList(),
    )
    private class EmbedIds(val ids: List<String>?)

    companion object {
        const val ORIGIN = "https://vidbolt.xyz"
        const val UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
        private const val API_TIMEOUT_MS = 10_000L
        const val MASTER_TIMEOUT_MS = 8_000L
        /** Cap on each /api/resolve and embed-page call (server resolveStepMs). */
        const val RESOLVE_STEP_MS = 5_000L
        /** After the plain resolve answers, stop waiting for slower servers once this much has passed (server settleMs). */
        const val SETTLE_MS = 2_000L
        /** After an HTTP 429 from VidBolt, only the plain resolve runs for this long (about 16 calls in ~15 s gave 429, 2026-11-21). */
        const val THROTTLE_COOLDOWN_MS = 60_000L
        private const val DEFAULT = "default"
        /** vidbolt.xyz/movie/579974 embed page "servers", 2026-11-21. */
        val FALLBACK_SERVERS = listOf("orion", "callisto", "luna", "vega", "quantum", "quasar")
        const val SERVER_LIST_TTL_MS = 6 * 60 * 60 * 1000L

        /** Last server list read from an embed page, with the time it was read. */
        @Volatile private var serverList: Pair<List<String>, Long>? = null
        @Volatile private var throttledUntil = 0L
        internal fun knownServers(): List<String>? = serverList?.takeIf { System.currentTimeMillis() - it.second < SERVER_LIST_TTL_MS }?.first
        /** Tests only: forget the cached server list and any 429 cooldown. */
        internal fun resetServerState() { serverList = null; throttledUntil = 0L; synchronized(health) { health.clear() } }

        /**
         * Per-server cooldown (owner ruling 2026-11-21, server twin in providers/multimovies.js):
         * [COOLDOWN_STREAK] asks in a row with no 2xx answer (cut, timeout, error; a 429 leaves the streak as is), across
         * titles, and the server is not asked for [COOLDOWN_MS]. After that one ask probes it:
         * 2xx clears the streak, anything else starts another hour. callisto (the Telugu
         * server) is never cooled.
         */
        const val COOLDOWN_STREAK = 3
        const val COOLDOWN_MS = 60 * 60 * 1000L
        private val NEVER_COOLED = setOf("callisto")
        internal class Health(var streak: Int = 0, var until: Long = 0L, var probing: Boolean = false)
        private val health = HashMap<String, Health>()

        /** True when [id] must not be asked now; claims the single probe once the hour is over. */
        internal fun cooling(id: String): Boolean = synchronized(health) {
            if (id in NEVER_COOLED) return false
            val h = health.getOrPut(id) { Health() }
            if (h.streak < COOLDOWN_STREAK) return false
            if (System.currentTimeMillis() < h.until || h.probing) return true
            h.probing = true
            android.util.Log.i("Chitram", "[multimovies] server-cooldown probe $id streak=${h.streak}")
            false
        }

        /** A 429 answer: streak and hour unchanged, only the probe claim is released. */
        internal fun releaseProbe(id: String) = synchronized(health) { health[id]?.probing = false }

        internal fun recordServer(id: String, ok: Boolean) = synchronized(health) {
            val h = health.getOrPut(id) { Health() }
            h.probing = false
            if (ok) {
                if (h.streak >= COOLDOWN_STREAK) android.util.Log.i("Chitram", "multimovies: server-cooldown $id off streak=0")
                h.streak = 0; h.until = 0L
            } else {
                h.streak += 1
                if (h.streak >= COOLDOWN_STREAK && id !in NEVER_COOLED) {
                    h.until = System.currentTimeMillis() + COOLDOWN_MS
                    android.util.Log.i("Chitram", "multimovies: server-cooldown $id on streak=${h.streak}")
                }
            }
        }

        /** Tests only: a copy of one server's health, and a way to end its hour early. */
        internal fun serverHealth(id: String): Health = synchronized(health) { health[id]?.let { Health(it.streak, it.until, it.probing) } ?: Health() }
        internal fun endCooldown(id: String) = synchronized(health) { health[id]?.until = 0L }

        /** Server ids from the embed page's config JSON (`"servers":[{"id":"orion",...}]`), or null (server parseServerIds). */
        internal fun parseServerIds(html: String?): List<String>? {
            val m = Regex(""""servers"\s*:\s*(\[[^\]]*])""").find(html ?: return null) ?: return null
            val ids = Regex(""""id"\s*:\s*"([^"]*)""").findAll(m.groupValues[1]).map { it.groupValues[1] }
                .filter { Regex("^[a-z0-9_-]{1,32}$", RegexOption.IGNORE_CASE).matches(it) }.distinct().toList()
            return ids.ifEmpty { null }
        }
        /** Left of the caller's budget after the masters, so the outer budget never fires first. */
        private const val BUDGET_MARGIN_MS = 250L
        private val SACDN_ID = Regex("""/(\d{10,})_""")

        /** A url's inner target: `?url=` wrappers (m3u8-proxy, dash-hls-bridge) decoded, up to 3 deep. */
        internal fun unwrap(url: String): String {
            var u = url
            repeat(3) {
                val inner = u.toHttpUrlOrNull()?.queryParameter("url")?.takeIf { it.startsWith("http") } ?: return u
                u = inner
            }
            return u
        }

        /**
         * Stable id for one master across re-resolves: the sacdn encode id when
         * the url names one, else a hash of the inner host and path (the query
         * holds rotating signatures and keys).
         */
        internal fun masterKey(url: String): String {
            val inner = unwrap(url)
            SACDN_ID.find(inner)?.let { return it.groupValues[1] }
            val h = inner.toHttpUrlOrNull()
            val stem = if (h != null) h.host + h.encodedPath else inner.substringBefore('?')
            val d = java.security.MessageDigest.getInstance("SHA-1").digest(stem.toByteArray())
            return d.take(5).joinToString("") { "%02x".format(it) }
        }
        fun streamHeaders(origin: String) = mapOf("User-Agent" to UA, "Referer" to "$origin/", "Origin" to origin)
        private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        /** A rendition NAME that says nothing about language (server GENERIC_AUDIO_NAME). */
        private val GENERIC_AUDIO_NAME = Regex("""^(audio|audio\s*\d+|track\s*\d*|default|main|aac|stereo|sound)$""", RegexOption.IGNORE_CASE)
        private val NO_LANGUAGE_CODE = Regex("^(und|unk|mul|zxx)$", RegexOption.IGNORE_CASE)

        /** "[4] Telugu", "1. English", "Hindi (Original)" -> "Telugu", "English", "Hindi" (server cleanName). */
        internal fun cleanName(name: String?): String =
            (name ?: "").replace(Regex("""^\s*(\[\d+]|\d+[.)])\s*"""), "").replace(Regex("""\s*\(.*\)\s*$"""), "").trim()

        private fun isOriginal(raw: String?) = raw?.trim().equals("original", true)

        /**
         * Server originalLanguageFor: "Original" is not always the TMDB original
         * language (Vidrift's Original for 1261763, TMDB te, is the Tamil track,
         * 2026-11-21). When another source of the title names that language
         * itself, [originalLang] is dropped and "Original" stays unlabelled.
         * `rawLanguages`: every source's raw VidBolt `language`, across servers.
         */
        internal fun originalLanguageFor(rawLanguages: List<String?>, originalLang: String?): String? {
            val lang = com.chitram.app.data.Ranking.knownLanguageName(originalLang) ?: return null
            return if (rawLanguages.any { !isOriginal(it) && sourceLanguage(it) == lang }) null else originalLang
        }

        /**
         * VidBolt's per-source `language` when it names a KNOWN audio language
         * (server sourceLanguage + knownLanguage). "<lang> sub/subs/subbed/
         * subtitles" carry the original audio with subtitles: never a language.
         * "Original" takes the title's original language when the app has it.
         * Junk like "Hindi dubbed" or "Dual Audio" is null.
         */
        internal fun sourceLanguage(raw: String?, originalLang: String? = null): String? {
            val v = raw?.trim().orEmpty()
            if (v.isEmpty() || Regex("""\bsub(s|bed|titles?)?$""", RegexOption.IGNORE_CASE).containsMatchIn(v)) return null
            if (v.equals("original", true)) return com.chitram.app.data.Ranking.knownLanguageName(originalLang)
            return com.chitram.app.data.Ranking.knownLanguageName(v)
        }

        /**
         * Server audioFromMaster precedence: a real master LANGUAGE wins. The
         * source language is stamped only when the master has exactly ONE
         * audio rendition, untagged (or `und`) with a generic or no NAME: one
         * source language cannot name several renditions (review C1).
         * Anything else keeps its NAME. Nothing is dropped.
         */
        internal fun withSourceLanguage(audio: List<AudioTrack>, sourceLang: String?): List<AudioTrack> {
            if (sourceLang == null || audio.size != 1) return audio
            val a = audio.single()
            val code = a.language?.trim().orEmpty()
            val name = cleanName(a.name)
            val tagged = code.isNotEmpty() && !NO_LANGUAGE_CODE.matches(code)
            return if (!tagged && (name.isEmpty() || GENERIC_AUDIO_NAME.matches(name))) listOf(a.copy(language = sourceLang)) else audio
        }
    }
}
