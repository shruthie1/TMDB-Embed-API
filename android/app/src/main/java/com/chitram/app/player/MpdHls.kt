package com.chitram.app.player

/**
 * MPD -> HLS text, for casting a MultiMovies `/dash/` row when the VM is down
 * (P23, 1.2.51). Kotlin twin of the server's lib/media/mpdHls.js: same parse,
 * same playlists. Segment lines stay absolute on sacdn with the signed query,
 * so the receiver fetches video straight from sacdn; only the small playlists
 * come from the phone. Pure functions: no network.
 */
object MpdHls {
    data class Seg(val uri: String, val dur: Double)
    data class Rep(val id: String, val kind: String, val codecs: String?, val bandwidth: Long, val width: Int?, val height: Int?,
                   val frameRate: String?, val lang: String?, val channels: String?, val init: String?, val segments: List<Seg>)
    data class Parsed(val duration: Double?, val reps: List<Rep>)
    /** The audio language to state: `code` null = no LANGUAGE (unverified). */
    data class Language(val code: String?, val name: String)
    /** One served playlist. `master`/`video` tell the cast watch what the receiver fetched. */
    data class Page(val text: String, val master: Boolean = false, val video: Boolean = false)

    private val ISO2 = mapOf(
        "tel" to "te", "tam" to "ta", "kan" to "kn", "hin" to "hi", "mal" to "ml", "eng" to "en", "ben" to "bn", "mar" to "mr",
        "guj" to "gu", "pan" to "pa", "urd" to "ur", "ori" to "or", "ory" to "or", "asm" to "as", "jpn" to "ja", "kor" to "ko",
        "spa" to "es", "fra" to "fr", "fre" to "fr", "deu" to "de", "ger" to "de", "ita" to "it", "por" to "pt", "rus" to "ru",
        "zho" to "zh", "chi" to "zh", "ara" to "ar", "tha" to "th", "ind" to "id", "msa" to "ms", "may" to "ms", "vie" to "vi", "tur" to "tr",
    )
    private val NAMES = mapOf(
        "te" to "Telugu", "ta" to "Tamil", "kn" to "Kannada", "hi" to "Hindi", "ml" to "Malayalam", "en" to "English", "bn" to "Bengali",
        "mr" to "Marathi", "gu" to "Gujarati", "pa" to "Punjabi", "ur" to "Urdu", "or" to "Odia", "as" to "Assamese", "ja" to "Japanese",
        "ko" to "Korean", "es" to "Spanish", "fr" to "French", "de" to "German", "it" to "Italian", "pt" to "Portuguese", "ru" to "Russian",
        "zh" to "Chinese", "ar" to "Arabic", "th" to "Thai", "id" to "Indonesian", "ms" to "Malay", "vi" to "Vietnamese", "tr" to "Turkish",
    )
    private val CODE_OF_NAME = NAMES.entries.associate { (c, n) -> n.lowercase() to c }

    /** MPD lang -> HLS LANGUAGE code, or null (und/unk/mul/zxx say nothing). */
    fun hlsLanguage(lang: String?): String? {
        val v = lang?.trim()?.lowercase()?.substringBefore('-')?.takeIf { it.isNotEmpty() } ?: return null
        if (v in setOf("und", "unk", "mul", "zxx")) return null
        return ISO2[v] ?: v
    }

    /** The row's language name ("Telugu") as the master states it; null = use the MPD lang. */
    fun languageOf(name: String?): Language? {
        val v = name?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val code = CODE_OF_NAME[v.lowercase()] ?: hlsLanguage(v)
        return Language(code, NAMES[code] ?: v)
    }

