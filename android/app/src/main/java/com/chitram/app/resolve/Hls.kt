package com.chitram.app.resolve

import com.chitram.app.data.Level
import java.util.Locale

/** One EXT-X-MEDIA audio rendition, in master order. */
data class AudioTrack(val language: String?, val name: String?, val isDefault: Boolean) {
    /** "Telugu" for te/tel, else the rendition NAME. null when neither says anything. */
    val label: String? get() = Hls.languageLabel(language) ?: name?.takeUnless { it.isBlank() || it.equals("audio", true) }
}

data class Master(
    val isMaster: Boolean,
    val audio: List<AudioTrack>,
    val levels: List<Level>,
    val codecs: String?,
    /** First variant playlist (absolute), or null for a media playlist. */
    val firstVariant: String?,
) {
    /** Neither a variant nor a segment: mapple's 8-byte "#EXTM3U" dead row. */
    val empty: Boolean get() = !isMaster && levels.isEmpty() && firstVariant == null
}

object Hls {
    private val ATTR = Regex("""([A-Z0-9-]+)=("[^"]*"|[^,]*)""")

    fun attrs(line: String): Map<String, String> =
        ATTR.findAll(line.substringAfter(':')).associate { it.groupValues[1] to it.groupValues[2].trim('"') }

    fun resolve(uri: String, base: String): String = resolveAgainst(base, uri) ?: uri

    fun parse(text: String, base: String): Master {
        val lines = text.lines().map { it.trim() }
        val audio = ArrayList<AudioTrack>()
        val levels = ArrayList<Level>()
        var codecs: String? = null
        var firstVariant: String? = null
        var isMaster = false
        var hasSegments = false
        var pendingInf: Map<String, String>? = null
        for (l in lines) {
            when {
                l.startsWith("#EXT-X-MEDIA:") -> {
                    val a = attrs(l)
                    if (a["TYPE"] == "AUDIO") audio += AudioTrack(a["LANGUAGE"], a["NAME"], a["DEFAULT"] == "YES")
                }
                l.startsWith("#EXT-X-STREAM-INF:") -> { isMaster = true; pendingInf = attrs(l) }
                l.startsWith("#EXTINF") -> hasSegments = true
                l.isNotEmpty() && !l.startsWith("#") && pendingInf != null -> {
                    val a = pendingInf!!
                    pendingInf = null
                    if (firstVariant == null) firstVariant = resolve(l, base)
                    if (codecs == null) codecs = a["CODECS"]
                    val h = a["RESOLUTION"]?.substringAfter('x', "")?.toIntOrNull() ?: 0
                    if (h > 0) levels += Level(height = h, quality = "${h}p", bandwidth = a["BANDWIDTH"]?.toLongOrNull() ?: 0, codecs = a["CODECS"])
                }
            }
        }
        val sorted = levels.distinctBy { it.height }.sortedByDescending { it.height }
        // A media playlist (no variants) is still playable when it has segments.
        return Master(isMaster || hasSegments, audio, sorted, codecs, firstVariant)
    }

    /** First segment (or EXT-X-MAP init) of a media playlist, absolute. */
    fun firstSegment(text: String, base: String): String? {
        for (l in text.lines().map { it.trim() }) {
            if (l.startsWith("#EXT-X-MAP:")) attrs(l)["URI"]?.let { return resolve(it, base) }
            if (l.isNotEmpty() && !l.startsWith("#")) return resolve(l, base)
        }
        return null
    }

    fun languageLabel(code: String?): String? {
        val c = code?.trim()?.lowercase()
        if (c.isNullOrEmpty() || c == "und" || c == "mul") return null
        val name = runCatching { Locale(c.substringBefore('-')).getDisplayLanguage(Locale.ENGLISH) }.getOrNull()
        return name?.takeIf { it.isNotBlank() && !it.equals(c, true) } ?: code
    }

    /** Audio languages for ranking: default track first only if the master says so; order kept otherwise. */
    fun languages(audio: List<AudioTrack>): List<String> =
        audio.mapNotNull { it.label }.distinctBy { it.lowercase() }
}
