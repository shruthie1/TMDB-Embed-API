package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.PairCodecs
import com.chitram.app.data.PairOutcome
import com.chitram.app.data.RawAudio
import com.chitram.app.data.RawStream
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import com.chitram.app.player.AddAudio
import com.chitram.app.player.HybridPair
import com.chitram.app.player.LoadingModel
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Step 2 Task 6: the on-device merge fallback for "Add <L> audio", its duration gate and its language gate. */
class HybridPairFallbackTest {
    private val codecs = CodecSupport { _, _ -> true }
    private fun row(provider: String, vararg langs: String, i: Int = 0): Source =
        Ranking.toSource(RawStream(url = "https://fixture/$provider-$i.m3u8", provider = provider,
            audio = langs.map { RawAudio(language = it) }, selectableAudio = true), i, codecs)!!

    private val picture = row("Mapple", "Hindi")
    private val d1 = row("CastleTV", "Telugu", "Hindi", i = 1)
    private val d2 = row("OneTouch", "Telugu", "Hindi", i = 2)
    private fun ok() = PairOutcome.Ok("https://vm/hybrid/x/master.m3u8", PairCodecs(listOf("avc1.640028"), "mp4a.40.2"), false, 0.2)
    private fun run(donors: List<Source>, pic: Source = picture, totalMs: Long = LoadingModel.ADD_AUDIO_TOTAL_MS, tryMs: Long = LoadingModel.ADD_AUDIO_TRY_MS) =
        AddAudio.Run("Telugu", donors, pic, System.currentTimeMillis(), totalMs, tryMs)

    /** A VOD media playlist of [seconds], in 10 s segments plus the remainder. */
    private fun media(seconds: Int): String = buildString {
        append("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n")
        var left = seconds.toDouble(); var n = 0
        while (left > 0) { val d = minOf(10.0, left); append("#EXTINF:$d,\nseg${n++}.ts\n"); left -= d }
        append("#EXT-X-ENDLIST\n")
    }

    // ---- (a) duration gate -------------------------------------------------------

    @Test fun theDurationGateIsFifteenSecondsOnSummedExtinf() {
        assertEquals(15, HybridPair.DURATION_TOLERANCE_S)
        assertEquals(7200.0, HybridPair.playlistSeconds(media(7200))!!, 0.001)
        assertEquals(7216.0, HybridPair.playlistSeconds(media(7216))!!, 0.001)
        assertNotNull(HybridPair.durationRefusal(7200.0, 7216.0))
        assertNull(HybridPair.durationRefusal(7200.0, 7210.0))
        // The server's rule is `delta > tolerance`: 15 s apart still pairs.
        assertNull(HybridPair.durationRefusal(7215.0, 7200.0))
        // No padded rule on the device (OFFSET_US = 0): a short half is refused, not padded.
        assertEquals(0L, HybridPair.OFFSET_US)
        assertNotNull(HybridPair.durationRefusal(7200.0, 7000.0))
    }

    @Test fun anUnreadableHalfIsRefused() {
        assertNotNull(HybridPair.durationRefusal(null, 7200.0))
        assertNotNull(HybridPair.durationRefusal(7200.0, null))
        assertNull(HybridPair.playlistSeconds("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n"))
    }

    @Test fun aMasterIsFollowedToItsFirstMediaPlaylistWithTheRowsOwnFetch() = runBlocking {
        val master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\nv/720.m3u8\n"
        val asked = ArrayList<String>()
        val pages = mapOf("https://h/a/master.m3u8" to master, "https://h/a/v/720.m3u8" to media(7210))
        val s = HybridPair.mediaSeconds("https://h/a/master.m3u8", progressive = false) { asked += it; pages[it] }
        assertEquals(7210.0, s!!, 0.001)
        assertEquals(listOf("https://h/a/master.m3u8", "https://h/a/v/720.m3u8"), asked)
        // A progressive file has no playlist: its duration is unknown, so the gate refuses it.
        assertNull(HybridPair.mediaSeconds("https://h/a.mp4", progressive = true) { error("no fetch for mp4") })
        // A failed fetch is unknown too.
        assertNull(HybridPair.mediaSeconds("https://h/x.m3u8", progressive = false) { null })
    }