    private val ATTR = Regex("""([\w:.-]+)="([^"]*)"""")
    private fun attrsOf(tag: String): Map<String, String> = ATTR.findAll(tag).associate { it.groupValues[1] to it.groupValues[2] }

    private data class El(val attrs: Map<String, String>, val inner: String)
    private fun re(name: String) = Regex("""<$name\b([^>]*?)(/>|>([\s\S]*?)</$name>)""")
    private fun element(body: String, name: String): El? = re(name).find(body)?.let { El(attrsOf(it.groupValues[1]), it.groupValues[3]) }
    private fun elements(body: String, name: String): List<El> = re(name).findAll(body).map { El(attrsOf(it.groupValues[1]), it.groupValues[3]) }.toList()

    /** ISO 8601 duration (PT2H45M57.2S) -> seconds, or null. */
    fun isoSeconds(v: String?): Double? {
        val m = Regex("""^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$""").find(v?.trim() ?: return null) ?: return null
        val (d, h, mi, s) = (1..4).map { m.groupValues[it].toDoubleOrNull() ?: 0.0 }
        return d * 86400 + h * 3600 + mi * 60 + s
    }

    private val TPL = Regex("""\$(RepresentationID|Number|Time|Bandwidth)(%0(\d+)d)?\$|\$\$""")
    fun fillTemplate(tpl: String, vars: Map<String, Any?>): String = TPL.replace(tpl) { m ->
        if (m.value == "$$") return@replace "$"
        val v = vars[m.groupValues[1]]?.toString().orEmpty()
        val w = m.groupValues[3].toIntOrNull()
        if (w != null) v.padStart(w, '0') else v
    }

    private data class Timed(val number: Long, val time: Long, val dur: Long)

    private fun segmentsOf(attrs: Map<String, String>, inner: String, totalSec: Double?): Pair<Long, List<Timed>> {
        val ts = attrs["timescale"]?.toLongOrNull() ?: 1L
        val start = attrs["startNumber"]?.toLongOrNull() ?: 1L
        val out = ArrayList<Timed>()
        val timeline = element(inner, "SegmentTimeline")
        if (timeline != null) {
            var t = 0L
            var n = start
            val ss = elements(timeline.inner, "S")
            ss.forEachIndexed { i, s ->
                s.attrs["t"]?.toLongOrNull()?.let { t = it }
                val d = s.attrs["d"]?.toLongOrNull() ?: 0L
                if (d <= 0) return@forEachIndexed
                var r = s.attrs["r"]?.toLongOrNull() ?: 0L
                if (r < 0) {
                    val next = ss.getOrNull(i + 1)?.attrs?.get("t")?.toLongOrNull()
                        ?: (totalSec?.let { Math.round(it * ts) } ?: (t + d))
                    r = maxOf(0L, Math.ceil((next - t).toDouble() / d).toLong() - 1)
                }
                for (k in 0..r) { out += Timed(n++, t, d); t += d }
            }
            return ts to out
        }
        val d = attrs["duration"]?.toLongOrNull() ?: 0L
        if (d <= 0 || totalSec == null || totalSec <= 0) return ts to out
        val total = Math.round(totalSec * ts)
        var t = 0L
        var n = start
        while (t < total) { out += Timed(n++, t, minOf(d, total - t)); t += d }
        return ts to out
    }

    /** Parse a static MPD (first Period). Throws when it is not a usable MPD. */
    fun parseMpd(text: String): Parsed {
        val mpd = Regex("""<MPD\b([^>]*)>""").find(text) ?: throw IllegalArgumentException("not an MPD")
        val mattrs = attrsOf(mpd.groupValues[1])
        mattrs["type"]?.let { require(it == "static") { "MPD type $it unsupported" } }
        require(!text.contains("<BaseURL")) { "MPD BaseURL unsupported" }
        require(!text.contains("<ContentProtection")) { "MPD has DRM" }
        val period = element(text, "Period") ?: throw IllegalArgumentException("MPD has no Period")
        val totalSec = isoSeconds(mattrs["mediaPresentationDuration"]) ?: isoSeconds(period.attrs["duration"])
        val reps = ArrayList<Rep>()
        for (aset in elements(period.inner, "AdaptationSet")) {
            val a = aset.attrs
            val asetTpl = element(aset.inner.replace(Regex("""<Representation\b[\s\S]*$"""), ""), "SegmentTemplate")
            for (rep in elements(aset.inner, "Representation")) {
                val r = rep.attrs
                val mime = r["mimeType"] ?: a["mimeType"] ?: ""
                val kind = when {
                    mime.startsWith("video/") || a["contentType"] == "video" -> "video"
                    mime.startsWith("audio/") || a["contentType"] == "audio" -> "audio"
                    else -> null
                } ?: continue
                val tpl = element(rep.inner, "SegmentTemplate") ?: asetTpl ?: continue
                val attrs = (asetTpl?.attrs ?: emptyMap()) + tpl.attrs
                val inner = tpl.inner.ifEmpty { asetTpl?.inner.orEmpty() }
                val (ts, segs) = segmentsOf(attrs, inner, totalSec)
                if (segs.isEmpty()) continue
                val vars = mapOf("RepresentationID" to r["id"], "Bandwidth" to r["bandwidth"])
                val ch = element(rep.inner, "AudioChannelConfiguration") ?: element(aset.inner, "AudioChannelConfiguration")
                reps += Rep(
                    id = r["id"].orEmpty(), kind = kind, codecs = r["codecs"] ?: a["codecs"],
                    bandwidth = r["bandwidth"]?.toLongOrNull() ?: 0L,
                    width = (r["width"] ?: a["width"])?.toIntOrNull(), height = (r["height"] ?: a["height"])?.toIntOrNull(),
                    frameRate = r["frameRate"] ?: a["frameRate"], lang = a["lang"] ?: r["lang"],
                    channels = ch?.attrs?.get("value")?.takeIf { it.all(Char::isDigit) && it.isNotEmpty() },
                    init = attrs["initialization"]?.let { fillTemplate(it, vars) },
                    segments = segs.map { g -> Seg(fillTemplate(attrs["media"].orEmpty(), vars + mapOf("Number" to g.number, "Time" to g.time)), g.dur.toDouble() / ts) },
                )
            }
        }
        require(reps.any { it.kind == "video" }) { "MPD has no video Representation" }
        return Parsed(totalSec, reps)
    }

    /** One media playlist. `folder`: absolute sacdn folder ending in '/'; `query`: the signed query on every line. */
    fun mediaPlaylist(rep: Rep, folder: String, query: String): String {
        val q = if (query.isNotEmpty()) "?$query" else ""
        val target = maxOf(1, Math.ceil(rep.segments.maxOf { it.dur }).toInt())
        val sb = StringBuilder(rep.segments.size * (folder.length + q.length + 40))
        sb.append("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:").append(target)
            .append("\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n")
        rep.init?.let { sb.append("#EXT-X-MAP:URI=\"").append(folder).append(it).append(q).append("\"\n") }
        for (g in rep.segments) {
            sb.append("#EXTINF:").append(String.format(java.util.Locale.ROOT, "%.3f", g.dur)).append(",\n")
            sb.append(folder).append(g.uri).append(q).append('\n')
        }
        sb.append("#EXT-X-ENDLIST\n")
        return sb.toString()
    }

    private fun quoted(v: String) = v.replace('"', '\'')

    /**
     * The master. `videoCodecs`: rep id -> full codec from the init hvcC; when a
     * video rep has none, CODECS is left out for every variant. `language`
     * overrides every audio set's MPD lang. Telugu audio is first and DEFAULT.
     */
    fun masterPlaylist(p: Parsed, playlistUrl: (Rep) -> String, videoCodecs: Map<String, String> = emptyMap(), language: Language? = null): String {
        val audio = p.reps.filter { it.kind == "audio" }
        val video = p.reps.filter { it.kind == "video" }.sortedByDescending { it.bandwidth }
        val allCodecs = video.all { videoCodecs[it.id] != null }
        data class Track(val rep: Rep, val code: String?, var name: String)
        val tracks = audio.map { r ->
            if (language != null) Track(r, language.code, language.name)
            else hlsLanguage(r.lang).let { c -> Track(r, c, NAMES[c] ?: c ?: "Audio") }
        }.sortedByDescending { it.code == "te" }
        val seen = HashMap<String, Int>()
        for (t in tracks) { val n = (seen[t.name] ?: 0) + 1; seen[t.name] = n; if (n > 1) t.name = "${t.name} $n" }
        val lines = mutableListOf("#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS")
        tracks.forEachIndexed { i, t ->
            val parts = mutableListOf("TYPE=AUDIO", "GROUP-ID=\"audio\"")
            t.code?.let { parts += "LANGUAGE=\"${quoted(it)}\"" }
            parts += listOf("NAME=\"${quoted(t.name)}\"", "DEFAULT=${if (i == 0) "YES" else "NO"}", "AUTOSELECT=YES")
            t.rep.channels?.let { parts += "CHANNELS=\"$it\"" }
            parts += "URI=\"${playlistUrl(t.rep)}\""
            lines += "#EXT-X-MEDIA:" + parts.joinToString(",")
        }
        val audioBw = audio.maxOfOrNull { it.bandwidth } ?: 0L
        val audioCodec = audio.firstOrNull()?.codecs
        for (v in video) {
            val parts = mutableListOf("BANDWIDTH=${v.bandwidth + audioBw}")
            if (v.width != null && v.height != null) parts += "RESOLUTION=${v.width}x${v.height}"
            if (allCodecs) parts += "CODECS=\"${listOfNotNull(videoCodecs[v.id], audioCodec).joinToString(",")}\""
            Regex("""^(\d+)(?:/(\d+))?$""").find(v.frameRate.orEmpty())?.let { m ->
                val fr = m.groupValues[1].toDouble() / (m.groupValues[2].toDoubleOrNull() ?: 1.0)
                parts += "FRAME-RATE=" + String.format(java.util.Locale.ROOT, "%.3f", fr)
            }
            if (tracks.isNotEmpty()) parts += "AUDIO=\"audio\""
            lines += "#EXT-X-STREAM-INF:" + parts.joinToString(",")
            lines += playlistUrl(v)
        }
        lines += ""
        return lines.joinToString("\n")
    }

    private fun indexOf(b: ByteArray, tag: String): Int {
        val t = tag.toByteArray(Charsets.ISO_8859_1)
        outer@ for (i in 0..b.size - t.size) { for (j in t.indices) if (b[i + j] != t[j]) continue@outer; return i }
        return -1
    }

    /** The full codec string from an fMP4 init segment's avcC / hvcC box (hev1.1.6.L150.90), or null. */
    fun codecFromInit(buf: ByteArray): String? {
        fun u(i: Int) = buf[i].toInt() and 0xff
        val avcc = indexOf(buf, "avcC")
        if (avcc >= 0 && avcc + 8 < buf.size) {
            val profile = u(avcc + 5); val constraint = u(avcc + 6); val level = u(avcc + 7)
            if (profile != 0 && level != 0) {
                val a3 = indexOf(buf, "avc3")
                val entry = if (a3 in 0 until avcc) "avc3" else "avc1"
                return "%s.%02x%02x%02x".format(entry, profile, constraint, level)
            }
        }
        val hvcc = indexOf(buf, "hvcC")
        if (hvcc >= 0 && hvcc + 17 < buf.size) {
            val b = hvcc + 4
            val stp = u(b + 1)
            val space = listOf("", "A", "B", "C")[stp shr 6]
            val tier = if ((stp shr 5) and 1 == 1) "H" else "L"
            val profile = stp and 0x1f
            // Compatibility flags are written bit-reversed (ISO/IEC 14496-15 E.3).
            val compat = (u(b + 2).toLong() shl 24) or (u(b + 3).toLong() shl 16) or (u(b + 4).toLong() shl 8) or u(b + 5).toLong()
            val rev = Integer.reverse(compat.toInt()).toLong() and 0xffffffffL
            val constraints = (0 until 6).map { u(b + 6 + it) }.toMutableList()
            while (constraints.isNotEmpty() && constraints.last() == 0) constraints.removeAt(constraints.size - 1)
            val level = u(b + 12)
            val h1 = indexOf(buf, "hev1")
            val entry = if (h1 in 0 until hvcc) "hev1" else "hvc1"
            return (listOf("$entry.$space$profile", rev.toString(16), "$tier$level") + constraints.map { it.toString(16).uppercase() }).joinToString(".")
        }
        return null
    }
}
