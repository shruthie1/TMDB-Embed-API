package com.chitram.app.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** Tiny key-value seam so the stores run in plain JUnit. */
interface KeyValue {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

class PrefsKeyValue(context: Context) : KeyValue {
    private val sp = context.getSharedPreferences("chitram", Context.MODE_PRIVATE)
    override fun get(key: String): String? = sp.getString(key, null)
    override fun put(key: String, value: String?) {
        sp.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

class MemoryKeyValue : KeyValue {
    val map = HashMap<String, String>()
    override fun get(key: String) = map[key]
    override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
}

private val storeJson = Json { ignoreUnknownKeys = true; encodeDefaults = true }

/** Port of web/lib/prefs.js. */
class LanguagePrefs(private val kv: KeyValue) {
    data class Lang(val code: String, val label: String)

    companion object {
        const val KEY = "prefs:v1"
        val LANGS = listOf(
            Lang("te", "Telugu"), Lang("ta", "Tamil"), Lang("hi", "Hindi"),
            Lang("ml", "Malayalam"), Lang("kn", "Kannada"),
        )
        private val CODES = LANGS.map { it.code }.toSet()
        fun label(code: String) = LANGS.firstOrNull { it.code == code }?.label ?: code

        /** Keep known codes, in the given order, without repeats. */
        fun clean(list: List<String>): List<String> {
            val out = ArrayList<String>()
            for (c in list) {
                val code = c.trim().lowercase()
                if (code in CODES && code !in out) out += code
            }
            return out
        }
    }

    /** True once the viewer picked or skipped on first run. */
    fun hasPrefs(): Boolean = kv.get(KEY) != null

    /** The chosen codes. Empty = skipped. */
    fun langs(): List<String> = kv.get(KEY)?.split(',')?.let { clean(it) } ?: emptyList()

    fun save(langs: List<String>) { kv.put(KEY, clean(langs).joinToString(",")) }

    /** The languages rows and search use: the choice, or all of them. */
    fun effective(): List<String> = langs().ifEmpty { LANGS.map { it.code } }

    /**
     * The audio language the source ranking prefers. Telugu is the standing
     * requirement (web PREFERRED_LANGUAGE default), so it wins unless the viewer
     * chose languages that exclude it; then their first choice.
     */
    fun preferredAudio(): String {
        val l = langs()
        if (l.isEmpty() || "te" in l) return "Telugu"
        return label(l.first())
    }

    fun query(): String = "langs=" + effective().joinToString(",")
}

@Serializable
data class Progress(
    val mediaType: String,
    val tmdbId: Long,
    val season: Int = 0,
    val episode: Int = 0,
    val positionMs: Long,
    val durationMs: Long,
    val finished: Boolean = false,
    val title: String = "",
    val poster: String? = null,
    val backdrop: String? = null,
    val epTitle: String? = null,
    val updatedAt: Long = 0,
    /** Show or film overview, for the TV hero on Continue watching. */
    val overview: String? = null,
) {
    val pct: Float get() = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else 0f
}

/** Port of web/lib/progress.js (resume + continue watching). */
class ProgressStore(private val kv: KeyValue, private val now: () -> Long = System::currentTimeMillis) {
    private val ser = MapSerializer(String.serializer(), Progress.serializer())
    private val KEY = "progress:v1"
    private fun id(t: String, id: Long, s: Int, e: Int) = "$t:$id:$s:$e"

    private fun read(): MutableMap<String, Progress> =
        kv.get(KEY)?.let { runCatching { storeJson.decodeFromString(ser, it).toMutableMap() }.getOrNull() } ?: mutableMapOf()

    private fun write(m: Map<String, Progress>) {
        // Bound the store: keep the 200 most recent entries.
        val trimmed = if (m.size > 200) m.entries.sortedByDescending { it.value.updatedAt }.take(200).associate { it.toPair() } else m
        kv.put(KEY, storeJson.encodeToString(ser, trimmed))
    }

    fun save(p: Progress) {
        if (p.durationMs <= 0 || p.positionMs < 0) return
        val finished = p.positionMs >= minOf(p.durationMs - 30_000, (p.durationMs * 0.95).toLong())
        val all = read()
        all[id(p.mediaType, p.tmdbId, p.season, p.episode)] = p.copy(finished = finished, updatedAt = now())
        write(all)
    }

    fun get(mediaType: String, tmdbId: Long, season: Int = 0, episode: Int = 0): Progress? =
        read()[id(mediaType, tmdbId, season, episode)]

    /** Position to resume from, or 0 when unwatched or finished. */
    fun resumeMs(mediaType: String, tmdbId: Long, season: Int = 0, episode: Int = 0): Long {
        val p = get(mediaType, tmdbId, season, episode) ?: return 0
        return if (p.finished) 0 else p.positionMs
    }

    fun showProgress(tmdbId: Long): List<Progress> =
        read().values.filter { it.mediaType == "tv" && it.tmdbId == tmdbId }.sortedByDescending { it.updatedAt }

    /**
     * What to play next for a show: the last episode if unfinished, else the
     * following one (crossing into the next season when counts are known).
     * null when nothing watched or the series ended.
     */
    fun nextUp(tmdbId: Long, seasons: List<SeasonInfo>? = null): Progress? {
        val last = showProgress(tmdbId).firstOrNull() ?: return null
        if (!last.finished) return last
        var season = last.season
        var episode = last.episode + 1
        if (!seasons.isNullOrEmpty()) {
            val count = seasons.firstOrNull { it.number == last.season }?.episodes ?: 0
            if (count > 0 && episode > count) {
                val next = seasons.firstOrNull { it.number == last.season + 1 } ?: return null
                season = next.number
                episode = 1
            }
        }
        return last.copy(season = season, episode = episode, positionMs = 0, durationMs = 0, finished = false, epTitle = null)
    }

    fun continueWatching(limit: Int = 12): List<Progress> {
        val all = read().values
        val movies = all.filter { it.mediaType != "tv" && !it.finished && it.positionMs > 0 }
        val shows = all.filter { it.mediaType == "tv" }.groupBy { it.tmdbId }
            .mapNotNull { (id, list) ->
                val updated = list.maxOf { it.updatedAt }
                nextUp(id)?.copy(updatedAt = updated)
            }
        return (movies + shows).sortedByDescending { it.updatedAt }.take(limit)
    }

    /**
     * "Because you watched" seeds (web getSeeds): titles watched 25% or more,
     * or finished, newest first, one entry per title.
     */
    fun seeds(limit: Int = 3): List<Progress> = read().values
        .filter { it.finished || it.pct >= 0.25f }
        .groupBy { "${it.mediaType}:${it.tmdbId}" }
        .map { (_, l) -> l.maxBy { it.updatedAt } }
        .sortedByDescending { it.updatedAt }
        .take(limit)

    fun remove(mediaType: String, tmdbId: Long) {
        val all = read()
        all.entries.removeAll { it.value.mediaType == mediaType && it.value.tmdbId == tmdbId }
        write(all)
    }
}

/** Port of web/lib/list.js (My List). */
class MyListStore(private val kv: KeyValue, private val now: () -> Long = System::currentTimeMillis) {
    @Serializable
    data class Entry(val title: Title, val addedAt: Long)

    private val ser = MapSerializer(String.serializer(), Entry.serializer())
    private val KEY = "list:v1"
    private fun read(): MutableMap<String, Entry> =
        kv.get(KEY)?.let { runCatching { storeJson.decodeFromString(ser, it).toMutableMap() }.getOrNull() } ?: mutableMapOf()

    fun contains(t: Title) = read().containsKey(t.key)

    /** Returns true when the title is now in the list. */
    fun toggle(t: Title): Boolean {
        val all = read()
        val added = if (all.remove(t.key) != null) false else { all[t.key] = Entry(t, now()); true }
        kv.put(KEY, storeJson.encodeToString(ser, all))
        return added
    }

    fun all(limit: Int = 60): List<Title> = read().values.sortedByDescending { it.addedAt }.take(limit).map { it.title }
}

/** Last provider that played each title: a preference, never a filter. */
class LastProviderStore(private val kv: KeyValue) {
    fun get(type: String, id: Long): String? = kv.get("lastProvider:$type:$id")
    fun put(type: String, id: Long, provider: String) = kv.put("lastProvider:$type:$id", provider)
}

/** How the picture fills the screen (web Player.jsx fit: contain / cover / fill). */
enum class VideoFit(val label: String) {
    Fit("Fit"),         // whole picture, bars where the shapes differ
    Fill("Fill"),       // fill the screen, crop the overflow
    Stretch("Stretch"); // fill the screen, distort

    fun next(): VideoFit = entries[(ordinal + 1) % entries.size]

    companion object {
        fun parse(s: String?): VideoFit? = entries.firstOrNull { it.name == s }
    }
}

/** Player choices kept across sessions. */
class PlayerPrefs(private val kv: KeyValue) {
    companion object { const val FIT = "player:fit" }
    /** The viewer's last choice, or null before they pick one. */
    var fit: VideoFit?
        get() = VideoFit.parse(kv.get(FIT))
        set(v) = kv.put(FIT, v?.name)

    /**
     * Phones and TVs default to Fill: the picture opens filling the screen
     * (crop to fill). A stored choice from the phone Fit control still wins.
     */
    @Suppress("UNUSED_PARAMETER")
    fun fitFor(isTv: Boolean): VideoFit = fit ?: VideoFit.Fill
}