    @Test fun theDeviceGateReadsBothHalvesThenCompares() = runBlocking {
        val v = picture.copy(url = "https://p/v.m3u8"); val a = d1.copy(url = "https://d/a.m3u8")
        val pages = mapOf(v.url to media(7200), a.url to media(7216))
        assertNotNull(HybridPair.deviceGate(v, a) { s -> { u -> assertTrue(u.startsWith(s.url.substringBeforeLast('/'))); pages[u] } })
        val close = mapOf(v.url to media(7200), a.url to media(7210))
        assertNull(HybridPair.deviceGate(v, a) { _ -> { u -> close[u] } })
    }

    // ---- (b) language gate: no any-track fallback ------------------------------------

    private fun group(id: String, vararg f: Format) = Tracks.Group(TrackGroup(id, *f), false, IntArray(f.size) { C.FORMAT_HANDLED }, BooleanArray(f.size))
    private fun video() = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setHeight(720).build()
    private fun audio(lang: String?, label: String? = null) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).setLabel(label).build()

    @Test fun overridesNeverPickATrackInAnotherLanguage() {
        val noTelugu = Tracks(listOf(group("0:main", video()), group("1:main", video()), group("1:hin", audio("hin")), group("1:tam", audio("tam"))))
        assertNull(HybridPair.overrides(noTelugu, listOf("te", "Telugu")))
        assertEquals(HybridPair.Pick.NoMatch, HybridPair.pick(noTelugu, listOf("te", "Telugu")))
        // An untagged track is not Telugu either.
        val untagged = Tracks(listOf(group("0:main", video()), group("1:a", audio("und"))))
        assertEquals(HybridPair.Pick.NoMatch, HybridPair.pick(untagged, listOf("te", "Telugu")))
        val withTelugu = Tracks(listOf(group("0:main", video()), group("1:hin", audio("hin")), group("1:tel", audio("te"))))
        val (_, a) = HybridPair.overrides(withTelugu, listOf("te", "Telugu"))!!
        assertEquals("1:tel", a.mediaTrackGroup.id)
        // A label-only Telugu track counts (Ranking.trackMatches).
        val labelled = Tracks(listOf(group("0:main", video()), group("1:x", audio(null, "Telugu"))))
        assertEquals("1:x", HybridPair.overrides(labelled, listOf("te"))!!.second.mediaTrackGroup.id)
    }

    @Test fun beforeTheAudioHalfHasTracksThePickWaits() {
        assertEquals(HybridPair.Pick.Pending, HybridPair.pick(Tracks(listOf(group("0:main", video()))), listOf("te")))
        assertEquals(HybridPair.Pick.Pending, HybridPair.pick(Tracks.EMPTY, listOf("te")))
    }

    // ---- (c) when the device merge runs ------------------------------------------------

    @Test fun unreachableFallsBackToTheDeviceForTheSameDonor() = runBlocking {
        val merged = ArrayList<String>()
        val hit = AddAudio.run(run(listOf(d1, d2)), tryOne = { PairOutcome.Unreachable("HTTP 503") }, onTry = { _, _, _ -> },
            device = { merged += it.id; true })
        assertEquals(listOf(d1.id), merged)
        assertEquals(d1.id, hit?.donor?.id)
        assertTrue(hit!!.onDevice)
        assertNull(hit.ok)
    }

    @Test fun refusedNeverFallsBackToTheDevice() = runBlocking {
        val merged = ArrayList<String>()
        val r = run(listOf(d1, d2))
        val hit = AddAudio.run(r, tryOne = { if (it.id == d1.id) PairOutcome.Refused("no Telugu") else ok() }, onTry = { _, _, _ -> },
            device = { merged += it.id; true })
        assertTrue(merged.isEmpty())
        assertEquals(d2.id, hit?.donor?.id)
        assertFalse(hit!!.onDevice)
    }

    @Test fun aRefusedDeviceGateIsAFailedDonor() = runBlocking {
        val r = run(listOf(d1, d2))
        val hit = AddAudio.run(r, tryOne = { PairOutcome.Unreachable("x") }, onTry = { _, _, _ -> },
            device = { it.id == d2.id })
        assertEquals(d2.id, hit?.donor?.id)
        assertEquals(setOf(d1.id, d2.id), r.tried)
        assertEquals(false, r.deviceOutcomes[d1.id])
    }

    @Test fun aDeviceResolvedHalfSkipsTheServerEvenWhenItIsUp() = runBlocking {
        val asked = ArrayList<String>(); val merged = ArrayList<String>()
        val deviceDonor = d1.copy(onDevice = "vaplayer", headers = mapOf("Referer" to "https://v/"))
        val hit = AddAudio.run(run(listOf(deviceDonor)), tryOne = { asked += it.id; ok() }, onTry = { _, _, _ -> },
            device = { merged += it.id; true })
        assertTrue(asked.isEmpty()); assertEquals(listOf(deviceDonor.id), merged); assertTrue(hit!!.onDevice)
        // Same when the picture itself was resolved on the device.
        asked.clear(); merged.clear()
        val devicePicture = picture.copy(onDevice = "mapple")
        val h2 = AddAudio.run(run(listOf(d2), pic = devicePicture), tryOne = { asked += it.id; ok() }, onTry = { _, _, _ -> },
            device = { merged += it.id; true })
        assertTrue(asked.isEmpty()); assertEquals(listOf(d2.id), merged); assertTrue(h2!!.onDevice)
        assertTrue(AddAudio.deviceResolved(devicePicture, d2))
        assertFalse(AddAudio.deviceResolved(picture, d2))
    }

    @Test fun aServerTimeoutFallsBackAndTheDeviceTryIsBoundedToo() = runBlocking {
        val merged = ArrayList<String>()
        val r = run(listOf(d1, d2, row("VaPlayer", "Telugu", i = 3)), totalMs = 600, tryMs = 150)
        val t0 = System.currentTimeMillis()
        val hit = AddAudio.run(r, tryOne = { awaitCancellation() }, onTry = { _, _, _ -> },
            device = { merged += it.id; awaitCancellation() })
        val took = System.currentTimeMillis() - t0
        assertNull(hit)
        // Server timeout -> device try for the same donor; both bounded; the 600 ms budget ends the run.
        assertEquals(PairOutcome.Unreachable("timeout"), r.outcomes[d1.id])
        assertEquals(d1.id, merged.first())
        assertTrue("took $took", took in 550..2_000)
        assertTrue("tried ${r.tried.size}", r.tried.size <= 3)
    }

    @Test fun aCancelDuringTheDeviceTryNeverReturnsALateHit() = runBlocking {
        val r = run(listOf(d1))
        val hit = AddAudio.run(r, tryOne = { PairOutcome.Unreachable("x") }, onTry = { _, _, _ -> },
            device = { r.cancel(); true })
        assertNull(hit)
    }

    @Test fun deviceRowsAreDonorsOnTheDevicePath() {
        val device = d1.copy(onDevice = "vaplayer")
        val all = listOf(picture, device, d2)
        assertEquals(listOf(d2.id), AddAudio.donors(all, "Telugu", picture).map { it.id })
        assertEquals(listOf(device.id, d2.id), AddAudio.donors(all, "Telugu", picture, onDevicePath = true).map { it.id })
        // A playing device row gets offers from this path.
        val playing = picture.copy(onDevice = "mapple")
        assertEquals(listOf("Telugu"), AddAudio.offers(listOf(playing, d2), playing, emptySet(), onDevicePath = true).map { it.first })
        // AUDIO_HALVES does not limit the fallback: any provider with L is a donor.
        val other = row("Zeta", "Telugu", i = 9)
        assertEquals(listOf(other.id), AddAudio.donors(listOf(picture, other), "Telugu", picture, onDevicePath = true).map { it.id })
    }

    @Test fun thePairRowIsTheFusedMasterOrThePictureNeverTheDonor() {
        val fused = AddAudio.pairSource(picture, AddAudio.Hit(d1, ok()), "Telugu")
        assertEquals(picture.id, fused.id); assertTrue(fused.hybrid)
        val device = AddAudio.pairSource(picture, AddAudio.Hit(d1, null), "Telugu")
        assertEquals(picture, device)
    }
}
