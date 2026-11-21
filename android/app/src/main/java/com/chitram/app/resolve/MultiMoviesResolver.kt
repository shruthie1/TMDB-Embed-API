package com.chitram.app.resolve

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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
) {
    /** 3 s connect: a direct host the phone cannot reach fails fast (multimovies-slow-rca.md fix 5). */
    internal val http = client.newBuilder()
        .connectTimeout(com.chitram.app.data.Api.DIRECT_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()

    /** The first row of [resolveAll], or null when there is none. Throws when the API call failed. */
    suspend fun resolve(type: String, tmdbId: Long, season: Int, episode: Int): Resolved? =
        resolveAll(type, tmdbId, season, episode).firstOrNull()

    /**
     * One row per VidBolt HLS source whose master parses, in API order (the
     * server does the same). Each source's own `language` labels a generic
     * rendition. Masters are fetched in parallel; a dead one drops only its row.
     * Throws when the API call failed.
     */
    suspend fun resolveAll(type: String, tmdbId: Long, season: Int, episode: Int): List<Resolved> {
        val tv = type == "tv" || type == "series"
        val s = season.coerceAtLeast(1)
        val e = episode.coerceAtLeast(1)
        val path = if (tv) "tv/$tmdbId/$s/$e" else "movie/$tmdbId"
        val api = if (tv) "$origin/api/resolve?type=tv&id=$tmdbId&season=$s&episode=$e" else "$origin/api/resolve?type=movie&id=$tmdbId"
        val r = http.fetch(Request.Builder().url(api).header("User-Agent", UA).header("Referer", "$origin/$path").build())
        if (!r.ok) throw StepException("multimovies resolve", r.code, "HTTP ${r.code}")
        val body = MappleResolver.obj(r.body) ?: throw StepException("multimovies resolve", r.code, "not JSON")
        val sources = ((body["stream"] as? JsonObject)?.get("sources") as? JsonArray).orEmpty()
            .mapNotNull { it as? JsonObject }
            .filter { str(it, "kind") == "hls" }
            .mapNotNull { o -> str(o, "url")?.let { it to sourceLanguage(str(o, "language")) } }
        if (sources.isEmpty()) {
            android.util.Log.i("Chitram", "[multimovies] no hls source for $tmdbId")
            return emptyList()
        }
        val headers = streamHeaders(origin)
        val rows = coroutineScope {
            sources.mapIndexed { i, (url, lang) ->
                async {
                    val m = try {
                        val reply = http.fetch(Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
                        if (reply.ok) Hls.parse(reply.body, url) else null
                    } catch (e: Exception) {
                        if (e is kotlinx.coroutines.CancellationException) throw e
                        null
                    }
                    if (m == null || m.levels.isEmpty()) return@async null
                    Resolved(
                        provider = "multimovies",
                        label = "MultiMovies",
                        url = url,
                        headers = headers,
                        segmentToken = null,
                        audio = withSourceLanguage(m.audio, lang),
                        levels = m.levels.sortedByDescending { it.height },
                        codecs = m.codecs,
                        // Distinct row ids (device-multimovies-<i>): one row per source.
                        key = "multimovies-$i",
                    )
                }
            }.awaitAll().filterNotNull()
        }
        android.util.Log.i("Chitram", "[multimovies] ${rows.size} of ${sources.size} source(s) for $tmdbId")
        return rows
    }

    companion object {
        const val ORIGIN = "https://vidbolt.xyz"
        const val UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
        private const val API_TIMEOUT_MS = 10_000L
        fun streamHeaders(origin: String) = mapOf("User-Agent" to UA, "Referer" to "$origin/", "Origin" to origin)
        private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        /** A rendition NAME that says nothing about language (server GENERIC_AUDIO_NAME). */
        private val GENERIC_AUDIO_NAME = Regex("""^(audio|audio\s*\d+|track\s*\d*|default|main|aac|stereo|sound)$""", RegexOption.IGNORE_CASE)
        private val NO_LANGUAGE_CODE = Regex("^(und|unk|mul|zxx)$", RegexOption.IGNORE_CASE)

        /** "[4] Telugu", "1. English", "Hindi (Original)" -> "Telugu", "English", "Hindi" (server cleanName). */
        internal fun cleanName(name: String?): String =
            (name ?: "").replace(Regex("""^\s*(\[\d+]|\d+[.)])\s*"""), "").replace(Regex("""\s*\(.*\)\s*$"""), "").trim()

        /**
         * VidBolt's per-source `language`, when it names an audio language
         * (server sourceLanguage). "<lang> sub" carries the original audio with
         * subtitles and "Original" names no language: neither is used.
         */
        internal fun sourceLanguage(raw: String?): String? {
            val v = raw?.trim().orEmpty()
            if (v.isEmpty() || Regex("""\bsub(s|titles?)?$""", RegexOption.IGNORE_CASE).containsMatchIn(v) || v.equals("original", true)) return null
            return com.chitram.app.data.Ranking.languageLabel(v)
        }

        /**
         * Server audioFromMaster precedence: a real master LANGUAGE wins; an
         * untagged or `und` rendition with a generic (or no) NAME takes the
         * source language; anything else keeps its NAME. Nothing is dropped.
         */
        internal fun withSourceLanguage(audio: List<AudioTrack>, sourceLang: String?): List<AudioTrack> {
            if (sourceLang == null) return audio
            return audio.map { a ->
                val code = a.language?.trim().orEmpty()
                val name = cleanName(a.name)
                val tagged = code.isNotEmpty() && !NO_LANGUAGE_CODE.matches(code)
                if (!tagged && (name.isEmpty() || GENERIC_AUDIO_NAME.matches(name))) a.copy(language = sourceLang) else a
            }
        }
    }
}
