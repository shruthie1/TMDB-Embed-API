package com.chitram.app.resolve

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
 * Insertunit (api.insertunit.ws/embed/imdb/<imdb>), MultiMovies' "GD mirror"
 * first server, resolved on the device (port of providers/insertunit.js).
 * VM down or failed only, like Vidrift.
 *
 * One page GET carries the master as `hls: "<url>"` (a series page lists
 * `seasons: [{season, episodes: [{episode, hls}]}]`). Signed segments are bound
 * to the User-Agent that fetched the page (another UA: 410), not the IP, so the
 * row carries [UA] and the player sends it on every request.
 *
 * Language only from the master's LANGUAGE tags ([TaggedHls]); the page's own
 * labels ("Original") are never used.
 */
class InsertunitResolver(
    client: OkHttpClient,
    private val origin: String = ORIGIN,
    private val stepMs: Long = STEP_MS,
) {
    private val http = client.newBuilder()
        .connectTimeout(com.chitram.app.data.Api.DEVICE_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(BUDGET_MS, TimeUnit.MILLISECONDS).build()

    private fun capped(ms: Long) = http.newBuilder().callTimeout(ms.coerceAtLeast(1), TimeUnit.MILLISECONDS).build()

    /**
     * One row, or empty: no IMDb id, tv without season/episode, page 404, no
     * master on the page. Throws [StepException] on any other failure so the
     * caller's breaker counts it.
     */
    suspend fun resolveAll(type: String, tmdbId: Long, imdb: String?, season: Int, episode: Int, budgetMs: Long = BUDGET_MS): List<Resolved> {
        val t0 = System.currentTimeMillis()
        val tv = type == "tv" || type == "series"
        if (tv && (season <= 0 || episode <= 0)) return emptyList()
        if (imdb == null || !IMDB.matches(imdb)) {
            android.util.Log.i("Chitram", "[insertunit] no IMDb id for $type $tmdbId - no rows")
            return emptyList()
        }
        fun step() = minOf(stepMs, budgetMs - (System.currentTimeMillis() - t0))
        val page = get("$origin/embed/imdb/$imdb", step())
        if (page.code == 404) {
            android.util.Log.i("Chitram", "[insertunit] not-found $imdb (HTTP 404)")
            return emptyList()
        }
        if (!page.ok) throw StepException("insertunit page", page.code, "HTTP ${page.code} for $imdb")
        val master = masterFromPage(page.body, if (tv) "tv" else "movie", season, episode)
        if (master == null) {
            android.util.Log.i("Chitram", "[insertunit] no hls master on the page for $imdb")
            return emptyList()
        }
        val m = get(master, step())
        if (!m.ok) throw StepException("insertunit master", m.code, "HTTP ${m.code} for $imdb")
        val row = TaggedHls.row(m.body, master, "insertunit", "Insertunit", mapOf("User-Agent" to UA))
            ?: throw StepException("insertunit master", 0, "no variants for $imdb")
        android.util.Log.i("Chitram", "[insertunit] ok $tmdbId in ${System.currentTimeMillis() - t0}ms rows=1 langs=[${TaggedHls.langsOf(row)}]")
        return listOf(row)
    }

    private suspend fun get(url: String, ms: Long): Reply {
        if (ms <= 0) throw StepException("insertunit", 0, "budget spent")
        return try {
            withTimeoutOrNull(ms) { capped(ms).fetch(Request.Builder().url(url).header("User-Agent", UA).build()) }
                ?: throw StepException("insertunit", 0, "no answer in ${ms}ms")
        } catch (x: java.io.InterruptedIOException) {
            throw StepException("insertunit", 0, "no answer in ${ms}ms")
        }
    }

    companion object {
        const val ORIGIN = "https://api.insertunit.ws"
        /** The server's UA: the page and every segment must use the same one. */
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        /** Server budgetMs / stepTimeoutMs. */
        const val BUDGET_MS = 12_000L
        const val STEP_MS = 6_000L
        private val IMDB = Regex("^tt\\d+$")
        private val MOVIE_HLS = Regex("""\bhls:\s*"(https?://[^"]+)"""")

        /** The page's HLS master for a movie, or for one episode; null when none. */
        fun masterFromPage(html: String?, type: String, season: Int, episode: Int): String? {
            val s = html ?: return null
            if (type != "tv") return MOVIE_HLS.find(s)?.groupValues?.get(1)
            val at = Regex("""\bseasons:\s*\[""").find(s)?.range?.first ?: return null
            val start = s.indexOf('[', at)
            val arr = arrayAt(s, start) ?: return null
            val se = arr.mapNotNull { it as? JsonObject }.firstOrNull { num(it["season"]) == season } ?: return null
            val ep = (se["episodes"] as? JsonArray)?.mapNotNull { it as? JsonObject }?.firstOrNull { num(it["episode"]) == episode } ?: return null
            return (ep["hls"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        }

        private fun num(e: kotlinx.serialization.json.JsonElement?): Int? = (e as? JsonPrimitive)?.contentOrNull?.toIntOrNull()

        private fun arrayAt(s: String, from: Int): JsonArray? {
            var depth = 0; var inStr = false; var esc = false
            for (i in from until s.length) {
                val c = s[i]
                if (inStr) {
                    if (esc) esc = false else if (c == '\\') esc = true else if (c == '"') inStr = false
                    continue
                }
                when (c) {
                    '"' -> inStr = true
                    '[' -> depth++
                    ']' -> if (--depth == 0) return try { Json.parseToJsonElement(s.substring(from, i + 1)) as? JsonArray } catch (_: Exception) { null }
                }
            }
            return null
        }
    }
}
