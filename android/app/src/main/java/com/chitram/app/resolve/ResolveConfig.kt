package com.chitram.app.resolve

import com.chitram.app.data.KeyValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.CacheControl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Everything a provider site can change without notice: hosts, endpoint paths,
 * the mapple front list, the vaplayer token regex, timeouts. The values below are
 * the defaults the app ships with (read from providers/mapple.js and
 * providers/vaplayer.js on 2026-11-20). The backend can override any field via
 * GET /api/resolve-config, so a site change is a server edit, not an app update.
 *
 * Parsed by hand from a JsonElement: any field may be missing or wrong and only
 * that field falls back to the default. No reflection, so R8 cannot strip it.
 */
data class MappleConfig(
    val enabled: Boolean = true,
    val bases: List<String> = listOf("https://mapple.fun"),
    val watchPath: String = "/watch/{type}/{id}",
    val sessionPath: String = "/api/ui/session",
    val mediaSessionPath: String = "/api/media-session",
    val encryptPath: String = "/api/encrypt",
    val encryptEndpoint: String = "stream-encrypted",
    val fronts: List<String> = listOf("s25", "mapple", "s2", "s28", "s27", "s10", "s19", "s4", "s12", "s6", "s7", "s8", "s16"),
    /** The site player's own per-front timeouts; other fronts get defaultFrontTimeoutMs. */
    val frontTimeoutMs: Map<String, Long> = mapOf("mapple" to 8000L, "s10" to 12000L, "s2" to 22000L, "s25" to 24000L, "s28" to 25000L),
    /** 8s: s12 took 3.5s on a Mac and more on a phone; 5s cut it off (2026-11-20). */
    val defaultFrontTimeoutMs: Long = 8000,
    /** 4: s25, s2 and s28 carry 22-25s caps, so 3 slots could all hold slow fronts; not more, the home-IP rate limit is unmeasured (2026-11-21). */
    val frontParallelism: Int = 4,
    /** A failed front is tried last for this long (doubling per repeat, max 10 min). */
    val frontCooldownMs: Long = 60_000,
    /**
     * How long a hit WITHOUT the preferred audio waits for a front that has it.
     * Not a cut-off: while fronts are still running the hit keeps waiting, up to
     * betterWaitMaxMs (the larger of the two wins). A fixed 2500ms accepted
     * Kubera's Hindi-only "mapple" front before the Telugu front (s12, 9th of 13,
     * 3 in parallel) had started.
     */
    val betterWaitMs: Long = 2500,
    /** Ceiling for that wait, so a title with no Telugu anywhere still plays. */
    val betterWaitMaxMs: Long = 12000,
    val stepTimeoutMs: Long = 8000,
    val budgetMs: Long = 25000,
    /** 5 h: the requestToken lives 6 h (expiresIn 21599999, measured 2026-11-21). An earlier server-side expiry is refreshed once per resolve. */
    val sessionTtlMs: Long = 5 * 60 * 60 * 1000L,
    val unavailableMarker: String = "playback-unavailable",
    val userAgent: String = MAPPLE_UA,
    val powMaxIterations: Int = 20_000_000,
) {
    companion object {
        const val MAPPLE_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
    }
}

