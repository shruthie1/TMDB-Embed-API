package com.chitram.app.resolve

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 1.2.65 (j2-lang-latency.md, APK items 1-5): audio languages from the file's own
 * tags, read on the phone after the film has started. Nothing here runs before
 * the first frame, and nothing calls the VM.
 *
 * - Progressive MP4 (ShowsSt): moov/trak/mdia: hdlr `soun`, then elng, else mdhd.
 *   `und` is unknown and left out.
 * - HLS (CastleTV, mapple, VaPlayer): first variant, first segment. MPEG-TS: the
 *   PMT tags (TsAudio). fMP4: the EXT-X-MAP init's moov, as above.
 *
 * Language only from file tags: an untagged file gives an empty list (unknown),
 * and the row keeps what it had. One read per file (key [fileKey]), each bounded
 * by [BUDGET_MS].
 */
object FileTags {
    const val BUDGET_MS = 15_000L
    const val MP4_SOURCE = "mp4-tag"
    const val TS_SOURCE = "ts-pmt"
    /** Language sources that are the file's own tags. */
    val FILE_SOURCES = setOf(MP4_SOURCE, TS_SOURCE)
    /** Device providers whose files carry tags (OneTouchTV and vidrift files are untagged: left out). */
    private val TAGGED = setOf("showsst", "castletv", "mapple", "vaplayer")
    private const val HEAD_BYTES = 256 * 1024
    private const val TS_BYTES = 188 * 512
    private const val MAX_MOOV = 8 * 1024 * 1024
    private const val MAX_CACHE = 300

    /** languages: file-tag labels, PMT/trak order; empty = file read, no tag (unknown). */
    data class Tags(val languages: List<String>, val source: String)

