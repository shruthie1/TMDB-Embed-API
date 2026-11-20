package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.util.TimestampAdjuster
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.source.BaseMediaSource
import androidx.media3.exoplayer.source.MediaPeriod
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.exoplayer.upstream.Allocator
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Source
import com.chitram.app.player.HybridPair
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 1.2.6: H13. Another provider's picture with Castle/NetMirror Telugu audio,
 * merged on the device with media3 MergingMediaSource.
 */
class V126Test {
    private val allCodecs = CodecSupport { _, _ -> true }

    private fun row(id: String, provider: String, langs: List<String>, codecs: String? = null, video: String? = null,
                    unsupported: Boolean = false, selectable: Boolean = false, hybrid: Boolean = false) = Source(
        id = id, provider = provider, label = "", url = "https://x/$id.m3u8", progressive = false, quality = "1080p",
        levels = emptyList(), languages = langs, selectableAudio = selectable, hybrid = hybrid, subtitles = emptyList(),
        videoCodec = video, codecString = codecs, unsupported = unsupported,
    )

    private val vaplayer = row("VaPlayer-0", "vaplayer", listOf("Hindi"))
    private val castle = row("CastleTV-0", "CastleTV", listOf("Hindi", "Telugu", "Tamil"))
    private val netmirror = row("netmirror-0", "netmirror", listOf("Telugu", "Hindi"), selectable = true)

    @Test fun offersCastleTeluguWhenThePictureHasNone() {
        val p = HybridPair.candidate(vaplayer, listOf(vaplayer, castle, netmirror), "Telugu", allCodecs, null)
        assertSame(castle, p)
        // NetMirror when Castle is not there.
        assertSame(netmirror, HybridPair.candidate(vaplayer, listOf(vaplayer, netmirror), "Telugu", allCodecs, null))
    }

    @Test fun noPairWhenThePictureAlreadyHasTelugu() {
        val tel = row("mapple-0", "mapple", listOf("Telugu", "Hindi"))
        assertNull(HybridPair.candidate(tel, listOf(tel, castle), "Telugu", allCodecs, null))
    }

    @Test fun noPairUnlessTheDeviceDecodesBoth() {
        val hevc = row("VaPlayer-1", "vaplayer", listOf("Hindi"), video = "hevc")
        assertNull(HybridPair.candidate(hevc, listOf(hevc, castle), "Telugu", { _, _ -> false }, null))
        val ec3 = row("CastleTV-1", "CastleTV", listOf("Telugu"), codecs = "avc1.640028,ec-3")
        assertNull(HybridPair.candidate(vaplayer, listOf(vaplayer, ec3), "Telugu", allCodecs, setOf("audio/mp4a-latm")))
        assertSame(ec3, HybridPair.candidate(vaplayer, listOf(vaplayer, ec3), "Telugu", allCodecs, setOf("audio/mp4a-latm", "audio/eac3")))
        // Unsupported rows and server hybrids never pair.
        assertNull(HybridPair.candidate(vaplayer, listOf(vaplayer, row("c", "CastleTV", listOf("Telugu"), unsupported = true)), "Telugu", allCodecs, null))
        assertNull(HybridPair.candidate(vaplayer, listOf(vaplayer, row("h", "CastleTV", listOf("Telugu"), hybrid = true)), "Telugu", allCodecs, null))
    }

    private class Fake(val name: String) : BaseMediaSource() {
        override fun getMediaItem(): MediaItem = MediaItem.Builder().setMediaId(name).build()
        override fun prepareSourceInternal(mediaTransferListener: TransferListener?) {}
        override fun maybeThrowSourceInfoRefreshError() {}
        override fun createPeriod(id: MediaSource.MediaPeriodId, allocator: Allocator, startPositionUs: Long): MediaPeriod = throw UnsupportedOperationException()
        override fun releasePeriod(mediaPeriod: MediaPeriod) {}
        override fun releaseSourceInternal() {}
    }