data class VaplayerConfig(
    val enabled: Boolean = true,
    val wrapperBases: List<String> = listOf("https://vaplayer.ru"),
    val vaSrcPath: String = "/embed/va_src.php",
    val embedMoviePath: String = "/embed/movie/{imdb}",
    val embedTvPath: String = "/embed/tv/{imdb}/{season}/{episode}",
    /** api.php. After a wrapper heal it follows the new host as streamdata.<host>. */
    val apiUrl: String = "https://streamdata.vaplayer.ru/api.php",
    val playerOrigin: String = "https://nextgencloudfabric.com",
    val apiTokenRegex: String = "\"apiToken\":\"([^\"]+)\"",
    val generatePath: String = "/generate.php",
    val tokenPlaceholder: String = "__TOKEN__",
    val plaintextOffset: Int = 12,
    val userAgent: String = VA_UA,
    val stepTimeoutMs: Long = 8000,
    val budgetMs: Long = 20000,
    /** Fetch the first segment once at resolve time, so a 403 (CGNAT) fails fast. */
    val probeSegment: Boolean = true,
) {
    companion object {
        const val VA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
}

/** TV discovery is public configuration; OTP and issued sessions stay on the device. */
data class NetmirrorConfig(
    val enabled: Boolean = true,
    val domains: List<String> = listOf("https://mobiledetects.com", "https://mobiledetect.app", "https://mobidetect.art", "https://mobidetect.cc", "https://mobidetect.click", "https://mobidetect.ink", "https://mobidetect.live", "https://mobidetect.pro", "https://mobidetect.shop", "https://mobidetect.site", "https://mobidetect.space", "https://mobidetect.store", "https://mobidetect.vip", "https://mobidetect.wiki", "https://mobidetect.xyz", "https://mobidetects.art", "https://mobidetects.cc", "https://mobidetects.info", "https://mobidetects.ink", "https://mobidetects.live", "https://mobidetects.pro", "https://mobidetects.store", "https://mobidetects.top", "https://mobidetects.xyz"),
    val budgetMs: Long = 50_000,
    val maxCalls: Int = 24,
    val budgetWindowMs: Long = 5 * 60 * 1000L,
    val cooldownMs: Long = 10 * 60 * 1000L,
    val apiTtlMs: Long = 10 * 60 * 1000L,
    val sessionTtlMs: Long = 30 * 60 * 1000L,
    val metadataTtlMs: Long = 7 * 24 * 60 * 60 * 1000L,
    val playerTtlMs: Long = 30_000,
)

/** CastleTV API host list (VM heal first when the VM served it) and the AES key suffix. */
data class CastleConfig(
    val bases: List<String> = listOf(CastleResolver.BASE),
    val keySuffix: String = CastleResolver.KEY_SUFFIX,
)

/** VidBolt hosts (VM heal first when the VM served it) and the JSON resolve path. */
data class MultiMoviesConfig(
    val bases: List<String> = listOf(MultiMoviesResolver.ORIGIN, "https://vidbolt.pro"),
    val resolvePath: String = "/api/resolve",
)

data class ResolveConfig(
    val version: Int = 1,
    val ttlSec: Long = 6 * 3600L,
    val mapple: MappleConfig = MappleConfig(),
    val vaplayer: VaplayerConfig = VaplayerConfig(),
    val netmirror: NetmirrorConfig = NetmirrorConfig(),
    val castletv: CastleConfig = CastleConfig(),
    val multimovies: MultiMoviesConfig = MultiMoviesConfig(),
    /** routes.<provider>.apk: off | direct | proxy | device. Invalid or missing entries are left out. */
    val routes: Map<String, String> = emptyMap(),
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /** Defaults overlaid with whatever valid fields `text` carries. Throws only on non-JSON. */
        fun parse(text: String): ResolveConfig {
            val root = json.parseToJsonElement(text) as? JsonObject ?: return ResolveConfig()
            val d = ResolveConfig()
            return ResolveConfig(
                version = root.int("version") ?: d.version,
                ttlSec = root.long("ttlSec")?.coerceIn(60, 7 * 86400L) ?: d.ttlSec,
                mapple = (root["mapple"] as? JsonObject)?.let { mapple(it) } ?: d.mapple,
                vaplayer = (root["vaplayer"] as? JsonObject)?.let { vaplayer(it) } ?: d.vaplayer,
                netmirror = (root["netmirror"] as? JsonObject)?.let { netmirror(it) } ?: d.netmirror,
                castletv = (root["castletv"] as? JsonObject)?.let { o ->
                    CastleConfig(bases = o.hosts("bases") ?: d.castletv.bases, keySuffix = o.str("keySuffix") ?: d.castletv.keySuffix)
                } ?: d.castletv,
                multimovies = (root["multimovies"] as? JsonObject)?.let { o ->
                    MultiMoviesConfig(bases = o.hosts("bases") ?: d.multimovies.bases, resolvePath = o.path("resolvePath") ?: d.multimovies.resolvePath)
                } ?: d.multimovies,
                routes = (root["routes"] as? JsonObject)?.let { routes(it) } ?: d.routes,
            )
        }

        /** Spec words and the server's code words both accepted (none = off, on-device = device). */
        private val APK_ROUTE = mapOf("off" to "off", "none" to "off", "direct" to "direct", "proxy" to "proxy", "device" to "device", "on-device" to "device")

        private fun routes(o: JsonObject): Map<String, String> = o.mapNotNull { (p, v) ->
            (v as? JsonObject)?.str("apk")?.let { APK_ROUTE[it.lowercase()] }?.let { p to it }
        }.toMap()

        private fun mapple(o: JsonObject): MappleConfig {
            val d = MappleConfig()
            return MappleConfig(
                enabled = o.bool("enabled") ?: d.enabled,
                bases = o.hosts("bases") ?: d.bases,
                watchPath = o.path("watchPath") ?: d.watchPath,
                sessionPath = o.path("sessionPath") ?: d.sessionPath,
                mediaSessionPath = o.path("mediaSessionPath") ?: d.mediaSessionPath,
                encryptPath = o.path("encryptPath") ?: d.encryptPath,
                encryptEndpoint = o.str("encryptEndpoint") ?: d.encryptEndpoint,
                fronts = o.strings("fronts")?.takeIf { it.isNotEmpty() } ?: d.fronts,
                frontTimeoutMs = (o["frontTimeoutMs"] as? JsonObject)?.let { m ->
                    m.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.longOrNull?.let { k to it.coerceIn(500, 60_000) } }.toMap()
                } ?: d.frontTimeoutMs,
                defaultFrontTimeoutMs = o.long("defaultFrontTimeoutMs")?.coerceIn(500, 60_000) ?: d.defaultFrontTimeoutMs,
                frontParallelism = o.int("frontParallelism")?.coerceIn(1, 8) ?: d.frontParallelism,
                frontCooldownMs = o.long("frontCooldownMs")?.coerceIn(0, 3_600_000) ?: d.frontCooldownMs,
                betterWaitMs = o.long("betterWaitMs")?.coerceIn(0, 20_000) ?: d.betterWaitMs,
                betterWaitMaxMs = o.long("betterWaitMaxMs")?.coerceIn(0, 30_000) ?: d.betterWaitMaxMs,
                stepTimeoutMs = o.long("stepTimeoutMs")?.coerceIn(1000, 60_000) ?: d.stepTimeoutMs,
                budgetMs = o.long("budgetMs")?.coerceIn(3000, 90_000) ?: d.budgetMs,
                sessionTtlMs = o.long("sessionTtlMs")?.coerceIn(0, 21_600_000) ?: d.sessionTtlMs,
                unavailableMarker = o.str("unavailableMarker") ?: d.unavailableMarker,
                userAgent = o.str("userAgent") ?: d.userAgent,
                powMaxIterations = o.int("powMaxIterations")?.coerceIn(1000, 200_000_000) ?: d.powMaxIterations,
            )
        }

        private fun vaplayer(o: JsonObject): VaplayerConfig {
            val d = VaplayerConfig()
            return VaplayerConfig(
                enabled = o.bool("enabled") ?: d.enabled,
                wrapperBases = o.hosts("wrapperBases") ?: d.wrapperBases,
                vaSrcPath = o.path("vaSrcPath") ?: d.vaSrcPath,
                embedMoviePath = o.path("embedMoviePath") ?: d.embedMoviePath,
                embedTvPath = o.path("embedTvPath") ?: d.embedTvPath,
                apiUrl = o.str("apiUrl")?.takeIf { it.startsWith("https://") } ?: d.apiUrl,
                playerOrigin = o.str("playerOrigin")?.takeIf { it.startsWith("https://") }?.trimEnd('/') ?: d.playerOrigin,
                apiTokenRegex = o.str("apiTokenRegex")?.takeIf { r -> runCatching { Regex(r) }.isSuccess } ?: d.apiTokenRegex,
                generatePath = o.path("generatePath") ?: d.generatePath,
                tokenPlaceholder = o.str("tokenPlaceholder") ?: d.tokenPlaceholder,
                plaintextOffset = o.int("plaintextOffset")?.coerceIn(0, 64) ?: d.plaintextOffset,
                userAgent = o.str("userAgent") ?: d.userAgent,
                stepTimeoutMs = o.long("stepTimeoutMs")?.coerceIn(1000, 60_000) ?: d.stepTimeoutMs,
                budgetMs = o.long("budgetMs")?.coerceIn(3000, 90_000) ?: d.budgetMs,
                probeSegment = o.bool("probeSegment") ?: d.probeSegment,
            )
        }

        private fun netmirror(o: JsonObject): NetmirrorConfig {
            val d = NetmirrorConfig()
            return NetmirrorConfig(
                enabled = o.bool("enabled") ?: d.enabled,
                domains = o.hosts("domains") ?: d.domains,
                budgetMs = o.long("budgetMs")?.coerceIn(3000, 90_000) ?: d.budgetMs,
                maxCalls = o.int("maxCalls")?.coerceIn(1, 50) ?: d.maxCalls,
                budgetWindowMs = o.long("budgetWindowMs")?.coerceIn(60_000, 3_600_000) ?: d.budgetWindowMs,
                cooldownMs = o.long("cooldownMs")?.coerceIn(60_000, 7_200_000) ?: d.cooldownMs,
                apiTtlMs = o.long("apiTtlMs")?.coerceIn(60_000, 3_600_000) ?: d.apiTtlMs,
                sessionTtlMs = o.long("sessionTtlMs")?.coerceIn(60_000, 3_600_000) ?: d.sessionTtlMs,
                metadataTtlMs = o.long("metadataTtlMs")?.coerceIn(60_000, 604_800_000) ?: d.metadataTtlMs,
                playerTtlMs = o.long("playerTtlMs")?.coerceIn(0, 60_000) ?: d.playerTtlMs,
            )
        }

        private fun JsonObject.prim(k: String): JsonPrimitive? = this[k] as? JsonPrimitive
        private fun JsonObject.str(k: String): String? = prim(k)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
        private fun JsonObject.path(k: String): String? = str(k)?.takeIf { it.startsWith("/") }
        private fun JsonObject.int(k: String): Int? = prim(k)?.intOrNull
        private fun JsonObject.long(k: String): Long? = prim(k)?.longOrNull
        private fun JsonObject.bool(k: String): Boolean? = prim(k)?.booleanOrNull
        private fun JsonObject.strings(k: String): List<String>? = (this[k] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }
        /** https hosts only; an empty or all-invalid list keeps the default. */
        private fun JsonObject.hosts(k: String): List<String>? = strings(k)
            ?.filter { it.startsWith("https://") }?.map { it.trimEnd('/') }?.takeIf { it.isNotEmpty() }
    }
}

