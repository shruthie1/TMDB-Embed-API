package com.chitram.app.player

import okhttp3.Interceptor
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * Fast start for the VM's castle-demux master (apk-playback.md, item 1).
 *
 * The VM writes the video variant with a video-only CODECS ("avc1..."),
 * because hls.js breaks when an audio codec is listed there. ExoPlayer reads
 * a missing audio codec as "audio format unknown": before it can start, it
 * loads all five audio playlists (about 300 KB each) and the first segment of
 * all five languages, and each segment is an ffmpeg run on the VM. The slowest
 * of those gates the first frame (Daaku Maharaaj resume on the phone: 12.8 s).
 *
 * Castle audio is always AAC (utils/castleDemux.js; trace: audio/mp4a-latm).
 * With "mp4a.40.2" on the variant, ExoPlayer prepares from the master alone and
 * loads only the selected language. Every rendition stays in the track list
 * with its LANGUAGE and NAME, so the audio menu and the Telugu pick do not change.
 *
 * Only castle-demux masters: for any other provider the audio codec is not
 * known, and a wrong guess would hide an unsupported track until it fails.
 */
object MasterCodecs : Interceptor {
    private val MASTER = Regex("/castle-demux/[0-9a-fA-F]+/master\\.m3u8$")
    private const val AAC = "mp4a.40.2"
    private val AUDIO_CODEC = Regex("(^|,)\\s*(mp4a|ac-3|ec-3|ac-4|opus|flac|alac|mp3|dtsc|dtse|dtsh|dtsl)", RegexOption.IGNORE_CASE)
    private val CODECS_ATTR = Regex("CODECS=\"([^\"]*)\"")

    fun applies(path: String): Boolean = MASTER.containsMatchIn(path)

    /** Adds AAC to each EXT-X-STREAM-INF that has an AUDIO group and lists no audio codec. Other lines are untouched. */
    fun fill(text: String): String = text.lineSequence().joinToString("\n") { line ->
        if (!line.startsWith("#EXT-X-STREAM-INF:") || !line.contains("AUDIO=\"")) return@joinToString line
        val m = CODECS_ATTR.find(line) ?: return@joinToString line
        val codecs = m.groupValues[1]
        if (codecs.isBlank() || AUDIO_CODEC.containsMatchIn(codecs)) line
        else line.replaceRange(m.range, "CODECS=\"$codecs,$AAC\"")
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val res = chain.proceed(chain.request())
        if (!res.isSuccessful || !applies(chain.request().url.encodedPath)) return res
        val body = res.body ?: return res
        val type = body.contentType()
        val text = body.string()
        val fixed = fill(text)
        if (fixed != text) android.util.Log.i("Chitram", "[master] castle-demux: audio codec $AAC added, chunkless start")
        return res.newBuilder()
            .removeHeader("Content-Length").removeHeader("Content-Encoding")
            .body(fixed.toResponseBody(type))
            .build()
    }
}
