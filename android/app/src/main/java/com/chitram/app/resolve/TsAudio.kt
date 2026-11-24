package com.chitram.app.resolve

import com.chitram.app.data.Source
import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.Locale

/**
 * Muxed MPEG-TS audio (port of web/lib/player/tsAudio.js). CastleTV serves a
 * media playlist whose segments carry H.264 plus five AAC tracks, each tagged
 * in the PMT (1508168: PIDs 0x101-0x105 = hin/mal/tam/tel/kan). media3 runs
 * TsExtractor in MODE_HLS for HLS, which keeps one track per stream type: the
 * first AAC PID, Hindi. Swapping the chosen track's PID with the first AAC PID
 * in every packet header makes the player decode Telugu with no re-encode.
 *
 * Unlike the web, the PMT language descriptors of the two PIDs are swapped too
 * (CRC recomputed), so the player's Format.language names what plays.
 */
object TsAudio {
    private const val PACKET = 188
    private const val SYNC: Byte = 0x47
    /** ADTS AAC. Only tracks of this type are offered: an AC-3 PID in an AAC slot cannot decode. */
    private const val STREAM_TYPE_AAC = 0x0f
    private const val DESCRIPTOR_LANGUAGE = 0x0a

    data class Track(val pid: Int, val lang: String?)

    private fun u(b: ByteArray, i: Int) = b[i].toInt() and 0xFF
    private fun pidOf(b: ByteArray, i: Int) = ((u(b, i + 1) and 0x1f) shl 8) or u(b, i + 2)

    /** True when every whole packet starts on a sync byte. */
    fun isTs(b: ByteArray): Boolean {
        if (b.size < PACKET * 2) return false
        val whole = b.size - b.size % PACKET
        var i = 0
        while (i < whole) { if (b[i] != SYNC) return false; i += PACKET }
        return true
    }

    /** Offset of the PSI section in a packet that starts one, or -1. */
    private fun sectionStart(b: ByteArray, i: Int): Int {
        if (u(b, i + 1) and 0x40 == 0) return -1
        val afc = (u(b, i + 3) shr 4) and 0x03
        if (afc != 1 && afc != 3) return -1
        var p = i + 4
        if (afc == 3) p += 1 + u(b, p)
        if (p >= i + PACKET) return -1
        p += 1 + u(b, p)
        return if (p < i + PACKET) p else -1
    }

    /** Sections (start, end excluding CRC) of `tableId` on `pid`, each inside one packet. */
    private fun sections(b: ByteArray, pid: Int, tableId: Int, firstOnly: Boolean): List<IntArray> {
        val out = ArrayList<IntArray>()
        var i = 0
        while (i + PACKET <= b.size) {
            if (pidOf(b, i) == pid) {
                val s = sectionStart(b, i)
                if (s >= 0 && u(b, s) == tableId && s + 3 <= i + PACKET) {
                    val len = ((u(b, s + 1) and 0x0f) shl 8) or u(b, s + 2)
                    // A section spanning packets has not been seen from these providers; declining is safe.
                    if (s + 3 + len <= i + PACKET && len >= 4) {
                        out += intArrayOf(s, s + 3 + len - 4)
                        if (firstOnly) return out
                    }
                }
            }
            i += PACKET
        }
        return out
    }

    private fun pmtPid(b: ByteArray): Int {
        val pat = sections(b, 0, 0x00, firstOnly = true).firstOrNull() ?: return -1
        var p = pat[0] + 8
        while (p + 4 <= pat[1]) {
            val program = (u(b, p) shl 8) or u(b, p + 1)
            if (program != 0) return ((u(b, p + 2) and 0x1f) shl 8) or u(b, p + 3)
            p += 4
        }
        return -1
    }

