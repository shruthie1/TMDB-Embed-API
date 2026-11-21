package com.chitram.app.resolve

import com.chitram.app.data.Level
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * CastleTV, resolved on the device (port of providers/castletv.js). The chain:
 * security key, search by title spellings, strict title match, details (episode
 * and language tracks), then getVideo2 per language at resolutions 3/2/1. Every
 * answer is AES-128-CBC with key = iv = the first 16 bytes of
 * base64(secKey) + "T!BgJB".
 *
 * Languages that resolve to the same media file are one row naming each
 * language (the file is muxed: [TsAudioSwap] picks the viewer's track).
 * Preview clips and permission-denied answers are never rows.
 */
class CastleResolver(
    client: OkHttpClient,
    private val base: String = BASE,
) {
    private val http = client.newBuilder().callTimeout(STEP_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()

    /** null: Castle has no confident match. Throws when the chain failed. */
    suspend fun resolve(type: String, title: String, year: Int?, season: Int, episode: Int, preferred: String, alternates: List<String> = emptyList()): Resolved? {
        if (title.isBlank()) return null
        val series = type == "tv" || type == "series"
        val sec = securityKey()
        // Year guard for films only: a series row can carry a later season's date.
        val guardYear = if (series) null else year
        var rows: List<Row> = emptyList()
        var match: Row? = null
        // Next spelling while rows come back but none is the title: "Mirayi 2025"
        // returns 30 unrelated rows, "Mirayi" returns Castle's "Mirai" (live, 2026-11-21).
        for (kw in TitleMatch.spellings(title, year)) {
            val got = rows(search(sec, kw))
            if (got.isEmpty()) continue
            rows = got
            match = TitleMatch.find(got, title, alternates, guardYear, { it.year }) { it.title }
            if (match != null) break
        }
        if (rows.isEmpty()) return null.also { log("no search results for \"$title\"") }
        if (match == null) return null.also { log("no confident match for \"$title\" (saw: ${rows.take(6).joinToString(" | ") { it.title }})") }
        var details = unwrap(parse(details(sec, match.id)))
        var activeId = match.id
        val s = season.coerceAtLeast(1)
        val e = episode.coerceAtLeast(1)
        if (series) {
            val seasons = (details["seasons"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val entry = seasons.firstOrNull { num(it, "number") == s }
            if (seasons.isNotEmpty() && entry == null) return null.also { log("season $s missing") }
            val sid = entry?.let { str(it, "movieId") }
            if (sid != null && sid != match.id) { details = unwrap(parse(details(sec, sid))); activeId = sid }
        }
        val episodes = (details["episodes"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        val ep = if (series) episodes.firstOrNull { num(it, "number") == e } else episodes.firstOrNull()
        val episodeId = ep?.let { str(it, "id") } ?: return null.also { log("no episode $s/$e") }
        val tracks = (ep["tracks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map { t ->
            Track(str(t, "languageId") ?: str(t, "id"), str(t, "languageName") ?: str(t, "name") ?: str(t, "abbreviate"), (t["isDefault"] as? JsonPrimitive)?.booleanOrNull == true)
        }
        val hits = coroutineScope {
            tracks.filter { it.id != null }.flatMap { t ->
                RESOLUTIONS.map { res ->
                    async { runCatching { hitsOf(video(sec, activeId, episodeId, t.id, res), t.name ?: "Unknown", res) }.getOrDefault(emptyList()) }
                }
            }.awaitAll().flatten()
        }.ifEmpty {
            // One shared file: label it with the default track only, never claim the others.
            val name = (tracks.firstOrNull { it.default } ?: tracks.firstOrNull())?.name ?: "Unknown"
            coroutineScope {
                RESOLUTIONS.map { res -> async { runCatching { hitsOf(video(sec, activeId, episodeId, null, res), name, res) }.getOrDefault(emptyList()) } }
                    .awaitAll().flatten()
            }
        }
        val best = group(hits, preferred).firstOrNull() ?: return null.also { log("no playable video for \"$title\"") }
        log("${match.title}: ${best.quality} [${best.languages.joinToString("/")}] from ${hits.size} answers")
        val height = Regex("(\\d{3,4})p").find(best.quality)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        return Resolved(
            provider = "CastleTV",
            label = "CastleTV",
            url = best.url,
            headers = PLAYBACK_HEADERS,
            segmentToken = null,
            audio = best.languages.mapIndexed { i, l -> AudioTrack(null, l, i == 0) },
            levels = if (height > 0) listOf(Level(height = height, quality = best.quality)) else emptyList(),
            codecs = null,
            muxed = best.languages.size > 1,
        )
    }

    private class Track(val id: String?, val name: String?, val default: Boolean)

    private fun req(url: String) = Request.Builder().url(url).apply { API_HEADERS.forEach { (k, v) -> header(k, v) } }.header("Referer", base)

    private suspend fun cipher(r: Request, step: String): String {
        val reply = http.fetch(r)
        if (!reply.ok) throw StepException("castle $step", reply.code, "HTTP ${reply.code}")
        val text = reply.body.trim()
        if (text.isEmpty()) throw StepException("castle $step", reply.code, "empty body")
        return runCatching { ((Json.parseToJsonElement(text) as? JsonObject)?.get("data") as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim() }
            .getOrNull() ?: text
    }

    private suspend fun securityKey(): String {
        val reply = http.fetch(req("$base/v0.1/system/getSecurityKey/1?channel=$CHANNEL&clientType=$CLIENT&lang=$LANG").build())
        if (!reply.ok) throw StepException("castle key", reply.code, "HTTP ${reply.code}")
        val o = MappleResolver.obj(reply.body)
        if (o == null || num(o, "code") != 200) throw StepException("castle key", reply.code, "bad answer")
        return str(o, "data") ?: throw StepException("castle key", reply.code, "no key")
    }

    private suspend fun search(sec: String, keyword: String): String {
        val q = "channel=$CHANNEL&clientType=$CLIENT&keyword=${enc(keyword)}&lang=$LANG&mode=1&packageName=$PKG&page=1&size=30"
        return decrypt(cipher(req("$base/film-api/v1.1.0/movie/searchByKeyword?$q").build(), "search"), sec)
    }

    private suspend fun details(sec: String, id: String): String =
        decrypt(cipher(req("$base/film-api/v1.9.9/movie?channel=$CHANNEL&clientType=$CLIENT&lang=$LANG&movieId=$id&packageName=$PKG").build(), "details"), sec)

    private suspend fun video(sec: String, movieId: String, episodeId: String, languageId: String?, resolution: Int): JsonObject {
        val body = buildJsonObject {
            put("mode", "1"); put("appMarket", "GuanWang"); put("clientType", CLIENT); put("woolUser", "false")
            put("apkSignKey", "ED0955EB04E67A1D9F3305B95454FED485261475"); put("androidVersion", "13")
            put("movieId", movieId); put("episodeId", episodeId)
            if (languageId != null) put("languageId", languageId)
            put("isNewUser", "true"); put("resolution", resolution.toString()); put("packageName", PKG)
        }.toString().toRequestBody("application/json".toMediaType())
        val url = "$base/film-api/v2.0.1/movie/getVideo2?clientType=$CLIENT&packageName=$PKG&channel=$CHANNEL&lang=$LANG"
        return unwrap(parse(decrypt(cipher(req(url).post(body).build(), "video"), sec)))
    }

    /** `year` from publishTime (epoch ms, UTC); null when absent. */
    data class Row(val id: String, val title: String, val year: Int? = null)
    data class Hit(val lang: String, val url: String, val quality: String)
    data class Group(val url: String, val languages: List<String>, val quality: String)

    companion object {
        const val BASE = "https://api.hlowb.com"
        private const val PKG = "com.external.castle"
        private const val CHANNEL = "IndiaA"
        private const val CLIENT = "1"
        private const val LANG = "en-US"
        private const val STEP_TIMEOUT_MS = 12_000L
        private val RESOLUTIONS = listOf(3, 2, 1)
        private val KNOWN_HEIGHTS = setOf(240, 360, 480, 540, 576, 720, 1080, 1440, 2160)
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        private val API_HEADERS = mapOf(
            "User-Agent" to "okhttp/4.9.3",
            "Accept" to "application/json",
            "Accept-Language" to "en-US,en;q=0.9",
        )
        val PLAYBACK_HEADERS = mapOf(
            "User-Agent" to "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            "Accept-Language" to "en-US,en;q=0.9",
            "Sec-Fetch-Dest" to "video",
            "Sec-Fetch-Mode" to "no-cors",
            "Sec-Fetch-Site" to "cross-site",
        )

        private fun log(m: String) = android.util.Log.i("Chitram", "[castle] $m")
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

        fun decrypt(cipherText: String, secKey: String): String {
            val k = Base64.getDecoder().decode(secKey) + "T!BgJB".toByteArray()
            val key = k.copyOf(16)
            val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(key))
            return String(c.doFinal(Base64.getMimeDecoder().decode(cipherText)), Charsets.UTF_8)
        }

        /** Quotes 16+ digit numbers before parsing, like castleSafeParse: ids overflow a double. */
        fun parse(plain: String): JsonObject =
            json.parseToJsonElement(plain.replace(Regex("""([:{\[,]\s*)(\d{16,})"""), "$1\"$2\"")) as? JsonObject ?: JsonObject(emptyMap())

        private fun unwrap(o: JsonObject): JsonObject = o["data"] as? JsonObject ?: o

        private fun str(o: JsonObject, k: String): String? = (o[k] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        private fun num(o: JsonObject, k: String): Int? = (o[k] as? JsonPrimitive)?.let { it.intOrNull ?: it.contentOrNull?.toIntOrNull() }

        /** Search rows of a decrypted searchByKeyword answer. */
        fun rows(plain: String): List<Row> = (unwrap(parse(plain))["rows"] as? JsonArray).orEmpty().mapNotNull { el: JsonElement ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val id = str(o, "id") ?: str(o, "redirectId") ?: str(o, "redirectIdStr") ?: return@mapNotNull null
            val year = (o["publishTime"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()?.takeIf { it > 0 }
                ?.let { ms -> java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply { timeInMillis = ms }.get(java.util.Calendar.YEAR) }
            Row(id, str(o, "title") ?: str(o, "name") ?: "", year)
        }

        private fun isPreview(url: String) = Regex("""/index_preview_\d+\.m3u8""", RegexOption.IGNORE_CASE).containsMatchIn(url)

        private fun quality(url: String, description: String?, resNum: Int, resolution: Int): String {
            if (description != null) {
                Regex("""(?:SD|HD|FHD|UHD|4K)?\s*(\d{3,4})\s*p?""", RegexOption.IGNORE_CASE).find(description.trim())
                    ?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it in KNOWN_HEIGHTS }?.let { return "${it}p" }
                if (Regex("4k|uhd", RegexOption.IGNORE_CASE).containsMatchIn(description)) return "4K"
            }
            Regex("""/(\d{3,4})/[^/]*$""").find(url.substringBefore('?'))?.groupValues?.get(1)?.toIntOrNull()
                ?.takeIf { it in KNOWN_HEIGHTS }?.let { return "${it}p" }
            mapOf(1 to "480p", 2 to "720p", 3 to "1080p", 4 to "4K")[resNum]?.let { return it }
            return mapOf(1 to "480p", 2 to "720p", 3 to "1080p")[resolution] ?: "${resolution}p"
        }

        /** Playable files in one getVideo2 answer (buildCastleStreams). */
        internal fun hitsOf(data: JsonObject, lang: String, resolution: Int): List<Hit> {
            fun flag(k: String) = (data[k] as? JsonPrimitive)?.booleanOrNull == true
            if (flag("permissionDenied") || flag("isPreview")) return emptyList()
            val videos = (data["videos"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
            val videoUrl = str(data, "videoUrl")
            val urls = listOfNotNull(videoUrl) + videos.mapNotNull { str(it, "url") }
            if (urls.isEmpty() || urls.all(::isPreview)) return emptyList()
            val out = LinkedHashMap<String, Pair<Int, Hit>>()
            for (v in videos) {
                val u = str(v, "url") ?: continue
                val n = num(v, "resolution") ?: 0
                if ((out[u]?.first ?: -1) >= n) continue
                out[u] = n to Hit(lang, u, quality(u, str(v, "resolutionDescription"), n, resolution))
            }
            if (out.isEmpty() && videoUrl != null) return listOf(Hit(lang, videoUrl, quality(videoUrl, str(data, "resolutionDescription"), 0, resolution)))
            return out.values.map { it.second }
        }

        /** Castle signs URLs and rotates an index_N suffix: the path without it names the file. */
        fun mediaIdentity(url: String): String =
            url.substringBefore('?').replace(Regex("^https?://[^/]+", RegexOption.IGNORE_CASE), "").replace(Regex("_(\\d+)(\\.m3u8)$", RegexOption.IGNORE_CASE), "$2")

        private fun height(q: String) = if (q.equals("4K", true)) 2160 else Regex("(\\d{3,4})").find(q)?.value?.toIntOrNull() ?: 0

        /**
         * One row per distinct file, naming every language it serves (preferred
         * first). Rows with the preferred language come first, then by quality.
         */
        fun group(hits: List<Hit>, preferred: String): List<Group> {
            val by = LinkedHashMap<String, Pair<Hit, MutableList<String>>>()
            for (h in hits) {
                val e = by.getOrPut(mediaIdentity(h.url)) { h to mutableListOf() }
                if (e.second.none { it.equals(h.lang, true) || com.chitram.app.data.Ranking.sameLanguage(it, h.lang) }) e.second += h.lang
            }
            return by.values.map { (h, langs) ->
                Group(h.url, langs.sortedBy { if (com.chitram.app.data.Ranking.sameLanguage(it, preferred)) 0 else 1 }, h.quality)
            }.sortedWith(compareBy<Group> { g -> if (g.languages.any { com.chitram.app.data.Ranking.sameLanguage(it, preferred) }) 0 else 1 }.thenByDescending { height(it.quality) })
        }
    }
}
