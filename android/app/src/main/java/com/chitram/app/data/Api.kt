package com.chitram.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import okhttp3.Cache
import okhttp3.CacheControl
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One /api/playback-report body (web/lib/api.js reportPlayback). */
data class PlaybackReport(
    val type: String,
    val tmdbId: Long,
    val season: Int = 0,
    val episode: Int = 0,
    val provider: String,
    val ok: Boolean,
    val reason: String? = null,
    val startupMs: Long = 0,
    val waitMs: Long = 0,
    val stallCount: Int = 0,
    val stallMs: Long = 0,
    val recoveryCount: Int = 0,
    val mediaUrl: String? = null,
    val audioLang: String? = null,
    /** "tv" or "mobile", as the web sends. */
    val device: String? = null,
)

class HttpException(val code: Int) : IOException("HTTP $code")

/**
 * Client for the web app's API (https://chtrm2.vercel.app). The same routes the
 * site uses: /api/rows, /api/search, /api/title, /api/season, and /api/streams,
 * which Vercel rewrites to the stream backend.
 */
/**
 * `client` has no HTTP cache: the player and Coil share it, and video must never
 * land in a cache. Catalog calls go through `catalogClient`, which adds `httpCache`
 * and a 1 h policy. Streams always use `client` with no-store.
 */
class Api(val client: OkHttpClient, private val base: String = BASE, httpCache: Cache? = null) {
    internal val catalogClient: OkHttpClient =
        if (httpCache == null) client
        else client.newBuilder().cache(httpCache).addNetworkInterceptor(CatalogCachePolicy).build()

    companion object {
        const val BASE = "https://chtrm2.vercel.app"
        const val IMG = "https://image.tmdb.org/t/p"
        val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false; isLenient = true }

        /** How long a catalog response stays fresh on the device. */
        const val CATALOG_MAX_AGE_S = 3600
        const val HTTP_CACHE_BYTES = 30L * 1024 * 1024

        /** Only these routes are cached. Anything else (streams included) is not. */
        private val CATALOG_PREFIXES = listOf(
            "/api/rows/", "/api/search", "/api/title/", "/api/similar/",
            "/api/person/", "/api/discover", "/api/season/",
        )

        fun isCatalogPath(path: String): Boolean =
            !path.startsWith("/api/streams") && CATALOG_PREFIXES.any { path.startsWith(it) }

        /** Uncached client for the player, Coil and streams. */
        fun buildClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .eventListenerFactory { SlowCallLog() }
            .build()

        /** Calls slower than this are logged with their DNS / connect split ("slow http" in logcat). */
        const val SLOW_CALL_MS = 1500L

        const val REPORT_TIMEOUT_S = 5L

        fun reportBody(r: PlaybackReport): String = buildJsonObject {
            put("tmdbId", r.tmdbId); put("type", r.type); put("season", r.season); put("episode", r.episode)
            put("provider", r.provider); put("mediaIdentity", null as String?); put("mediaUrl", r.mediaUrl)
            put("playedOk", r.ok); put("ok", r.ok); put("reason", r.reason)
            put("startupMs", r.startupMs); put("waitMs", r.waitMs)
            put("stallCount", r.stallCount); put("stallMs", r.stallMs); put("recoveryCount", r.recoveryCount)
            put("audioLang", r.audioLang); put("langOk", null as Boolean?)
            put("device", r.device); put("connection", null as String?)
        }.toString()

        fun httpCache(cacheDir: File): Cache = Cache(File(cacheDir, "http"), HTTP_CACHE_BYTES)

        /**
         * The backend sends `max-age=0` on catalog routes. Rewrite a 2xx catalog
         * response to 1 h; mark everything else (errors, unknown routes) no-store.
         */
        internal val CatalogCachePolicy = Interceptor { chain ->
            val res = chain.proceed(chain.request())
            val cacheable = (res.isSuccessful || res.code == 304) && isCatalogPath(chain.request().url.encodedPath)
            res.newBuilder()
                .removeHeader("Pragma")
                .removeHeader("Expires")
                .header("Cache-Control", if (cacheable) "public, max-age=$CATALOG_MAX_AGE_S" else "no-store")
                .build()
        }

        /** TMDB image url sized for the surface. Never `original`. */
        fun image(path: String?, size: String): String? = when {
            path.isNullOrEmpty() -> null
            path.startsWith("http") -> path
            else -> "$IMG/$size$path"
        }