    /** Language descriptor offset (3 code bytes) per AAC PID in one PMT section. */
    private fun aacEntries(b: ByteArray, pmt: IntArray): List<Pair<Int, Int>> {
        val out = ArrayList<Pair<Int, Int>>()
        val infoLen = ((u(b, pmt[0] + 10) and 0x0f) shl 8) or u(b, pmt[0] + 11)
        var p = pmt[0] + 12 + infoLen
        while (p + 5 <= pmt[1]) {
            val type = u(b, p)
            val pid = ((u(b, p + 1) and 0x1f) shl 8) or u(b, p + 2)
            val esLen = ((u(b, p + 3) and 0x0f) shl 8) or u(b, p + 4)
            if (type == STREAM_TYPE_AAC) {
                var d = p + 5
                var at = -1
                while (d + 2 <= minOf(p + 5 + esLen, pmt[1])) {
                    val len = u(b, d + 1)
                    if (u(b, d) == DESCRIPTOR_LANGUAGE && len >= 3) { at = d + 2; break }
                    d += 2 + len
                }
                out += pid to at
            }
            p += 5 + esLen
        }
        return out
    }

    private fun lang(b: ByteArray, at: Int): String? {
        if (at < 0) return null
        val code = String(byteArrayOf(b[at], b[at + 1], b[at + 2]), Charsets.ISO_8859_1).filter { it.isLetter() }.lowercase()
        return code.takeIf { it.isNotEmpty() && it != "und" }
    }

    /** The AAC tracks in one segment, PMT order. null when not parseable TS: unknown, not "no audio". */
    fun probe(b: ByteArray): List<Track>? {
        if (!isTs(b)) return null
        val pmtPid = pmtPid(b).takeIf { it >= 0 } ?: return null
        val pmt = sections(b, pmtPid, 0x02, firstOnly = true).firstOrNull() ?: return null
        return aacEntries(b, pmt).map { (pid, at) -> Track(pid, lang(b, at)) }
    }

    /** (first AAC PID, wanted PID) when the wanted language is in the segment and not first. */
    fun plan(b: ByteArray, wantIso3: String): Pair<Int, Int>? {
        val tracks = probe(b) ?: return null
        val first = tracks.firstOrNull() ?: return null
        val want = tracks.firstOrNull { it.lang == wantIso3 } ?: return null
        return if (want.pid == first.pid) null else first.pid to want.pid
    }

    /** Probe, swap the PIDs and the PMT language codes. False (buffer untouched) when nothing to do. */
    fun apply(b: ByteArray, wantIso3: String): Boolean {
        val (a, c) = plan(b, wantIso3) ?: return false
        if (!swapPids(b, a, c)) return false
        swapLanguages(b, a, c)
        return true
    }

    /**
     * Swap two PIDs in every packet header, in place. Each stream keeps its own
     * continuity counters. Refuses (false, untouched) when the buffer is not clean TS.
     */
    fun swapPids(b: ByteArray, pidA: Int, pidB: Int): Boolean {
        if (pidA == pidB || !isTs(b)) return false
        val whole = b.size - b.size % PACKET
        var i = 0
        while (i < whole) {
            val pid = pidOf(b, i)
            val to = when (pid) { pidA -> pidB; pidB -> pidA; else -> -1 }
            if (to >= 0) {
                b[i + 1] = ((u(b, i + 1) and 0xe0) or ((to shr 8) and 0x1f)).toByte()
                b[i + 2] = (to and 0xff).toByte()
            }
            i += PACKET
        }
        return true
    }

    /** Swap the two PIDs' language codes in every PMT section of the buffer and fix the CRC. */
    fun swapLanguages(b: ByteArray, pidA: Int, pidB: Int) {
        val pmtPid = pmtPid(b).takeIf { it >= 0 } ?: return
        for (pmt in sections(b, pmtPid, 0x02, firstOnly = false)) {
            val entries = aacEntries(b, pmt).toMap()
            val x = entries[pidA] ?: continue
            val y = entries[pidB] ?: continue
            if (x < 0 || y < 0) continue
            for (k in 0 until 3) { val t = b[x + k]; b[x + k] = b[y + k]; b[y + k] = t }
            val crc = crc32(b, pmt[0], pmt[1])
            b[pmt[1]] = (crc ushr 24).toByte(); b[pmt[1] + 1] = (crc ushr 16).toByte()
            b[pmt[1] + 2] = (crc ushr 8).toByte(); b[pmt[1] + 3] = crc.toByte()
        }
    }

    /** CRC-32/MPEG-2 over b[from, to). */
    fun crc32(b: ByteArray, from: Int, to: Int): Int {
        var crc = -1
        for (i in from until to) {
            crc = crc xor ((b[i].toInt() and 0xFF) shl 24)
            repeat(8) { crc = if (crc < 0) (crc shl 1) xor 0x04C11DB7 else crc shl 1 }
        }
        return crc
    }

