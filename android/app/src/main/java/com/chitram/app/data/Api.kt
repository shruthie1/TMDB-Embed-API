package com.chitram.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import okhttp3.Cache
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class HttpException(val code: Int) : IOException("HTTP $code")

/**
 * Client for the web app's API (https://chtrm2.vercel.app). The same routes the
 * site uses: /api/rows, /api/search, /api/title, /api/season, and /api/streams,
 * which Vercel rewrites to the stream backend.
 */
class Api(val client: OkHttpClient, private val base: String = BASE) {
    companion object {
        const val BASE = "https://chtrm2.vercel.app"
        const val IMG = "https://image.tmdb.org/t/p"
        val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false; isLenient = true }

        fun buildClient(cacheDir: File?): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .apply { if (cacheDir != null) cache(Cache(File(cacheDir, "http"), 20L * 1024 * 1024)) }
            .build()

        /** TMDB image url sized for the surface. Never `original`. */
        fun image(path: String?, size: String): String? = when {
            path.isNullOrEmpty() -> null
            path.startsWith("http") -> path
            else -> "$IMG/$size$path"
        }

        private val RETRY_DELAYS_MS = longArrayOf(800, 2500)
    }

    private suspend fun get(path: String, streamsTimeout: Boolean = false): String {
        val c = if (streamsTimeout) client.newBuilder().readTimeout(120, TimeUnit.SECONDS).callTimeout(125, TimeUnit.SECONDS).build() else client
        val call = c.newCall(Request.Builder().url(base + path).build())
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                cont.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { cont.resumeWithException(e) }
                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            if (!it.isSuccessful) cont.resumeWithException(HttpException(it.code))
                            else try { cont.resume(it.body!!.string()) } catch (e: IOException) { cont.resumeWithException(e) }
                        }
                    }
                })
            }
        }
    }

    private suspend fun <T> getJson(path: String, de: DeserializationStrategy<T>): T = json.decodeFromString(de, get(path))

    suspend fun row(kind: String, query: String = ""): List<Title> =
        getJson("/api/rows/$kind${if (query.isNotEmpty()) "?$query" else ""}", RowResponse.serializer()).titles

    suspend fun search(q: String, langs: List<String>): List<Title> {
        val enc = URLEncoder.encode(q, "UTF-8")
        val l = if (langs.isNotEmpty()) "&langs=${langs.joinToString(",")}" else ""
        return getJson("/api/search?q=$enc$l", SearchResponse.serializer()).titles
    }

    suspend fun titleFull(type: String, id: Long): TitleFull = getJson("/api/title/$type/$id/full", TitleFull.serializer())

    suspend fun season(id: Long, season: Int): List<Episode> =
        getJson("/api/season/$id/$season", SeasonResponse.serializer()).episodes

    /**
     * /api/streams/:kind/:id. Retries a dropped connection or 5xx/429 twice
     * (800ms, 2.5s) like web/lib/backend.js; never a 4xx.
     */
    suspend fun streams(type: String, id: Long, season: Int = 0, episode: Int = 0, refresh: Boolean = false): StreamsResponse {
        val kind = if (type == "tv" || type == "series") "series" else "movie"
        val qs = buildList {
            if (season > 0) add("season=$season")
            if (episode > 0) add("episode=$episode")
            if (refresh) add("refresh=1")
        }.joinToString("&")
        val path = "/api/streams/$kind/$id${if (qs.isNotEmpty()) "?$qs" else ""}"
        var attempt = 0
        while (true) {
            try {
                return json.decodeFromString(StreamsResponse.serializer(), get(path, streamsTimeout = true))
            } catch (e: IOException) {
                // Our own timeout is not retried: the backend already spent its budget.
                val retryable = if (e is HttpException) e.code >= 500 || e.code == 429 else e !is java.io.InterruptedIOException
                if (!retryable || attempt >= RETRY_DELAYS_MS.size) throw e
                delay(RETRY_DELAYS_MS[attempt++])
            }
        }
    }
}
