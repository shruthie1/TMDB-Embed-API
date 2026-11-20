@file:OptIn(UnstableApi::class)

package com.chitram.app.player

import android.media.MediaCodecList
import androidx.media3.common.C
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.MergingMediaSource
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Source

/**
 * H13: Android hybrid. One provider's picture with Castle or NetMirror Telugu
 * audio when the playing row has no Telugu, merged on the device by media3
 * (server equivalent: utils/hybridStream.js, /hybrid/pair).
 *
 * The merged source is [video, audio]; MergingMediaPeriod names each child's
 * track groups "<child>:<id>", so the picture's video is a "0:" group and the
 * Telugu audio a "1:" group. A Castle audio half also carries the TsAudioSwap,
 * so its first AAC PID is Telugu.
 *
 * Sync: no PTS shift. The server rebases Castle audio by its start PTS
 * (ptsRebase.js, 1.478556s on Devara) because hls.js aligns renditions by raw
 * PTS. media3 gives each HlsMediaSource its own TimestampAdjuster, set to the
 * playlist time of the first segment it loads, so both halves start at 0 (and
 * at the same playlist time after a seek). See V126Test.
 */
object HybridPair {
    /** Extra audio shift for a merged pair, in microseconds. Measured as 0 for TS+TS. */
    const val OFFSET_US = 0L
    private val AUDIO_HALVES = listOf("castletv", "netmirror")
    private val AUDIO_MIME = mapOf("mp4a" to "audio/mp4a-latm", "ac-3" to "audio/ac3", "ec-3" to "audio/eac3", "opus" to "audio/opus")

    /**
     * The Telugu (`want`) row to pair with [current], or null. Offered only when
     * the picture has no `want` audio, the audio row is Castle or NetMirror, and
     * the device decodes both the picture's video and the audio row's audio.
     */
    fun candidate(current: Source, sources: List<Source>, want: String, codecs: CodecSupport, audioDecoders: Set<String>?): Source? {
        if (current.hybrid || current.unsupported) return null
        if (current.languages.any { it.equals(want, true) }) return null
        if (codecs.supports(current.videoCodec, current.codecString) == false) return null
        return sources.asSequence()
            .filter { it.id != current.id && !it.unsupported && !it.hybrid }
            .filter { !it.provider.equals(current.provider, true) }
            .filter { s -> s.languages.any { it.equals(want, true) } }
            .filter { audioDecodes(it.codecString, audioDecoders) }
            .mapNotNull { s -> AUDIO_HALVES.indexOf(s.provider.lowercase()).takeIf { it >= 0 }?.let { it to s } }
            .sortedBy { it.first }
            .firstOrNull()?.second
    }

    /** No codec info: AAC (Castle, NetMirror). Otherwise every audio codec listed needs a decoder. */
    fun audioDecodes(codecString: String?, decoders: Set<String>?): Boolean {
        if (decoders == null) return true
        val need = codecString?.split(',')?.map { it.trim().lowercase() }
            ?.mapNotNull { c -> AUDIO_MIME.entries.firstOrNull { c.startsWith(it.key) }?.value }.orEmpty()
        return need.all { it in decoders }
    }

    fun merge(video: MediaSource, audio: MediaSource): MediaSource =
        // No period offset adjustment and no clipping: both VOD periods start at 0,
        // and the window (duration, metadata) is the picture's.
        MergingMediaSource(false, false, video, audio)

    /**
     * Track overrides for a merged pair: every video track of the picture (ABR
     * kept) and the `want` audio from the audio half, else that half's first
     * audio track. Null until both halves have their tracks.
     */
    fun overrides(t: Tracks, want: List<String>): Pair<TrackSelectionOverride, TrackSelectionOverride>? {
        val w = want.map { it.lowercase() }
        val video = t.groups.firstOrNull { it.type == C.TRACK_TYPE_VIDEO && it.mediaTrackGroup.id.startsWith("0:") } ?: return null
        val vIdx = (0 until video.length).filter { video.isTrackSupported(it) }.ifEmpty { return null }
        val audio = t.groups.filter { it.type == C.TRACK_TYPE_AUDIO && it.mediaTrackGroup.id.startsWith("1:") }
        if (audio.isEmpty()) return null
        fun matches(g: Tracks.Group, i: Int): Boolean {
            val f = g.getTrackFormat(i)
            // media3 normalises "tel" to "te": compare the code, its English name and the label.
            val code = f.language?.lowercase()?.substringBefore('-')
            val name = code?.let { java.util.Locale(it).getDisplayLanguage(java.util.Locale.ENGLISH).lowercase() }
            return code in w || name in w || f.label?.lowercase() in w
        }
        val hit = audio.firstNotNullOfOrNull { g -> (0 until g.length).firstOrNull { g.isTrackSupported(it) && matches(g, it) }?.let { g to it } }
            ?: audio.firstNotNullOfOrNull { g -> (0 until g.length).firstOrNull { g.isTrackSupported(it) }?.let { g to it } }
            ?: return null
        return TrackSelectionOverride(video.mediaTrackGroup, vIdx) to TrackSelectionOverride(hit.first.mediaTrackGroup, hit.second)
    }

    /** Audio decoder MIME types on this device, or null when unknown. */
    fun deviceAudioDecoders(): Set<String>? = runCatching {
        MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos.filter { !it.isEncoder }
            .flatMap { it.supportedTypes.map(String::lowercase) }.filter { it.startsWith("audio/") }.toSet()
    }.getOrNull()?.takeIf { it.isNotEmpty() }
}