    private val ISO3 = mapOf("telugu" to "tel", "tamil" to "tam", "hindi" to "hin", "malayalam" to "mal", "kannada" to "kan", "english" to "eng")

    /** "Telugu" -> "tel". */
    fun iso3(language: String): String? = ISO3[language.lowercase()]
        ?: Locale.getAvailableLocales().firstOrNull { it.getDisplayLanguage(Locale.ENGLISH).equals(language, true) }
            ?.let { runCatching { it.isO3Language }.getOrNull() }
}

/**
 * Applies [TsAudio] to every TS segment of one muxed row (several languages in
 * one TS: CastleTV plain rows, vidrock single-variant rows) on its way to the
 * player. Playlists and anything that is not clean TS pass through. A segment
 * without its own PMT uses the PIDs of the last one seen.
 *
 * media3 plays HLS with TsExtractor in MODE_HLS, which wires one track per
 * stream type (InStreamAudioTest: hin only), so TrackSelectionParameters can
 * never reach Telugu in such a file. The swap is the in-stream pick.
 *
 * [languages] is what the file's PMT tags say (untagged/und left out), read from
 * the first segment that has a PMT. [onPick] runs once, when a segment's PMT
 * carries the wanted language: never for a language the file lacks.
 */
class TsAudioSwap(preferred: String, private val onPick: (String) -> Unit = {}) : Interceptor {
    private val want = TsAudio.iso3(preferred)
    private val wantLabel = preferred
    @Volatile private var last: Pair<Int, Int>? = null
    @Volatile private var picked = false
    /** File-tag languages of this row, PMT order; null until a segment with a PMT passed. */
    @Volatile var languages: List<String>? = null
        private set

    override fun intercept(chain: Interceptor.Chain): Response {
        val res = chain.proceed(chain.request())
        if (want == null) return res
        val body = res.body ?: return res
        if (!res.isSuccessful) return res
        val head = res.peekBody(1).bytes()
        if (head.isEmpty() || head[0] != 0x47.toByte()) return res
        val bytes = body.bytes()
        onSegment(bytes)
        return res.newBuilder().body(bytes.toResponseBody(body.contentType())).build()
    }

    /** Swap the wanted track into the first AAC slot of this segment, in place. */
    fun onSegment(bytes: ByteArray) {
        val w = want ?: return
        val tracks = TsAudio.probe(bytes)
        if (tracks != null && languages == null) languages = fileLanguages(tracks)
        if (tracks != null && !picked && tracks.any { it.lang == w }) { picked = true; onPick(wantLabel) }
        val plan = TsAudio.plan(bytes, w)?.also { last = it } ?: if (tracks == null) last else null
        if (plan != null && TsAudio.swapPids(bytes, plan.first, plan.second)) TsAudio.swapLanguages(bytes, plan.first, plan.second)
    }

    companion object {
        /**
         * A muxed row: one HLS file whose single TS carries several languages
         * (selectableAudio false, no renditions), its [Source.languages] read from the
         * segment's PMT tags. The swap only acts on a language the PMT really tags.
         */
        fun wanted(s: Source): Boolean =
            !s.selectableAudio && !s.hybrid && !s.progressive && !s.dash && s.languages.size > 1 &&
                (s.languageSource == "ts-pmt" || PMT_TAGGED.any { it.equals(s.provider, true) })

        /**
         * Providers whose muxed rows take [Source.languages] from the PMT (server
         * vidrock withSegmentLanguages, CastleTV). Any other non-selectable row keeps
         * its first language: its list may be catalog metadata, and unknown beats wrong.
         */
        private val PMT_TAGGED = listOf("CastleTV", "vidrock")

        /** PMT tags as labels ("tel" -> Telugu); untagged and und tracks are unknown, so left out. */
        fun fileLanguages(tracks: List<TsAudio.Track>): List<String> =
            tracks.mapNotNull { t -> t.lang?.let(com.chitram.app.data.Ranking::languageLabel)?.takeIf { com.chitram.app.data.Ranking.languageCode(it) != null } }
                .distinctBy { it.lowercase() }
    }
}
