package com.chitram.app.player

import com.chitram.app.data.KeyValue
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source

/**
 * P23 (owner 2026-11-22): casting needs no step from the viewer. After a cast
 * the phone watches what the receiver fetches; a refused stream re-casts the
 * next source on its own.
 *
 * Signal: the receiver fetched the master, then a video playlist (VM route or
 * LAN pages) or a segment (LAN proxy). hls.js and Shaka drop variants whose
 * CODECS the device cannot play, so a master with no video fetch after it
 * means the receiver refused the stream. A decode failure after the video
 * playlist was fetched is not seen (no status comes back from WVC).
 */
object CastWatch {
    /** No video fetch this long after the latest master fetch: the receiver refused it. */
    const val FAIL_AFTER_MS = 10_000L
    /** No master fetch at all this long after the launch: the viewer did not finish casting. Stop watching. */
    const val ABANDON_AFTER_MS = 120_000L
    const val POLL_MS = 2_000L

    enum class Verdict { PENDING, OK, FAIL, ABANDONED, UNKNOWN }

    /** Epoch ms of the receiver's latest master and video fetch; `receiver`: a short id for the device. */
    data class Seen(val master: Long? = null, val video: Long? = null, val receiver: String? = null)

    fun verdict(s: Seen, startedAt: Long, now: Long): Verdict {
        val m = s.master ?: return if (now - startedAt >= ABANDON_AFTER_MS) Verdict.ABANDONED else Verdict.PENDING
        if (s.video != null && s.video >= m) return Verdict.OK
        return if (now - m >= FAIL_AFTER_MS) Verdict.FAIL else Verdict.PENDING
    }

    private val HEVC = Regex("hev1|hvc1|hevc|h\\.?265|x265", RegexOption.IGNORE_CASE)

    fun isHevc(s: Source): Boolean =
        listOfNotNull(s.videoCodec, s.codecString).any { HEVC.containsMatchIn(it) } ||
            s.levels.any { HEVC.containsMatchIn(it.codecs.orEmpty()) } ||
            (s.dash && s.url.substringBefore('?').contains("_h265_"))

    private fun isTelugu(s: Source, preferred: String): Boolean =
        (s.audioLanguages ?: s.languages).any { Ranking.sameLanguage(it, preferred) }

    fun logLine(s: Source, via: String, v: Verdict): String =
        "[cast] ${s.provider} via=$via codec=${if (isHevc(s)) "hevc" else "avc"} result=${v.name.lowercase()}"

    /** Per receiver: it refused HEVC once. `last`: the receiver of the latest cast. */
    class Memory(private val kv: KeyValue) {
        private fun key(r: String?) = "cast.hevcBad.${r ?: "default"}"
        fun hevcBad(r: String?): Boolean = kv.get(key(r)) == "1"
        val lastReceiver: String? get() = kv.get(LAST)
        fun saw(r: String?) { if (r != null) kv.put(LAST, r) }
        fun markHevcBad(r: String?) { kv.put(key(r), "1"); saw(r) }
        /** The receiver we expect: the last one seen. */
        fun expectHevcBad(): Boolean = hevcBad(lastReceiver)
        private companion object { const val LAST = "cast.lastReceiver" }
    }

    /**
     * One cast tap: the first row, then the next after each refusal, up to
     * [maxAttempts] rows. Order: H.264 before HEVC once HEVC was refused (this
     * chain or the receiver's memory), then Telugu, then the listed order.
     */
    class Chain(sources: List<Source>, private val memory: Memory, val maxAttempts: Int = 3, private val preferred: String = "Telugu") {
        private val rows = sources.filter { !it.unsupported }
        private val tried = LinkedHashSet<String>()
        private var hevcRefused = false

        private fun order(cands: List<Source>, hevcBad: Boolean): List<Source> =
            cands.withIndex().sortedWith(compareBy<IndexedValue<Source>>(
                { if (hevcBad && isHevc(it.value)) 1 else 0 },
                { if (isTelugu(it.value, preferred)) 0 else 1 },
                { it.index },
            )).map { it.value }

        /** What to cast first: the playing row, unless the last receiver refused HEVC and an H.264 row exists. */
        fun first(current: Source): Source {
            val pick = if (memory.expectHevcBad() && isHevc(current)) order(rows, true).firstOrNull { !isHevc(it) } ?: current else current
            tried += pick.id
            return pick
        }

        /** [row] was refused on [receiver]: the next row to cast, or null (no more, or the cap). */
        fun onFail(row: Source, receiver: String?): Source? {
            tried += row.id
            memory.saw(receiver)
            if (isHevc(row)) { hevcRefused = true; memory.markHevcBad(receiver) }
            if (tried.size >= maxAttempts) return null
            val next = order(rows.filter { it.id !in tried }, hevcRefused || memory.hevcBad(receiver)).firstOrNull() ?: return null
            tried += next.id
            return next
        }
    }
}
