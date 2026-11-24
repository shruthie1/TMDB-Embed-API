package com.chitram.app.resolve

import com.chitram.app.data.SubtitleRef
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * A device row plus what [Resolved] cannot say: whether it is one progressive
 * file (MP4/MKV) rather than an HLS master, and the quality the upstream names
 * (the server row's `quality`; there is no ladder to read it from).
 */
data class DeviceRow(val resolved: Resolved, val progressive: Boolean, val quality: String)

/**
 * showsst on the device (port of providers/showsst.js). One JSON call keyed on
 * the TMDB id, so it cannot land on the wrong film.
 *
 * The api gates on Chrome's headers: without Accept-Language, Referer,
 * Sec-Fetch-*, sec-ch-ua* and priority it answers {"source":null}; an Origin
 * that is not its own player gets 403 "forbidden" (measured 2026-11-21 from a
 * Jio IP: player Origin 200, chtrm2.vercel.app Origin 403). OkHttp adds gzip
 * itself; that alone passes (200, 4 qualities on RRR).
 *
 * No language is claimed: one muxed track and the api does not say which.
 */
class ShowsstResolver(
    client: OkHttpClient,
    private val mirrors: List<Mirror> = MIRRORS,
) {
    data class Mirror(val api: String, val player: String)

    private val http = client.newBuilder().callTimeout(STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    private val probeHttp = client.newBuilder().callTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Empty: showsst has no source (its real answer). Throws when every mirror failed. */
    suspend fun resolveAll(type: String, tmdbId: Long, season: Int, episode: Int): List<DeviceRow> {
        val series = type == "tv" || type == "series"
        // `season`/`episode` spelled out: `s`/`e` get {"error":"missing parameters"}.
        val path = if (series) "/tv?id=$tmdbId&season=${season.coerceAtLeast(1)}&episode=${episode.coerceAtLeast(1)}&mode=json"
            else "/movie?id=$tmdbId&mode=json"
        // Fail over on transport errors and non-2xx only: a null source is the shared backend's answer.
        var body: JsonObject? = null
        var mirror: Mirror? = null
        var last: Exception? = null
        for (m in mirrors) {
            try {
                val r = http.fetch(apiRequest(m, path))
                if (!r.ok) throw StepException("showsst", r.code, "HTTP ${r.code} from ${m.api}")
                body = json.parseToJsonElement(r.body) as? JsonObject ?: throw StepException("showsst", r.code, "not a JSON object")
                mirror = m
                break
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                last = e
                log("${m.api} failed for $tmdbId: ${e.message}")
            }
        }
        if (body == null || mirror == null) throw StepException("showsst", (last as? StepException)?.code ?: 0, "all ${mirrors.size} mirrors failed for $tmdbId")
        val source = body["source"] as? JsonObject
        val sourceUrl = source?.let { str(it, "url") }
        if (source == null || sourceUrl.isNullOrBlank()) return emptyList<DeviceRow>().also { log("no source url for $tmdbId") }

        val subtitles = (body["subtitles"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            .mapNotNull { s -> (str(s, "file") ?: str(s, "url"))?.let { it to s } }
            .mapIndexed { i, (url, s) -> SubtitleRef(url, str(s, "label") ?: str(s, "lang") ?: "Subtitle ${i + 1}", "sst-$i") }

        val headers = streamHeaders(mirror.player)
        val qualities = (source["qualities"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val hasQualities = qualities.isNotEmpty()
        // HEVC dropped as the server drops it (providers/showsst.js).
        val variants = (if (hasQualities) qualities.filter { str(it, "url") != null && str(it, "codec") != "hevc" }
            .map { str(it, "url")!! to (str(it, "quality") ?: "Auto") }
            else listOf(sourceUrl to if (source["manifest"] is JsonPrimitive && (source["manifest"] as JsonPrimitive).isString) "Auto" else "1080p"))
            .ifEmpty { listOf(sourceUrl to "Auto") }

        // One probe: every variant of a source is served by the same host and kind.
        val container = probeContainer(variants.first().first, headers, if (hasQualities) "mp4" else "hls")
        val label = str(source, "label") ?: "source"
        log("got ${variants.size} stream(s) for $tmdbId ($label, $container, ${mirror.api})")
        return variants.mapIndexed { i, (url, quality) ->
            DeviceRow(
                Resolved(
                    provider = PROVIDER, label = "showsst · $label", url = url, headers = headers, segmentToken = null,
                    audio = emptyList(), levels = emptyList(),
                    codecs = null, key = "$PROVIDER-$i-$quality", subtitles = subtitles, languages = emptyList(),
                ),
                progressive = container != "hls",
                quality = quality,
            )
        }
    }

    /** "hls", "mp4" or "mkv": by extension, else 16 bytes from the host, else [fallback]. */
    internal suspend fun probeContainer(url: String, headers: Map<String, String>, fallback: String): String {
        if (Regex("""\.m3u8(\?|$)""", RegexOption.IGNORE_CASE).containsMatchIn(url)) return "hls"
        if (Regex("""\.(mp4|mkv)(\?|$)""", RegexOption.IGNORE_CASE).containsMatchIn(url)) return "mp4"
        try {
            val b = Request.Builder().url(url).header("Range", "bytes=0-15")
            headers.forEach { (k, v) -> b.header(k, v) }
            val r = probeHttp.fetch(b.build(), asBytes = true)
            val type = (r.headers["Content-Type"] ?: "").lowercase()
            val head = (r.bytes ?: ByteArray(0)).copyOf(minOf(16, r.bytes?.size ?: 0))
            val text = String(head, Charsets.ISO_8859_1)
            if (text.startsWith("#EXTM3U") || "mpegurl" in type) return "hls"
            if ((text.length >= 8 && text.substring(4, 8) == "ftyp") || "video/mp4" in type) return "mp4"
            if ("matroska" in type || "x-mkv" in type) return "mkv"
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            log("container probe failed: ${e.message}; assuming $fallback")
        }
        return fallback
    }

    private fun apiRequest(m: Mirror, path: String): Request = Request.Builder().url(m.api + path)
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Origin", m.player)
        .header("Referer", "${m.player}/")
        .header("Sec-Fetch-Site", "same-site")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Dest", "empty")
        .header("sec-ch-ua", "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"")
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "\"macOS\"")
        .header("priority", "u=1, i")
        .build()

    private fun str(o: JsonObject, k: String): String? = (o[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun log(m: String) = runCatching { android.util.Log.i("Chitram", "showsst: $m") }

    companion object {
        const val PROVIDER = "showsst"
        const val UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
        // Same order as providers/showsst.js MIRRORS (vidqueen first, vidmario next).
        val MIRRORS = listOf(
            Mirror("https://api.vidqueen.st", "https://player.vidqueen.st"),
            Mirror("https://api.vidmario.net", "https://player.vidmario.net"),
        )
        /** 1.2.67: both mirrors plus the container probe fit the 15 s device budget (2 x 5.5 s + 3.5 s). */
        internal const val STEP_TIMEOUT_MS = 5_500L
        internal const val PROBE_TIMEOUT_MS = 3_500L

        /** Headers for the stream host, as providers/showsst.js streamHeaders. */
        fun streamHeaders(player: String): Map<String, String> = mapOf("User-Agent" to UA, "Referer" to "$player/", "Origin" to player)
    }
}
