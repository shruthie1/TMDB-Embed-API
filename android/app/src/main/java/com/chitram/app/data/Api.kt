package com.chitram.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
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

/** `codecs` of a /hybrid/pair answer: the fused master's video CODECS and its audio codec. */
@kotlinx.serialization.Serializable
data class PairCodecs(val video: List<String> = emptyList(), val audio: String? = null)

@kotlinx.serialization.Serializable
internal data class PairResponse(val url: String? = null, val delta: Double = 0.0, val padded: Boolean = false, val codecs: PairCodecs? = null)

/** POST /hybrid/pair (Step 2 Task 1, with `language`). */
sealed interface PairOutcome {
    /** 200: the server fused the picture with the donor's `language` audio. */
    data class Ok(val url: String, val codecs: PairCodecs?, val padded: Boolean, val delta: Double) : PairOutcome
    /** 4xx: 409 'not pairable' (the donor lacks the language, a different cut, unreadable) or another client error. */
    data class Refused(val reason: String?) : PairOutcome
    /** IO error, timeout (call or per-try), 5xx or an unreadable 2xx. Task 6 falls back to the device here. */
    data class Unreachable(val detail: String) : PairOutcome
}

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
class Api(
    val client: OkHttpClient,
    private val base: String = BASE,
    httpCache: Cache? = null,
    /** /api/streams goes straight to the VM, so a Vercel fault and a VM fault look different. */
    private val vmBase: String = VM,
    private val vm: VmHealth? = null,
    private val streamsCallTimeoutMs: Long = STREAMS_CALL_TIMEOUT_MS,
    private val streamsFullTimeoutMs: Long = STREAMS_FULL_TIMEOUT_MS,
    /** Fix C: no response headers from /api/streams in this long sends a second call on a fresh connection. */
    private val streamsHedgeMs: Long = STREAMS_HEDGE_MS,
    /** VM answers kept 30 min on the device (StreamCache); null keeps none (tests). */
    private val streamCache: com.chitram.app.resolve.StreamCache? = null,
) {
    /** False while the VM breaker is open (paused after failures): no VM call would go out. */
    val vmUp: Boolean get() = vm?.allow() != false

    /** The VM breaker is open: no call went out. */
    class VmDown(detail: String) : IOException(detail)

    /** 3s connect: a dead host fails fast. The VM's own provider deadline is 20s. */
    private val vmClient: OkHttpClient by lazy {
        client.newBuilder()
            .connectTimeout(VM_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(streamsCallTimeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(streamsCallTimeoutMs, TimeUnit.MILLISECONDS)
            .build()
    }
    /** The ?full=1 follow-up waits for every provider on the VM (web uses 60s). */
    private val fullClient: OkHttpClient by lazy {
        client.newBuilder()
            .connectTimeout(VM_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(streamsFullTimeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(streamsFullTimeoutMs, TimeUnit.MILLISECONDS)
            .build()
    }
    private val statusClient: OkHttpClient by lazy {
        client.newBuilder().connectTimeout(VM_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(VM_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    }

    internal val catalogClient: OkHttpClient =
        if (httpCache == null) client
        else client.newBuilder().cache(httpCache).addNetworkInterceptor(CatalogCachePolicy).build()

    companion object {
        const val BASE = "https://chtrm2.vercel.app"
        /** The VM origin (Vercel rewrites /api/streams here). */
        const val VM = "https://tmdb-187-127-137-163.sslip.io"
        const val VM_CONNECT_TIMEOUT_MS = 3_000L
        /**
         * Connect timeout for a VM row playing direct: it has the proxied url to
         * fall back to (DirectRoute), so a dead host may fail fast.
         */
        const val DIRECT_CONNECT_TIMEOUT_MS = 3_000L
        /**
         * Connect timeout for on-device rows and the MultiMovies resolver: no
         * proxy fallback, and a live Cloudflare host once took 7.6 s to connect
         * (multimovies-slow-rca.md section 2), so 8 s, not 3 s (review I1).
         */
        const val DEVICE_CONNECT_TIMEOUT_MS = 8_000L
        /** Was readTimeout 120s + callTimeout 125s with 2 retries. */
        const val STREAMS_CALL_TIMEOUT_MS = 22_000L
        /** A9 follow-up, same as web/lib/backend.js. */
        const val STREAMS_FULL_TIMEOUT_MS = 60_000L
        /** Fix C: all 3 measured VM answers had headers in 1.1-3.1 s (first-play-slow.md). */
        const val STREAMS_HEDGE_MS = 6_000L
        const val IMG = "https://image.tmdb.org/t/p"
        /** Phone card and detail poster: 112-104 dp x 3 = 312-336 px; w500 leaves headroom (owner 2026-11-21). */
        const val POSTER_PHONE = "w500"
        /** TV card: 219 px at 1080p, so w342 is already sharp. */
        const val POSTER_TV = "w342"
        /** Phone hero/detail backdrop: full width 1080-1440 px. */
        const val BACKDROP_PHONE = "w1280"
        /** Fire TV hero/detail backdrop: TMDB has no 1920 size, so `original`, decoded down (see [decodeBound]). */
        const val BACKDROP_TV = "original"
        /** Hero title logo (transparent png). */
        const val LOGO = "w500"
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

        /** /hybrid/pair body: same sides as web pairSources, plus the asked `language`. */
        fun pairBody(video: Source, audio: Source, language: String, tmdbId: Long, type: String): String = buildJsonObject {
            // The proxied url, as before direct play existed: the server unwraps it.
            fun side(s: Source) = buildJsonObject {
                put("url", com.chitram.app.player.DirectRoute.proxyOf(s).url); put("provider", s.provider); put("quality", s.quality)
                if (!s.codecString.isNullOrBlank()) put("codecs", s.codecString)
            }
            put("video", side(video)); put("audio", side(audio)); put("language", language)
            if (tmdbId > 0) { put("tmdbId", tmdbId); put("type", if (type == "tv" || type == "series") "series" else "movie") }
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

        /**
         * TMDB image url sized for the surface. The old rule was "never
         * `original`". Owner 2026-11-21: the Fire TV hero uses `original`
         * (3640 px, ~1.5 MB) because w1280 upscales 1.5x on a 1920 screen.
         * `original` is safe only because Art() decodes it down to the screen
         * ([decodeBound]): a full 3640x2048 ARGB bitmap is ~30 MB of Fire TV heap.
         */
        fun image(path: String?, size: String): String? = when {
            path.isNullOrEmpty() -> null
            path.startsWith("http") -> path
            else -> "$IMG/$size$path"
        }

        /**
         * Decode bound (px) for an image of this TMDB size on a screen of
         * [screenW] x [screenH]: the screen for `original`, else null (the
         * view's own constraints, Coil's default). Never more than the screen,
         * so Fire TV memory never holds a 3640 px bitmap.
         */
        fun decodeBound(size: String, screenW: Int, screenH: Int): Pair<Int, Int>? =
            if (size == "original" && screenW > 0 && screenH > 0) screenW to screenH else null
    }

    /** Request for `path`. Non-catalog paths (streams) carry no-store. */
    internal fun request(path: String): Request = Request.Builder().url(base + path)
        .apply { if (!isCatalogPath(path)) cacheControl(CacheControl.Builder().noStore().noCache().build()) }
        .build()

    private suspend fun get(path: String): String =
        call(if (isCatalogPath(path)) catalogClient else client, request(path))

    private suspend fun call(c: OkHttpClient, req: Request, onHeaders: (() -> Unit)? = null): String {
        val call = c.newCall(req)
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                cont.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { cont.resumeWithException(e) }
                    override fun onResponse(call: Call, response: Response) {
                        onHeaders?.invoke()
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

    /**
     * POST /hybrid/pair on the VM (web/lib/backend.js pairSources, plus Step 2
     * `language`): [video]'s picture with [audio]'s [language] track, fused on
     * the server. No headers are sent: the server knows them from its own
     * resolve. Never throws (cancellation aside).
     */
    suspend fun pair(video: Source, audio: Source, language: String, tmdbId: Long, type: String): PairOutcome {
        if (vm?.allow() == false) return PairOutcome.Unreachable("vm paused")
        val body = pairBody(video, audio, language, tmdbId, type).toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$vmBase/hybrid/pair").post(body)
            .cacheControl(CacheControl.Builder().noStore().noCache().build()).build()
        return try {
            val (code, text) = exchange(vmClient, req)
            when {
                // Only the network, a timeout or a 5xx is Unreachable; any 4xx is the server's answer.
                code >= 500 -> PairOutcome.Unreachable("HTTP $code")
                code in 400..499 -> PairOutcome.Refused(runCatching { json.parseToJsonElement(text).let { (it as? kotlinx.serialization.json.JsonObject)?.get("reason")?.let { r -> (r as? kotlinx.serialization.json.JsonPrimitive)?.content } } }.getOrNull() ?: "HTTP $code")
                code !in 200..299 -> PairOutcome.Unreachable("HTTP $code")
                else -> {
                    val d = json.decodeFromString(PairResponse.serializer(), text)
                    if (d.url.isNullOrBlank()) PairOutcome.Unreachable("no url") else PairOutcome.Ok(d.url, d.codecs, d.padded, d.delta)
                }
            }
        } catch (e: IOException) {
            PairOutcome.Unreachable("${e.javaClass.simpleName} ${e.message ?: ""}".trim())
        } catch (e: kotlinx.serialization.SerializationException) {
            PairOutcome.Unreachable("unreadable")
        } catch (e: IllegalArgumentException) {
            PairOutcome.Unreachable("unreadable")
        }
    }

    /**
     * Step 2 Task 6 duration gate: one playlist read with the row's own client
     * ([c] carries its headers and token). Null on any failure: the gate refuses.
     */
    suspend fun text(c: OkHttpClient, url: String): String? = try {
        exchange(c, Request.Builder().url(url).build()).takeIf { it.first in 200..299 }?.second
    } catch (e: IOException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    /** Status and body of any answer (a 409 carries its reason in the body). */
    private suspend fun exchange(c: OkHttpClient, req: Request): Pair<Int, String> {
        val call = c.newCall(req)
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                cont.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) { cont.resumeWithException(e) }
                    override fun onResponse(call: Call, response: Response) {
                        response.use {
                            try { cont.resume(it.code to (it.body?.string() ?: "")) } catch (e: IOException) { cont.resumeWithException(e) }
                        }
                    }
                })
            }
        }
    }

    private fun streamsPath(type: String, id: Long, season: Int, episode: Int, refresh: Boolean, full: Boolean): String {
        val kind = if (type == "tv" || type == "series") "series" else "movie"
        val qs = buildList {
            if (season > 0) add("season=$season")
            if (episode > 0) add("episode=$episode")
            if (refresh) add("refresh=1")
            if (full) add("full=1")
        }.joinToString("&")
        return "/api/streams/$kind/$id${if (qs.isNotEmpty()) "?$qs" else ""}"
    }

    /**
     * A9: the one ?full=1 follow-up after a partial answer. The VM joins the
     * provider calls still running. Optional: null on any failure, never
     * throws an IOException, and never moves the breaker (the first call
     * already proved the VM up; a slow full answer is not a VM fault).
     */
    suspend fun streamsFull(type: String, id: Long, season: Int = 0, episode: Int = 0): StreamsResponse? {
        val key = com.chitram.app.resolve.StreamCache.key(type, id, season, episode)
        streamCache?.vm(key, full = true)?.let { android.util.Log.i("Chitram", "[cache] vm full $type/$id hit: ${it.streams.size} row(s), 0 requests"); return it }
        if (vm?.allow() == false) return null
        val path = streamsPath(type, id, season, episode, refresh = false, full = true)
        return try {
            json.decodeFromString(StreamsResponse.serializer(), call(fullClient, noStore(vmBase + path))).also { streamCache?.putVm(key, full = true, it) }
        } catch (e: IOException) {
            android.util.Log.i("Chitram", "[vm] full follow-up failed: ${e.javaClass.simpleName} ${e.message}")
            null
        } catch (e: kotlinx.serialization.SerializationException) {
            android.util.Log.i("Chitram", "[vm] full follow-up unreadable: ${e.message?.take(80)}")
            null
        }
    }

    suspend fun streams(type: String, id: Long, season: Int = 0, episode: Int = 0, refresh: Boolean = false): StreamsResponse {
        val path = streamsPath(type, id, season, episode, refresh, full = false)
        // Kept VM answer (30 min): no call. A refresh (a VM row failed) drops it and asks again.
        val key = com.chitram.app.resolve.StreamCache.key(type, id, season, episode)
        if (refresh) streamCache?.evictVm(key)
        else streamCache?.vm(key, full = false)?.let { android.util.Log.i("Chitram", "[cache] vm $type/$id hit: ${it.streams.size} row(s), 0 requests"); return it }
        val h = vm
        if (h != null && !h.allow()) throw VmDown("VM paused for ${(h.openUntil - System.currentTimeMillis()) / 1000}s")
        if (h != null && h.halfOpen && !vmAnswers()) {
            h.onFailure()
            throw VmDown("VM status probe failed")
        }
        var retried = false
        while (true) {
            try {
                val body = hedged(vmClient, noStore(vmBase + path), streamsHedgeMs)
                h?.onSuccess()
                return json.decodeFromString(StreamsResponse.serializer(), body).also { streamCache?.putVm(key, full = false, it) }
            } catch (e: IOException) {
                // A 4xx is an answer: the VM is up.
                if (e is HttpException && e.code < 500) { h?.onSuccess(); throw e }
                // One retry, only for a reset connection, only while the breaker is closed.
                val reset = e !is HttpException && (e.message?.contains("reset", true) == true || e.message?.contains("unexpected end of stream", true) == true)
                if (reset && !retried && h?.halfOpen != true) { retried = true; continue }
                h?.onFailure()
                android.util.Log.i("Chitram", "[vm] streams failed: ${e.javaClass.simpleName} ${e.message}")
                throw e
            }
        }
    }

    /**
     * Fix C: an idempotent GET that has no response headers after [hedgeMs] is
     * sent again on a fresh connection (its own pool, inside the same overall
     * call timeout); the first success wins and the other call is cancelled.
     * Both failing throws the last error. Anything but a GET is sent once.
     */
    internal suspend fun hedged(c: OkHttpClient, req: Request, hedgeMs: Long): String {
        if (req.method != "GET" || hedgeMs <= 0) return call(c, req)
        return kotlinx.coroutines.coroutineScope {
            val heads = kotlinx.coroutines.CompletableDeferred<Unit>()
            val first = async { runCatching { call(c, req) { heads.complete(Unit) } } }
            val answered = kotlinx.coroutines.withTimeoutOrNull(hedgeMs) {
                kotlinx.coroutines.selects.select<Unit> { heads.onAwait {}; first.onAwait {} }
            }
            if (answered != null) return@coroutineScope first.await().getOrThrow()
            android.util.Log.i("Chitram", "[vm] no response headers in ${hedgeMs}ms: hedging ${req.url.encodedPath} on a fresh connection")
            val fresh = c.newBuilder().connectionPool(okhttp3.ConnectionPool())
                .callTimeout((c.callTimeoutMillis - hedgeMs).coerceAtLeast(1_000), TimeUnit.MILLISECONDS).build()
            val second = async { runCatching { call(fresh, req) } }
            val (won, other, label) = kotlinx.coroutines.selects.select<Triple<Result<String>, kotlinx.coroutines.Deferred<Result<String>>, String>> {
                first.onAwait { Triple(it, second, "first") }
                second.onAwait { Triple(it, first, "hedge") }
            }
            if (won.isSuccess) {
                other.cancel()
                fresh.connectionPool.evictAll()
                android.util.Log.i("Chitram", "[vm] hedge: $label call answered first")
                return@coroutineScope won.getOrThrow()
            }
            val last = other.await()
            fresh.connectionPool.evictAll()
            android.util.Log.i("Chitram", "[vm] hedge: ${if (last.isSuccess) "${if (label == "first") "hedge" else "first"} call answered" else "both calls failed"}")
            last.getOrThrow()
        }
    }

    /** Half-open probe: GET /api/status on the VM, 3s. */
    private suspend fun vmAnswers(): Boolean = try { call(statusClient, noStore("$vmBase/api/status")); true } catch (e: IOException) { false }

    private fun noStore(url: String): Request =
        Request.Builder().url(url).cacheControl(CacheControl.Builder().noStore().noCache().build()).build()
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
    private var headersMs = -1L
    private var bodyMs = -1L
    override fun callStart(call: okhttp3.Call) { t0 = System.nanoTime() }
    override fun responseHeadersEnd(call: okhttp3.Call, response: Response) { headersMs = (System.nanoTime() - t0) / 1_000_000 }
    override fun responseBodyEnd(call: okhttp3.Call, byteCount: Long) { bodyMs = (System.nanoTime() - t0) / 1_000_000 }
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
        android.util.Log.i("Chitram", line(u.host + u.encodedPath.take(60), how, ms, dnsMs, connMs, headersMs, bodyMs))
    }

    companion object {
        /** Fix B: headers and body are end times since call start, -1 when not reached (headers-late vs body-stall). */
        internal fun line(target: String, how: String, ms: Long, dnsMs: Long, connMs: Long, headersMs: Long, bodyMs: Long) =
            "slow http: $target $how in ${ms}ms (dns ${dnsMs}ms, connect ${connMs}ms, headers ${headersMs}ms, body ${bodyMs}ms)"
    }
}
