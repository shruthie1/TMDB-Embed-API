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
import com.chitram.app.data.Ranking
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
    /**
     * Step 2 Task 6: the on-device merge's duration gate, in seconds. Equal to the
     * server's DURATION_TOLERANCE_SECONDS default (utils/hybridStream.js:48; a
     * guard test fails when that changes). No padded rule here: the device has no
     * offset correction (OFFSET_US = 0), so a short half is refused, not padded.
     */
    const val DURATION_TOLERANCE_S = 15
    private val AUDIO_HALVES = listOf("castletv", "netmirror")
    private val AUDIO_MIME = mapOf("mp4a" to "audio/mp4a-latm", "ac-3" to "audio/ac3", "ec-3" to "audio/eac3", "opus" to "audio/opus")

    /**
     * The Telugu (`want`) row to pair with [current], or null. Offered only when
     * the picture has no `want` audio, the audio row is Castle or NetMirror, and
     * the device decodes both the picture's video and the audio row's audio.
     */
    fun candidate(current: Source, sources: List<Source>, want: String, codecs: CodecSupport, audioDecoders: Set<String>?): Source? {
        if (current.hybrid || current.unsupported) return null
        if (current.languages.any { Ranking.sameLanguage(it, want) }) return null
        if (codecs.supports(current.videoCodec, current.codecString) == false) return null
        return sources.asSequence()
            .filter { it.id != current.id && !it.unsupported && !it.hybrid }
            .filter { !it.provider.equals(current.provider, true) }
            .filter { s -> s.languages.any { Ranking.sameLanguage(it, want) } }
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

    /** What a merged pair's tracks allow. */
    sealed interface Pick {
        /** The halves have not both reported tracks yet. */
        data object Pending : Pick
        /** Both halves are known and the audio half has no playable track in the language: a failed try. */
        data object NoMatch : Pick
        data class Pin(val video: TrackSelectionOverride, val audio: TrackSelectionOverride) : Pick
    }

    /**
     * Every video track of the picture (ABR kept) and the `want` audio from the
     * audio half. No any-track fallback (Task 6 ruling): a half with no track
     * whose tag or label is `want` is [Pick.NoMatch], never another language.
     */
    fun pick(t: Tracks, want: List<String>): Pick {
        val w = want.mapNotNull(Ranking::canonLang).toSet()
        val video = t.groups.firstOrNull { it.type == C.TRACK_TYPE_VIDEO && it.mediaTrackGroup.id.startsWith("0:") } ?: return Pick.Pending
        // MergingMediaPeriod reports tracks once every child is prepared: no "1:" group means not yet.
        if (t.groups.none { it.mediaTrackGroup.id.startsWith("1:") }) return Pick.Pending
        val vIdx = (0 until video.length).filter { video.isTrackSupported(it) }.ifEmpty { return Pick.NoMatch }
        val audio = t.groups.filter { it.type == C.TRACK_TYPE_AUDIO && it.mediaTrackGroup.id.startsWith("1:") }
        fun matches(g: Tracks.Group, i: Int): Boolean {
            val f = g.getTrackFormat(i)
            // media3 normalises "tel" to "te": tag or label language, one canonical key (Ranking.trackMatches).
            return w.any { Ranking.trackMatches(f.language, f.label, it) }
        }
        val hit = audio.firstNotNullOfOrNull { g -> (0 until g.length).firstOrNull { g.isTrackSupported(it) && matches(g, it) }?.let { g to it } }
            ?: return Pick.NoMatch
        return Pick.Pin(TrackSelectionOverride(video.mediaTrackGroup, vIdx), TrackSelectionOverride(hit.first.mediaTrackGroup, hit.second))
    }

    /** [pick]'s pin as a pair; null while pending and when no track is in the language. */
    fun overrides(t: Tracks, want: List<String>): Pair<TrackSelectionOverride, TrackSelectionOverride>? =
        (pick(t, want) as? Pick.Pin)?.let { it.video to it.audio }

    /** Sum of #EXTINF in a media playlist, in seconds; null when it has none (a master, or junk). */
    fun playlistSeconds(text: String): Double? {
        var sum = 0.0; var any = false
        for (l in text.lineSequence()) {
            val t = l.trim()
            if (!t.startsWith("#EXTINF:")) continue
            val d = t.removePrefix("#EXTINF:").substringBefore(',').trim().toDoubleOrNull() ?: continue
            sum += d; any = true
        }
        return if (any) sum else null
    }

    /**
     * Duration of the row at [url] from its media playlist, read with [fetch] (the
     * row's own headers and token). A master is followed to its first variant. A
     * progressive file or a failed read is null: unknown, and the gate refuses it.
     */
    suspend fun mediaSeconds(url: String, progressive: Boolean, fetch: suspend (String) -> String?): Double? {
        if (progressive) return null
        val text = fetch(url) ?: return null
        mpdSeconds(text)?.let { return it }
        playlistSeconds(text)?.let { return it }
        val variant = com.chitram.app.resolve.Hls.parse(text, url).firstVariant ?: return null
        return fetch(variant)?.let(::playlistSeconds)
    }

    /** A DASH MPD's mediaPresentationDuration (PT#H#M#S), in seconds; null when [text] is not an MPD or has none. */
    fun mpdSeconds(text: String): Double? {
        if (!text.contains("<MPD")) return null
        val d = Regex("""mediaPresentationDuration="P(?:(\d+(?:\.\d+)?)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?"""").find(text) ?: return null
        val (day, h, m, s) = d.destructured
        val total = (day.toDoubleOrNull() ?: 0.0) * 86400 + (h.toDoubleOrNull() ?: 0.0) * 3600 + (m.toDoubleOrNull() ?: 0.0) * 60 + (s.toDoubleOrNull() ?: 0.0)
        return total.takeIf { it > 0 }
    }

    /** Null when the two halves agree within [DURATION_TOLERANCE_S] (server rule: refuse when delta > tolerance), else why not. */
    fun durationRefusal(video: Double?, audio: Double?): String? {
        if (video == null || audio == null) return "duration unknown (video ${video ?: "?"} s, audio ${audio ?: "?"} s)"
        val delta = kotlin.math.abs(video - audio)
        return if (delta > DURATION_TOLERANCE_S) "durations differ by ${"%.1f".format(java.util.Locale.ROOT, delta)} s (video $video s, audio $audio s)" else null
    }

    /** Task 6 gate before an on-device merge: read both halves' playlists, then compare. Null = merge allowed. */
    suspend fun deviceGate(video: Source, audio: Source, fetchFor: (Source) -> suspend (String) -> String?): String? {
        val v = mediaSeconds(video.url, video.progressive, fetchFor(video))
        val a = if (v == null) null else mediaSeconds(audio.url, audio.progressive, fetchFor(audio))
        return durationRefusal(v, a)
    }

    /** Audio decoder MIME types on this device, or null when unknown. */
    fun deviceAudioDecoders(): Set<String>? = runCatching {
        MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos.filter { !it.isEncoder }
            .flatMap { it.supportedTypes.map(String::lowercase) }.filter { it.startsWith("audio/") }.toSet()
    }.getOrNull()?.takeIf { it.isNotEmpty() }
}
