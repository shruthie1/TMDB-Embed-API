package com.chitram.app.resolve

import com.chitram.app.data.SubtitleRef
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URLEncoder
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * OneTouchTV on the device (port of providers/onetouchtv.js). The chain: search
 * by title spellings, strict title match, a cross-check that the matched title
 * is this TMDB title, detail (episode list), episode (sources + subtitles).
 * Every answer is AES-256-CBC text with the same fixed key/iv as the server.
 *
 * Measured 2026-11-21 from a Jio IP with no headers at all: search, detail and
 * episode 200, CORS `*`. The stream CDN (hitv.ltd) refuses a foreign Referer,
 * so rows carry the server's stream headers (User-Agent only).
 *
 * No language is claimed: the upstream has no audio metadata (one flat media
 * playlist; `track[]` is subtitles only).
 */
class OneTouchTvResolver(
    client: OkHttpClient,
    private val base: String = BASE,
    private val cinemeta: String = CINEMETA,
    private val notFoundRetryMs: Long = 1_000,
    private val retryDelayMs: Long = 400,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val http = client.newBuilder().callTimeout(STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private class Good(val rows: List<DeviceRow>, val until: Long)
    private val lastGood = ConcurrentHashMap<String, Good>()

    /**
     * Rows for one title. [verify] maps the matched OneTouchTV title (and its
     * year) to a TMDB id; a different id rejects the match, null passes (the
     * server's tmdbTitleToImdbId contract: inconclusive never rejects).
     * Empty: not on OneTouchTV. Throws when the upstream failed.
     */
    suspend fun resolveAll(
        type: String, tmdbId: Long, title: String, year: Int?, imdbId: String?, season: Int, episode: Int,
        verify: suspend (title: String, year: Int?, series: Boolean) -> Long? = { _, _, _ -> null },
    ): List<DeviceRow> {
        val key = "$type:$tmdbId:$season:$episode"
        return try {
            resolveOnce(type, tmdbId, title, year, imdbId, season, episode, verify).also { remember(key, it) }
        } catch (e: StepException) {
            if (e.code != 404) throw e
            // api3.devcorp.me answers 200, then 404 on the same URL minutes later
            // (prod 2026-11-20). The rows it gave stay playable until they expire.
            lastGood(key)?.let { return it.also { log("last-good served for $key after HTTP 404 (${it.size} rows)") } }
            log("HTTP 404 for $key, no last-good; retrying once in ${notFoundRetryMs}ms")
            delay(notFoundRetryMs)
            resolveOnce(type, tmdbId, title, year, imdbId, season, episode, verify).also { remember(key, it) }
        }
    }

    private suspend fun resolveOnce(
        type: String, tmdbId: Long, title: String, year: Int?, imdbId: String?, season: Int, episode: Int,
        verify: suspend (String, Int?, Boolean) -> Long?,
    ): List<DeviceRow> {
        if (title.isBlank()) return emptyList()
        val series = type == "tv" || type == "series"
        val s = season.coerceAtLeast(1)
        val e = episode.coerceAtLeast(1)
        val keywords = TitleMatch.spellings(title).toMutableList()
        if (series && s > 1) keywords.add(0, "$title Season $s")

        var match: Hit? = null
        for (kw in keywords) {
            val rows = search(kw)
            val searchYear = if (kw != title && s > 1) null else year
            match = best(rows, kw, searchYear, series)
            if (match != null) break
        }
        if (match == null) return emptyList<DeviceRow>().also { log("\"$title\" not found") }

        val resolved = try { splitTitleYear(match.title).let { (t, y) -> verify(t, match.year ?: y, series) } } catch (x: Exception) {
            if (x is kotlinx.coroutines.CancellationException) throw x
            null
        }
        if (resolved != null && resolved != tmdbId) return emptyList<DeviceRow>().also { log("TMDB id mismatch, rejecting \"${match.title}\": expected $tmdbId, resolved $resolved") }

        val detail = call("/vod/${enc(match.id)}/detail") as? JsonObject
        val episodes = (detail?.get("episodes") as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        if (episodes.isEmpty()) return emptyList<DeviceRow>().also { log("no episodes in detail for \"${match.title}\"") }

        val target: JsonObject? = if (!series) episodes.first() else {
            val num = Regex("""\bseason\s+(\d+)\b""", RegexOption.IGNORE_CASE).find(match.title)?.groupValues?.get(1)?.toIntOrNull()
            if (s > 1 && num != null && num != s) return emptyList<DeviceRow>().also { log("matched title names a different season") }
            val forTarget = s == 1 || Regex("""\bseason\s+$s\b""", RegexOption.IGNORE_CASE).containsMatchIn(match.title)
            if (forTarget) episodes.firstOrNull { epNum(it) == e } else {
                val abs = if (imdbId != null) absoluteEpisode(imdbId, s, e) else null
                abs?.let { a -> episodes.firstOrNull { epNum(it) == a } }
            }
        }
        if (target == null) return emptyList<DeviceRow>().also { log("episode not found (S${s}E$e)") }
        val playId = str(target, "playId") ?: return emptyList()

        val stream = call("/vod/${enc(match.id)}/episode/${enc(playId)}", retry = true) as? JsonObject ?: return emptyList()
        val sources = (stream["sources"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        if (sources.isEmpty()) return emptyList<DeviceRow>().also { log("no sources in episode for \"${match.title}\"") }
        val subtitles = (stream["track"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { t ->
            val f = str(t, "file"); val n = str(t, "name")
            if (f != null && n != null) SubtitleRef(f, n) else null
        }
        val seen = HashSet<String>()
        val out = sources.mapNotNull { src ->
            val url = str(src, "url") ?: return@mapNotNull null
            if (!seen.add(url)) return@mapNotNull null
            val quality = quality(str(src, "quality"))
            val rawType = str(src, "type")
            val container = if ((rawType ?: "hls").lowercase() == "hls") "hls" else rawType!!.lowercase()
            DeviceRow(
                Resolved(
                    provider = PROVIDER, label = "${match.title}\n$quality · ${(rawType ?: "HLS").uppercase()}", url = url,
                    headers = STREAM_HEADERS, segmentToken = null, audio = emptyList(), levels = emptyList(), codecs = null,
                    key = "$PROVIDER-${seen.size - 1}", subtitles = subtitles, languages = emptyList(),
                ),
                progressive = container != "hls",
                quality = quality,
            )
        }
        log("got ${out.size} stream(s) for \"${match.title}\"")
        return out
    }

    private data class Hit(val id: String, val title: String, val year: Int?, val type: String)

    /** findBestOttMatch: type filter, then the shared strict title match with the server's exact-year rule. */
    private fun best(rows: List<Hit>, keyword: String, year: Int?, series: Boolean): Hit? {
        val allowed = if (series) setOf("drama", "variety", "anime") else setOf("movie")
        val typed = rows.filter { it.type.lowercase() in allowed }
            // "RRR (2022)": a stated title year more than one off the wanted year rejects the row.
            .filter { h -> val y = splitTitleYear(h.title).second; y == null || year == null || kotlin.math.abs(y - year) <= 1 }
        if (typed.isEmpty()) return null
        // findTitleMatch: a year mismatch rejects when both sides state one; no survivor keeps all.
        val sameYear = if (year == null) typed else typed.filter { it.year == null || it.year == year }
        // The trailing "(YYYY)" is not part of the title (a title under 4 letters must match exactly).
        return TitleMatch.find(sameYear.ifEmpty { typed }, keyword) { splitTitleYear(it.title).first }
    }

    /** A search 404 is "no such keyword" (the endpoint 404s some spellings): empty, next spelling. */
    private suspend fun search(keyword: String): List<Hit> {
        val result = try { call("/vod/search?keyword=${enc(keyword)}", retry = true) } catch (e: StepException) {
            if (e.code == 404) return emptyList()
            throw e
        }
        return (result as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { o ->
            val id = str(o, "id") ?: return@mapNotNull null
            Hit(id, str(o, "title") ?: "", str(o, "year")?.take(4)?.toIntOrNull(), str(o, "type") ?: "")
        }
    }

    /**
     * One API call, decrypted, `.result`. Network errors, timeouts and 5xx are
     * retried twice (400 ms, 800 ms); a 4xx is the origin's answer.
     */
    private suspend fun call(path: String, retry: Boolean = true): JsonElement? {
        var last: Exception? = null
        for (attempt in 0..(if (retry) RETRIES else 0)) {
            try {
                val r = http.fetch(Request.Builder().url(base + path).header("User-Agent", API_UA).header("Referer", "https://onetouchtv.xyz/").build())
                if (!r.ok) throw StepException("onetouchtv", r.code, "HTTP ${r.code} from $path")
                return (json.parseToJsonElement(decrypt(r.body)) as? JsonObject)?.get("result")
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                last = e
                val code = (e as? StepException)?.code ?: 0
                if (code in 400..499) break
                if (attempt < RETRIES) delay(retryDelayMs * (attempt + 1))
            }
        }
        throw last ?: StepException("onetouchtv", 0, "no answer from $path")
    }

    /** Episodes before [season], from Cinemeta, plus [episode]. Null when any earlier season is unknown. */
    private suspend fun absoluteEpisode(imdbId: String, season: Int, episode: Int): Int? {
        if (season <= 1) return episode
        val counts = try {
            val r = http.fetch(Request.Builder().url("$cinemeta/meta/series/$imdbId.json").header("User-Agent", "Stremio Addon").build())
            if (!r.ok) return null
            val videos = ((json.parseToJsonElement(r.body) as? JsonObject)?.get("meta") as? JsonObject)?.get("videos") as? JsonArray
            val max = HashMap<Int, Int>()
            videos.orEmpty().mapNotNull { it as? JsonObject }.forEach { v ->
                val sn = (v["season"] as? JsonPrimitive)?.intOrNull ?: 0
                val ep = (v["number"] as? JsonPrimitive)?.intOrNull ?: (v["episode"] as? JsonPrimitive)?.intOrNull ?: 0
                if (sn > 0 && ep > 0) max[sn] = maxOf(max[sn] ?: 0, ep)
            }
            max
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            return null
        }
        var offset = 0
        for (sn in 1 until season) offset += counts[sn]?.takeIf { it > 0 } ?: return null
        return offset + episode
    }

    private fun remember(key: String, rows: List<DeviceRow>) {
        if (rows.isEmpty()) return
        // Capped by the earliest `expires=`/`exp=` epoch in the urls (lib/urlExpiry.js).
        val expiry = rows.mapNotNull { expiryOf(it.resolved.url) }.minOrNull()
        lastGood[key] = Good(rows, minOf(now() + LAST_GOOD_TTL_MS, expiry ?: Long.MAX_VALUE))
    }

    private fun lastGood(key: String): List<DeviceRow>? {
        val g = lastGood[key] ?: return null
        if (now() >= g.until) { lastGood.remove(key); return null }
        return g.rows
    }

    private fun epNum(o: JsonObject): Int? = str(o, "episode")?.toIntOrNull()
    private fun str(o: JsonObject, k: String): String? = (o[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    private fun enc(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")
    private fun log(m: String) = runCatching { android.util.Log.i("Chitram", "onetouchtv: $m") }

    companion object {
        const val PROVIDER = "OneTouchTV"
        const val BASE = "https://api3.devcorp.me"
        const val CINEMETA = "https://v3-cinemeta.strem.io"
        private val TITLE_YEAR = Regex("""^(.*\S)\s+\((\d{4})\)\s*$""")
        /** "RRR (2022)" -> ("RRR", 2022); no trailing "(YYYY)" -> (title, null). Same as providers/onetouchtv.js. */
        internal fun splitTitleYear(t: String): Pair<String, Int?> =
            TITLE_YEAR.find(t)?.let { it.groupValues[1] to it.groupValues[2].toInt() } ?: (t to null)
        private const val API_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        /** No Referer: the hitv.ltd CDN 403s a foreign Referer (providers/onetouchtv.js STREAM_HEADERS). */
        val STREAM_HEADERS = mapOf("User-Agent" to "Mozilla/5.0")
        private const val STEP_TIMEOUT_MS = 15_000L
        private const val RETRIES = 2
        private const val LAST_GOOD_TTL_MS = 30 * 60 * 1000L
        private val KEY = "im72charPasswordofdInitVectorStm".toByteArray()
        private val IV = "im72charPassword".toByteArray()

        /** The server's decrypt: `-_.` to `/`, `@` to `+`, no whitespace, padded base64, AES-256-CBC. */
        fun decrypt(encoded: String): String {
            var s = encoded.replace("-_.", "/").replace("@", "+").replace(Regex("\\s+"), "")
            if (s.length % 4 != 0) s += "=".repeat(4 - s.length % 4)
            val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(KEY, "AES"), IvParameterSpec(IV))
            return String(c.doFinal(Base64.getDecoder().decode(s)), Charsets.UTF_8)
        }

        /** Test helper: the inverse of [decrypt] in the upstream's alphabet. */
        internal fun encrypt(plain: String): String {
            val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(KEY, "AES"), IvParameterSpec(IV))
            return Base64.getEncoder().encodeToString(c.doFinal(plain.toByteArray())).replace("/", "-_.").replace("+", "@").trimEnd('=')
        }

        /** resolveQuality in providers/onetouchtv.js. */
        fun quality(q: String?): String {
            val v = q?.lowercase() ?: return "Auto"
            return when {
                v == "auto" -> "Auto"
                "2160" in v || "4k" in v || "uhd" in v -> "2160p"
                "1440" in v -> "1440p"
                "1080" in v -> "1080p"
                "720" in v -> "720p"
                "480" in v -> "480p"
                "360" in v -> "360p"
                else -> "Auto"
            }
        }

        internal fun expiryOf(url: String): Long? =
            Regex("""[?&_=](?:expires|exp)=(\d{10})""").find(url)?.groupValues?.get(1)?.toLongOrNull()?.times(1000)
    }
}
