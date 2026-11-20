package com.chitram.app.player

import com.chitram.app.data.Api
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Subtitles from Stremio's OpenSubtitles addon (port of web/lib/subtitles.js).
 *
 * Provider streams carry no subtitle tracks, so captions come from this
 * catalogue: no key, no account, 24-99 files per title including Indian films.
 * The web lists English only; the APK puts Telugu first, then English.
 *
 * Not a VM call, but the same rule holds: a short timeout and an empty list
 * on any failure, so playback never waits on or breaks because of captions.
 */
object OpenSubs {
    const val BASE = "https://opensubtitles-v3.strem.io"
    const val TIMEOUT_MS = 8_000L
    private const val MAX_TELUGU = 3
    private const val MAX_ENGLISH = 6

    /** `lang` is the ISO-639-1 code the player gets ("te", "en"). */
    data class Track(val url: String, val lang: String, val label: String)

    @Serializable
    private data class Raw(
        val url: String = "",
        val lang: String = "",
        val subtitleFileName: String? = null,
        val movieReleaseName: String? = null,
        val releaseFormat: String? = null,
        val fpsMilli: Int? = null,
    )

    @Serializable
    private data class Response(val subtitles: List<Raw> = emptyList())

    private val IMDB = Regex("""^tt\d{6,}$""")
    private val TELUGU = setOf("tel", "te")
    private val ENGLISH = setOf("eng", "en", "eng-us", "eng-gb")
    private val SPLIT_PART = Regex("""\bCD\s?\d\b|\bpart\s?\d\b|\bdisc\s?\d\b""", RegexOption.IGNORE_CASE)
    private val CAM_SOURCE = Regex("""\b(TS|TELESYNC|CAM|HDCAM|TC|TELECINE)\b""", RegexOption.IGNORE_CASE)
    private val NOT_FILM = Regex("""\b(song|lyric|trailer|teaser|sample|preview)\b""")

    fun path(imdbId: String?, season: Int, episode: Int): String? {
        if (imdbId == null || !IMDB.matches(imdbId)) return null
        return if (season > 0 && episode > 0) "/subtitles/series/$imdbId:$season:$episode.json" else "/subtitles/movie/$imdbId.json"
    }

    /** web isWrongCut: a split part or a cam source cannot match the feature. */
    private fun wrongCut(s: Raw): Boolean {
        val blob = listOfNotNull(s.subtitleFileName, s.movieReleaseName, s.releaseFormat).joinToString(" ")
        return SPLIT_PART.containsMatchIn(blob) || CAM_SOURCE.containsMatchIn(blob)
    }

    private fun name(s: Raw) = "${s.subtitleFileName ?: ""} ${s.movieReleaseName ?: ""}"

    /** web reliability: framerate and release type are the sync signal before download. */
    private fun reliability(s: Raw, runtimeMin: Int?): Int {
        val n = name(s).lowercase()
        var score = 0
        if (NOT_FILM.containsMatchIn(n)) score -= 100
        if (s.fpsMilli == 24000 || s.fpsMilli == 23976) score += 30 else if (s.fpsMilli == 25000) score -= 20
        if (Regex("""blu-?ray|web-?dl|bdrip""").containsMatchIn(n)) score += 12
        else if (Regex("""webrip|hdrip|amzn|nf\b""").containsMatchIn(n)) score += 8
        if (s.movieReleaseName != null) score += 2
        val stamp = Regex("""(\d)h(\d{2})m""").find(n)
        if (stamp != null && runtimeMin != null && runtimeMin > 0) {
            val mins = stamp.groupValues[1].toInt() * 60 + stamp.groupValues[2].toInt()
            val drift = kotlin.math.abs(mins - runtimeMin)
            if (drift <= 3) score += 25 else if (drift > 10) score -= 15
        }
        return score
    }

    /** web variantLabel, for any language: "English (Blu-ray)", "Telugu · alternate 1". */
    private fun variantLabel(s: Raw, language: String, index: Int): String {
        val n = name(s)
        fun has(p: String) = Regex(p, RegexOption.IGNORE_CASE).containsMatchIn(n)
        val src = when {
            has("""blu-?ray|bdrip|brrip""") -> "Blu-ray"
            has("""web-?dl|webrip|amzn|nf\b|zee5|hotstar""") -> "WEB-DL"
            has("""hdrip|dvdrip|dvd""") -> "DVD/HD"
            has("""hdtv""") -> "HDTV"
            else -> null
        }
        val cut = when {
            has("extended") -> "Extended"
            has("theatrical") -> "Theatrical"
            has("director") -> "Director's cut"
            else -> null
        }
        val hi = if (has("""\bsdh\b|hearing.?impaired|\bhi\b(?![a-z])""")) "SDH" else null
        val res = when {
            has("""2160p|\b4k\b|uhd""") -> "2160p"
            has("1080p") -> "1080p"
            has("720p") -> "720p"
            else -> null
        }
        val bits = listOfNotNull(cut, src ?: res, hi)
        return when {
            bits.isNotEmpty() -> "$language (${bits.joinToString(" · ")})"
            index == 0 -> language
            else -> "$language · alternate $index"
        }
    }

    private fun bestOf(all: List<Raw>, codes: Set<String>, language: String, iso: String, runtimeMin: Int?, max: Int): List<Track> {
        val ranked = all.filter { it.url.isNotEmpty() && it.lang.lowercase() in codes && !wrongCut(it) }
            .map { it to reliability(it, runtimeMin) }
            // A song or trailer file is not the film (RRR's only Telugu file is a song).
            .filter { it.second > -100 }
            .sortedByDescending { it.second }
        val out = ArrayList<Track>()
        for ((raw, _) in ranked) {
            val label = variantLabel(raw, language, out.size)
            if (out.any { it.label == label }) continue
            out += Track(raw.url, iso, label)
            if (out.size >= max) break
        }
        return out
    }

    /** Telugu tracks first, then English, best first inside each. Empty on bad input. */
    fun pick(json: String, runtimeMin: Int?): List<Track> {
        val all = try { Api.json.decodeFromString(Response.serializer(), json).subtitles } catch (_: Exception) { return emptyList() }
        return bestOf(all, TELUGU, "Telugu", "te", runtimeMin, MAX_TELUGU) + bestOf(all, ENGLISH, "English", "en", runtimeMin, MAX_ENGLISH)
    }

    /** Never throws; empty list when the addon is slow, down or has nothing. */
    suspend fun fetch(client: OkHttpClient, imdbId: String?, season: Int, episode: Int, runtimeMin: Int?, base: String = BASE): List<Track> {
        val p = path(imdbId, season, episode) ?: return emptyList()
        return try {
            withTimeoutOrNull(TIMEOUT_MS) {
                withContext(Dispatchers.IO) {
                    val c = client.newBuilder().callTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS).build()
                    c.newCall(Request.Builder().url(base + p).build()).execute().use { r ->
                        if (!r.isSuccessful) emptyList() else pick(r.body?.string().orEmpty(), runtimeMin)
                    }
                }
            } ?: emptyList()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            android.util.Log.i("Chitram", "[subs] none: ${e.javaClass.simpleName}")
            emptyList()
        }
    }
}
