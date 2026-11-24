package com.chitram.app.resolve

import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * VIDOUT (vidout.pages.dev), MultiMovies' server, resolved on the device (port
 * of providers/vidout.js). VM down or failed only, like Vidrift.
 *
 * Its player reads a public GitHub catalogue keyed on the TMDB id:
 * movie/<tmdb> is one line (the master url); tv/<tmdb>/S<n>.json maps episode
 * to url. 404 = not in the catalogue: no rows. The master and its playlists
 * answer only with Referer vidout.pages.dev (404 without); segments are
 * MPEG-TS named .woff2. Language only from the master ([TaggedHls]).
 */
class VidoutResolver(
    client: OkHttpClient,
    private val catalogue: String = CATALOGUE,
    private val stepMs: Long = STEP_MS,
) {
    private val http = client.newBuilder()
        .connectTimeout(com.chitram.app.data.Api.DEVICE_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(BUDGET_MS, TimeUnit.MILLISECONDS).build()

    private fun capped(ms: Long) = http.newBuilder().callTimeout(ms.coerceAtLeast(1), TimeUnit.MILLISECONDS).build()

    suspend fun resolveAll(type: String, tmdbId: Long, season: Int, episode: Int, budgetMs: Long = BUDGET_MS): List<Resolved> {
        val t0 = System.currentTimeMillis()
        val tv = type == "tv" || type == "series"
        if (tv && (season <= 0 || episode <= 0)) return emptyList()
        fun step() = minOf(stepMs, budgetMs - (System.currentTimeMillis() - t0))
        val cat = get(if (tv) "$catalogue/tv/$tmdbId/S$season.json" else "$catalogue/movie/$tmdbId", mapOf("User-Agent" to UA), step())
        if (cat.code == 404) {
            android.util.Log.i("Chitram", "[vidout] not-in-catalogue $type $tmdbId")
            return emptyList()
        }
        if (!cat.ok) throw StepException("vidout catalogue", cat.code, "HTTP ${cat.code} for $tmdbId")
        val value = if (!tv) cat.body else runCatching {
            ((Json.parseToJsonElement(cat.body) as? JsonObject)?.get(episode.toString()) as? JsonPrimitive)?.contentOrNull
        }.getOrNull()
        val master = usableLink(value)
        if (master == null) {
            android.util.Log.i("Chitram", "[vidout] no direct master for $type $tmdbId")
            return emptyList()
        }
        val m = get(master, HEADERS, step())
        if (!m.ok) throw StepException("vidout master", m.code, "HTTP ${m.code} for $tmdbId")
        val row = TaggedHls.row(m.body, master, "vidout", "VIDOUT", HEADERS)
            ?: throw StepException("vidout master", 0, "no variants for $tmdbId")
        android.util.Log.i("Chitram", "[vidout] ok $tmdbId in ${System.currentTimeMillis() - t0}ms rows=1 langs=[${TaggedHls.langsOf(row)}]")
        return listOf(row)
    }

    private suspend fun get(url: String, headers: Map<String, String>, ms: Long): Reply {
        if (ms <= 0) throw StepException("vidout", 0, "budget spent")
        return try {
            withTimeoutOrNull(ms) { capped(ms).fetch(Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build()) }
                ?: throw StepException("vidout", 0, "no answer in ${ms}ms")
        } catch (x: java.io.InterruptedIOException) {
            throw StepException("vidout", 0, "no answer in ${ms}ms")
        }
    }

    companion object {
        const val CATALOGUE = "https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls"
        const val ORIGIN = "https://vidout.pages.dev"
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        val HEADERS = mapOf("User-Agent" to UA, "Referer" to "$ORIGIN/", "Origin" to ORIGIN)
        const val BUDGET_MS = 12_000L
        const val STEP_MS = 6_000L
        private val DIRECT = Regex("""^https?://\S+$""")
        private val PLAYER = Regex("""/(e|v|embed)/[a-z0-9]+$""", RegexOption.IGNORE_CASE)

        /** The catalogue value if it is a direct master url, else null (server usableLink). */
        fun usableLink(value: String?): String? {
            val link = value?.trim().orEmpty()
            if (!DIRECT.matches(link) || link.contains('#') || PLAYER.containsMatchIn(link)) return null
            return link
        }
    }
}