/**
 * The override config: fetched from the backend, kept in KeyValue with its TTL,
 * defaults when nothing was ever fetched. Order: the VM merged view at [url]
 * (built-in + remote + VM heals), then the static copy at [remoteUrl] (no heals)
 * when the VM fetch fails or the VM breaker is open ([vmUp] false). When both
 * fail the last good copy stays (even if stale) and no fetch is retried for
 * RETRY_MS, so a down backend never adds its timeout to every play.
 */
class ResolveConfigStore(
    client: OkHttpClient,
    private val url: String,
    private val kv: KeyValue,
    private val remoteUrl: String? = null,
    private val vmUp: () -> Boolean = { true },
    /** Last, so existing callers keep their trailing-lambda clock. */
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val http = client.newBuilder().callTimeout(FETCH_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    @Volatile private var mem: Pair<ResolveConfig, Long>? = null
    @Volatile private var lastAttempt = 0L

    /** Cached or default config, no network. */
    fun current(): ResolveConfig = cached()?.first ?: ResolveConfig()

    suspend fun get(): ResolveConfig {
        val c = cached()
        if (c != null && now() - c.second < c.first.ttlSec * 1000) return c.first
        if (now() - lastAttempt < RETRY_MS) return c?.first ?: ResolveConfig()
        return refresh()
    }

    suspend fun refresh(): ResolveConfig {
        lastAttempt = now()
        val vm = vmUp()
        val tries = listOfNotNull(url.takeIf { vm }?.let { "vm" to it }, remoteUrl?.let { "remote" to it })
        val why = mutableListOf<String>()
        if (!vm) why += "vm paused"
        for ((from, u) in tries) {
            try {
                val req = Request.Builder().url(u).cacheControl(CacheControl.Builder().noStore().noCache().build()).build()
                val r = http.fetch(req)
                if (!r.ok) throw StepException("resolve-config", r.code, "HTTP ${r.code}")
                // An error page with 200 is not a config: the next url is tried.
                if (!r.body.trimStart().startsWith("{")) throw StepException("resolve-config", r.code, "not a JSON object")
                val cfg = ResolveConfig.parse(r.body)
                val at = now()
                mem = cfg to at
                kv.put(KEY, r.body)
                kv.put(KEY_AT, at.toString())
                android.util.Log.i("Chitram", "resolve-config: fetched v${cfg.version} from $from")
                return cfg
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                why += "$from ${e.message}"
            }
        }
        android.util.Log.i("Chitram", "resolve-config: fetch failed (${why.joinToString("; ")}); using ${if (cached() != null) "cached" else "defaults"}")
        return current()
    }

    private fun cached(): Pair<ResolveConfig, Long>? {
        mem?.let { return it }
        val raw = kv.get(KEY) ?: return null
        val at = kv.get(KEY_AT)?.toLongOrNull() ?: 0L
        return runCatching { ResolveConfig.parse(raw) }.getOrNull()?.let { (it to at).also { p -> mem = p } }
    }

    companion object {
        /** Proposed backend route; until it exists the fetch 404s and defaults apply. */
        const val PATH = "/api/resolve-config"
        /**
         * Static copy of the remote resolve-config on the chtrm web host (web/public,
         * served by Vercel, so it answers with the VM down). Path relative to Api.BASE.
         */
        const val REMOTE_PATH = "/resolve-config.json"
        const val KEY = "resolve.config"
        const val KEY_AT = "resolve.config.at"
        const val RETRY_MS = 10 * 60 * 1000L
        const val FETCH_TIMEOUT_MS = 4000L
    }
}