    private val cache = object : LinkedHashMap<String, Tags>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Tags>?) = size > MAX_CACHE
    }

    fun cached(url: String): Tags? = synchronized(cache) { cache[fileKey(url)] }
    fun remember(url: String, tags: Tags) = synchronized(cache) { cache[fileKey(url)] = tags }
    internal fun clearCache() = synchronized(cache) { cache.clear() }

    /** A device row of a tagged provider whose languages are not file tags yet. */
    fun wants(s: Source): Boolean =
        s.onDevice != null && s.onDevice.lowercase() in TAGGED && !s.dash && s.languageSource !in FILE_SOURCES

    /**
     * One file, whatever url signs it: the inner url of a `?url=` proxy wrapper, then
     * host+path. Where the path names no file (ShowsSt prism.surrealviews.com/api?d=),
     * the query is the file: its sha1 joins the key (lib/media/mp4AudioProbe.js cacheKey).
     */
    fun fileKey(url: String): String {
        val inner = MultiMoviesResolver.unwrap(url)
        val u = inner.toHttpUrlOrNull() ?: return inner
        val last = u.encodedPath.substringAfterLast('/')
        val q = u.encodedQuery
        val suffix = if (!q.isNullOrEmpty() && !last.contains('.')) "#" + sha1("?$q").take(16) else ""
        return "${u.host}${u.encodedPath}$suffix"
    }

    private fun sha1(s: String): String = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    /**
     * [target] with [from]'s languages and languageSource, or null when nothing changes.
     * File tags are never replaced by labels; an empty list never replaces anything.
     */
    fun mergeLanguages(target: Source, from: Source): Source? {
        if (from.languages.isEmpty()) return null
        if (target.languageSource in FILE_SOURCES && from.languageSource !in FILE_SOURCES) return null
        if (target.languages == from.languages && target.languageSource == from.languageSource) return null
        return withLanguages(target, from.languages, from.languageSource ?: target.languageSource)
    }

    /** [s] carrying [langs] as its languages (and audioLanguages where it had them). */
    fun withLanguages(s: Source, langs: List<String>, source: String?): Source = s.copy(
        languages = langs,
        languageSource = source,
        audioLanguages = if (s.audioLanguages != null) langs else null,
    )

    /**
     * Reads one row's file tags. null: not read (timeout, HTTP error, unknown container).
     * The answer, empty or not, is kept per file.
     */
    suspend fun read(client: OkHttpClient, s: Source, budgetMs: Long = BUDGET_MS, headBytes: Int = HEAD_BYTES): Tags? {
        cached(s.url)?.let { return it }
        val http = StreamInterceptor.playerClient(client, s.headers, s.segmentToken, null)
            .newBuilder().callTimeout(budgetMs, TimeUnit.MILLISECONDS).build()
        val tags = withTimeoutOrNull(budgetMs) {
            runCatching { if (s.progressive) readMp4(http, s.url, headBytes) else readHls(http, s.url) }
                .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
                .getOrNull()
        } ?: return null
        remember(s.url, tags)
        return tags
    }

    private suspend fun readMp4(http: OkHttpClient, url: String, headBytes: Int): Tags? {
        val head = range(http, url, 0, headBytes) ?: return null
        mp4Languages(head)?.let { return Tags(it, MP4_SOURCE) }
        // moov after mdat (or past the head): walk the top-level boxes by their sizes.
        var at = 0L
        var buf = head
        var bufAt = 0L
        repeat(8) {
            val rel = (at - bufAt).toInt()
            if (rel < 0 || rel + 16 > buf.size) { buf = range(http, url, at, 16) ?: return null; bufAt = at }
            val r = (at - bufAt).toInt()
            if (buf.size < r + 8) return null
            var size = u32(buf, r)
            val type = String(buf, r + 4, 4, Charsets.ISO_8859_1)
            if (size == 1L && buf.size >= r + 16) size = u64(buf, r + 8)
            if (size < 8) return null
            if (type == "moov") {
                if (size > MAX_MOOV) return null
                val moov = range(http, url, at, size.toInt()) ?: return null
                return mp4Languages(moov)?.let { Tags(it, MP4_SOURCE) }
            }
            at += size
        }
        return null
    }

    private suspend fun readHls(http: OkHttpClient, url: String): Tags? {
        var text = range(http, url, -1, HEAD_BYTES)?.toString(Charsets.UTF_8) ?: return null
        var base = url
        if (!text.trimStart().startsWith("#EXTM3U")) return null
        val m = Hls.parse(text, base)
        m.firstVariant?.let { v -> text = range(http, v, -1, HEAD_BYTES)?.toString(Charsets.UTF_8) ?: return null; base = v }
        val seg = Hls.firstSegment(text, base) ?: return null
        val isInit = text.lines().any { it.trim().startsWith("#EXT-X-MAP:") }
        val bytes = range(http, seg, -1, if (isInit) MAX_MOOV else TS_BYTES) ?: return null
        mp4Languages(bytes)?.let { return Tags(it, MP4_SOURCE) }
        val ts = tsSlice(bytes) ?: return null
        val tracks = TsAudio.probe(ts) ?: return null
        return Tags(TsAudioSwap.fileLanguages(tracks), TS_SOURCE)
    }

    /** Whole TS packets from the first sync run (some hosts put a few bytes before the TS). */
    internal fun tsSlice(b: ByteArray): ByteArray? {
        for (i in 0 until minOf(4096, b.size - 188 * 3)) {
            if (b[i] == 0x47.toByte() && b[i + 188] == 0x47.toByte() && b[i + 376] == 0x47.toByte()) {
                val n = (b.size - i) / 188 * 188
                return b.copyOfRange(i, i + n).takeIf { TsAudio.isTs(it) }
            }
        }
        return null
    }

    /**
     * Audio languages of an MP4/fMP4 moov: per audio trak (hdlr `soun`), elng when
     * present, else mdhd. null: no whole moov in [b]; empty: no audio trak is tagged.
     */
    fun mp4Languages(b: ByteArray): List<String>? {
        val moov = boxes(b, 0, b.size).firstOrNull { it.type == "moov" && it.end <= b.size } ?: return null
        val out = ArrayList<String>()
        for (trak in boxes(b, moov.body, moov.end).filter { it.type == "trak" }) {
            val mdia = boxes(b, trak.body, trak.end).firstOrNull { it.type == "mdia" } ?: continue
            val kids = boxes(b, mdia.body, mdia.end)
            val hdlr = kids.firstOrNull { it.type == "hdlr" } ?: continue
            if (hdlr.body + 12 > hdlr.end || String(b, hdlr.body + 8, 4, Charsets.ISO_8859_1) != "soun") continue
            val code = kids.firstOrNull { it.type == "elng" }?.let { elng(b, it) } ?: kids.firstOrNull { it.type == "mdhd" }?.let { mdhd(b, it) }
            val label = Ranking.languageLabel(code)?.takeIf { Ranking.languageCode(it) != null } ?: continue
            if (out.none { it.equals(label, true) }) out += label
        }
        return out
    }

    private class Box(val type: String, val body: Int, val end: Int)

    private fun boxes(b: ByteArray, from: Int, to: Int): List<Box> {
        val out = ArrayList<Box>()
        var p = from
        while (p + 8 <= to) {
            var size = u32(b, p)
            var hdr = 8
            if (size == 1L) { if (p + 16 > to) break; size = u64(b, p + 8); hdr = 16 }
            if (size == 0L) size = (to - p).toLong()
            if (size < hdr) break
            val type = String(b, p + 4, 4, Charsets.ISO_8859_1)
            val end = p + size
            out += Box(type, p + hdr, if (end > Int.MAX_VALUE) Int.MAX_VALUE else end.toInt())
            if (end > to) break
            p = end.toInt()
        }
        return out
    }

    /** mdhd language: 15 bits, three 5-bit letters + 0x60. */
    private fun mdhd(b: ByteArray, box: Box): String? {
        val v = b[box.body].toInt() and 0xFF
        val at = box.body + 4 + if (v == 1) 28 else 16
        if (at + 2 > box.end) return null
        val packed = ((b[at].toInt() and 0xFF) shl 8) or (b[at + 1].toInt() and 0xFF)
        val code = String(charArrayOf(((packed shr 10 and 0x1F) + 0x60).toChar(), ((packed shr 5 and 0x1F) + 0x60).toChar(), ((packed and 0x1F) + 0x60).toChar()))
        return code.takeIf { it.all { c -> c in 'a'..'z' } && it != "und" }
    }

    /** elng: full box, then a NUL-terminated BCP 47 tag. */
    private fun elng(b: ByteArray, box: Box): String? {
        val from = box.body + 4
        if (from >= box.end) return null
        var e = from
        while (e < box.end && b[e] != 0.toByte()) e++
        return String(b, from, e - from, Charsets.US_ASCII).trim().takeIf { it.isNotEmpty() && !it.equals("und", true) }
    }

    private fun u32(b: ByteArray, i: Int): Long =
        ((b[i].toLong() and 0xFF) shl 24) or ((b[i + 1].toLong() and 0xFF) shl 16) or ((b[i + 2].toLong() and 0xFF) shl 8) or (b[i + 3].toLong() and 0xFF)

    private fun u64(b: ByteArray, i: Int): Long = (u32(b, i) shl 32) or u32(b, i + 4)

    /** Up to [len] bytes from [from] (a Range request; -1: no Range, first [len] bytes). null on HTTP error. */
    private suspend fun range(http: OkHttpClient, url: String, from: Long, len: Int): ByteArray? {
        val req = Request.Builder().url(url).apply { if (from >= 0) header("Range", "bytes=$from-${from + len - 1}") }.build()
        val call = http.newCall(req)
        return suspendCancellableCoroutine { cont ->
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWithException(e) }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val bytes = response.use { r ->
                            // A host that ignores Range answers 200 from byte 0: only usable when we asked from 0.
                            if (!r.isSuccessful || (from > 0 && r.code != 206)) null
                            else r.body?.source()?.let { src -> src.request(len.toLong()); val n = minOf(len.toLong(), src.buffer.size); src.buffer.readByteArray(n) }
                        }
                        if (cont.isActive) cont.resume(bytes)
                    } catch (e: Exception) { if (cont.isActive) cont.resumeWithException(e) }
                }
            })
        }
    }
}
