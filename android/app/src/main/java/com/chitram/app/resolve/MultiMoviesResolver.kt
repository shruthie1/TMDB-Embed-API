package com.chitram.app.resolve

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
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
    private val http = client.newBuilder().callTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()

    /** null: no HLS source for this title. Throws when the chain failed. */
    suspend fun resolve(type: String, tmdbId: Long, season: Int, episode: Int): Resolved? {
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
            .mapNotNull { str(it, "url") }
        if (sources.isEmpty()) {
            android.util.Log.i("Chitram", "[multimovies] no hls source for $tmdbId")
            return null
        }
        val headers = streamHeaders(origin)
        for (url in sources) {
            val m = runCatching {
                val reply = http.fetch(Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
                if (reply.ok) Hls.parse(reply.body, url) else null
            }.getOrNull() ?: continue
            if (m.levels.isEmpty()) continue
            return Resolved(
                provider = "multimovies",
                label = "MultiMovies",
                url = url,
                headers = headers,
                segmentToken = null,
                audio = m.audio,
                levels = m.levels.sortedByDescending { it.height },
                codecs = m.codecs,
            )
        }
        return null
    }

    companion object {
        const val ORIGIN = "https://vidbolt.xyz"
        const val UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
        private const val API_TIMEOUT_MS = 10_000L
        fun streamHeaders(origin: String) = mapOf("User-Agent" to UA, "Referer" to "$origin/", "Origin" to origin)
        private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }
}