        private val RETRY_DELAYS_MS = longArrayOf(800, 2500)
    }

    /** Request for `path`. Non-catalog paths (streams) carry no-store. */
    internal fun request(path: String): Request = Request.Builder().url(base + path)
        .apply { if (!isCatalogPath(path)) cacheControl(CacheControl.Builder().noStore().noCache().build()) }
        .build()

    private suspend fun get(path: String, streamsTimeout: Boolean = false): String {
        val c = when {
            streamsTimeout -> client.newBuilder().readTimeout(120, TimeUnit.SECONDS).callTimeout(125, TimeUnit.SECONDS).build()
            isCatalogPath(path) -> catalogClient
            else -> client
        }
        val call = c.newCall(request(path))
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

    /** "More like this" and "Because you watched": /api/similar/:type/:id. */
    suspend fun similar(type: String, id: Long): List<Title> =
        getJson("/api/similar/$type/$id", RowResponse.serializer()).titles

    suspend fun person(id: Long): PersonResponse = getJson("/api/person/$id", PersonResponse.serializer())

    suspend fun discover(f: BrowseFilters, page: Int): DiscoverResponse =
        getJson("/api/discover?${f.apiQuery(page)}", DiscoverResponse.serializer())

    suspend fun season(id: Long, season: Int): List<Episode> =
        getJson("/api/season/$id/$season", SeasonResponse.serializer()).episodes

    /**
     * /api/streams/:kind/:id. Retries a dropped connection or 5xx/429 twice
     * (800ms, 2.5s) like web/lib/backend.js; never a 4xx.
     */
    /** Short-fused client for telemetry: the VM may be down, and a report must never hang. */
    private val reportClient: OkHttpClient by lazy {
        client.newBuilder().connectTimeout(3, TimeUnit.SECONDS).callTimeout(REPORT_TIMEOUT_S, TimeUnit.SECONDS).build()
    }

    /**
     * POST /api/playback-report (web/lib/api.js reportPlayback, same body). It
     * feeds the server's learned ranking. Fire-and-forget: enqueued, never
     * awaited, every failure dropped. Telemetry must never break playback.
     */
    fun reportPlayback(r: PlaybackReport) {
        if (r.provider.isBlank() || r.tmdbId <= 0) return
        try {
            val body = reportBody(r).toRequestBody("application/json".toMediaType())
            reportClient.newCall(Request.Builder().url("$base/api/playback-report").post(body).build()).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    android.util.Log.i("Chitram", "[report] dropped ${r.provider}: ${e.javaClass.simpleName}")
                }
                override fun onResponse(call: Call, response: Response) { response.close() }
            })
        } catch (e: Exception) {
            android.util.Log.i("Chitram", "[report] not sent: ${e.javaClass.simpleName}")
        }
    }

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

/**
 * Logs one line per slow call: host, path, total, DNS and connect time. A home
 * DNS that sinkholes a host shows up here as a long dns or connect split.
 */
internal class SlowCallLog : okhttp3.EventListener() {
    private var t0 = 0L
    private var dnsAt = 0L
    private var dnsMs = -1L
    private var connAt = 0L
    private var connMs = -1L
    override fun callStart(call: okhttp3.Call) { t0 = System.nanoTime() }
    override fun dnsStart(call: okhttp3.Call, domainName: String) { dnsAt = System.nanoTime() }
    override fun dnsEnd(call: okhttp3.Call, domainName: String, inetAddressList: List<java.net.InetAddress>) { dnsMs = (System.nanoTime() - dnsAt) / 1_000_000 }
    override fun connectStart(call: okhttp3.Call, inetSocketAddress: java.net.InetSocketAddress, proxy: java.net.Proxy) { connAt = System.nanoTime() }
    override fun connectEnd(call: okhttp3.Call, inetSocketAddress: java.net.InetSocketAddress, proxy: java.net.Proxy, protocol: okhttp3.Protocol?) { connMs = (System.nanoTime() - connAt) / 1_000_000 }
    override fun callEnd(call: okhttp3.Call) = done(call, "ok")
    override fun callFailed(call: okhttp3.Call, ioe: IOException) = done(call, "failed ${ioe.javaClass.simpleName}")
    private fun done(call: okhttp3.Call, how: String) {
        val ms = (System.nanoTime() - t0) / 1_000_000
        if (ms < Api.SLOW_CALL_MS) return
        val u = call.request().url
        // Video segments are long by nature: log them only when the network setup itself was slow.
        if (!u.encodedPath.startsWith("/api/") && how == "ok" && dnsMs < 1000 && connMs < 1000) return
        android.util.Log.i("Chitram", "slow http: ${u.host}${u.encodedPath.take(60)} $how in ${ms}ms (dns ${dnsMs}ms, connect ${connMs}ms)")
    }
}