    @Test fun mergesPictureFirstThenAudio() {
        val v = Fake("video"); val a = Fake("audio")
        val m = HybridPair.merge(v, a)
        assertTrue(m is MergingMediaSource)
        val f = MergingMediaSource::class.java.getDeclaredField("mediaSources").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val children = (f.get(m) as Array<MediaSource>).toList()
        assertEquals(listOf<MediaSource>(v, a), children)
        // The window is the picture's: metadata, duration and the timeline come from child 0.
        assertEquals("video", m.mediaItem.mediaId)
    }

    private fun group(id: String, vararg f: Format, selected: Int = -1) = Tracks.Group(
        TrackGroup(id, *f), f.size > 1, IntArray(f.size) { C.FORMAT_HANDLED }, BooleanArray(f.size) { it == selected },
    )

    private fun video(h: Int) = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setHeight(h).setWidth(h * 16 / 9).build()
    private fun audio(lang: String) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).build()

    @Test fun selectsThePicturesVideoAndTheTeluguAudio() {
        // MergingMediaPeriod prefixes each child's group ids with "<child index>:".
        val tracks = Tracks(listOf(
            group("0:main", video(1080), video(720), selected = 0),
            group("0:audio", audio("hin"), selected = 0),
            group("1:main", video(720)),
            // HLS keeps each language in its own group (media3 refuses mixed-language groups).
            group("1:hin", audio("hin")),
            group("1:tel", audio("tel")),
        ))
        val o = HybridPair.overrides(tracks, listOf("tel", "Telugu"))
        assertNotNull(o)
        val (v, a) = o!!
        assertEquals("0:main", v.mediaTrackGroup.id)
        assertEquals(listOf(0, 1), v.trackIndices)
        assertEquals("1:tel", a.mediaTrackGroup.id)
        assertEquals(listOf(0), a.trackIndices)
    }

    @Test fun muxedCastleAudioWithoutATagStillComesFromTheAudioHalf() {
        val tracks = Tracks(listOf(group("0:main", video(1080)), group("0:a", audio("hin")), group("1:main", video(720)), group("1:a", audio("und"))))
        val (_, a) = HybridPair.overrides(tracks, listOf("tel"))!!
        assertEquals("1:a", a.mediaTrackGroup.id)
        assertEquals(listOf(0), a.trackIndices)
    }

    @Test fun noOverridesUntilBothHalvesHaveTracks() {
        assertNull(HybridPair.overrides(Tracks(listOf(group("0:main", video(1080)))), listOf("tel")))
    }

    /**
     * Offset measurement. The server rebases Castle audio by -1.478556s
     * (utils/ptsRebase.js: showsst video starts at PTS 0, Castle at 1.478556)
     * because hls.js aligns separate renditions by raw PTS. media3 gives every
     * HLS source its own TimestampAdjuster, initialised to the segment's playlist
     * start time, so each half is rebased to 0 on its own. The raw PTS
     * difference never reaches the merged timeline: a TS+TS pair needs no shift.
     */
    @Test fun media3RebasesEachHalfSoTsPlusTsNeedsNoOffset() {
        fun pts(sec: Double) = Math.round(sec * 90_000)
        val segmentStartUs = 0L // first segment of a VOD playlist
        val video = TimestampAdjuster(segmentStartUs)   // showsst / VaPlayer half
        val audio = TimestampAdjuster(segmentStartUs)   // Castle half, its own HlsMediaSource
        val v0 = video.adjustTsTimestamp(pts(0.0))
        val a0 = audio.adjustTsTimestamp(pts(1.478556))
        assertEquals(0L, v0)
        assertEquals(0L, a0)
        // 2500 s in, the shift held constant on the server (1.40-1.48s): still aligned here.
        assertEquals(video.adjustTsTimestamp(pts(2500.0)), audio.adjustTsTimestamp(pts(2501.478556)))
        assertEquals(0L, HybridPair.OFFSET_US)
        // Resume mid-film: both halves start from the same playlist time, so they agree again.
        val vMid = TimestampAdjuster(1_200_000_000L); val aMid = TimestampAdjuster(1_200_000_000L)
        assertEquals(vMid.adjustTsTimestamp(pts(1200.0)), aMid.adjustTsTimestamp(pts(1201.478556)))
    }
}
