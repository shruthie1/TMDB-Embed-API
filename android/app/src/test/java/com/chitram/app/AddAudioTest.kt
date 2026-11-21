package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.PairCodecs
import com.chitram.app.data.PairOutcome
import com.chitram.app.data.RawAudio
import com.chitram.app.data.RawStream
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import com.chitram.app.player.AddAudio
import com.chitram.app.player.LoadingModel
import com.chitram.app.player.PlayerVm
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Step 2 Task 5: the explicit "Add <L> audio from another server" journey (phone and Fire TV share it). */
class AddAudioTest {
    private val codecs = CodecSupport { _, _ -> true }

    private fun row(provider: String, vararg langs: String, selectable: Boolean = true, i: Int = 0): Source =
        Ranking.toSource(RawStream(url = "https://fixture/$provider-$i.m3u8", provider = provider,
            audio = langs.map { RawAudio(language = it) }, selectableAudio = selectable), i, codecs)!!

    private val picture = row("Mapple", "Hindi")
    private fun ok(url: String = "https://vm/hybrid/x/master.m3u8") = PairOutcome.Ok(url, PairCodecs(listOf("avc1.640028"), "mp4a.40.2"), padded = false, delta = 0.2)
    private fun run(donors: List<Source>, totalMs: Long = LoadingModel.ADD_AUDIO_TOTAL_MS, tryMs: Long = LoadingModel.ADD_AUDIO_TRY_MS) =
        AddAudio.Run("Telugu", donors, picture, System.currentTimeMillis(), totalMs, tryMs)

    // ---- Offers and donors (mirrors web Task 3) ---------------------------------

    @Test fun teTelAndTeluguAreOneOffer() {
        val a = row("CastleTV", "te", "Hindi"); val b = row("OneTouch", "tel", "Tamil", i = 1); val c = row("VaPlayer", "Telugu", "English", i = 2)
        val offers = AddAudio.offers(listOf(picture, a, b, c), picture, emptySet())
        val telugu = offers.filter { Ranking.sameLanguage(it.first, "Telugu") }
        assertEquals(1, telugu.size)
        assertEquals(listOf(a.id, b.id, c.id), telugu.single().second.map { it.id })
    }

    // Fix wave I4: web addAudio.js donorsFrom order. Rows whose matching rendition
    // has a uri first, then index order inside each group; then the cap of 3.
    @Test fun donorsWithARenditionUriComeFirstLikeWeb() {
        fun uriRow(provider: String, i: Int, uri: String?) = Ranking.toSource(RawStream(url = "https://fixture/$provider-$i.m3u8", provider = provider,
            audio = listOf(RawAudio(language = "Telugu", uri = uri)), selectableAudio = true), i, codecs)!!
        val r1 = uriRow("A1", 1, null); val r2 = uriRow("A2", 2, null); val r3 = uriRow("A3", 3, null)
        val r4 = uriRow("A4", 4, "https://fixture/a4-te.m3u8"); val r5 = uriRow("A5", 5, "https://fixture/a5-te.m3u8")
        val donors = AddAudio.donors(listOf(picture, r1, r2, r3, r4, r5), "Telugu", picture)
        assertEquals(listOf(r4.id, r5.id, r1.id), donors.map { it.id })
        val offer = AddAudio.offers(listOf(picture, r1, r2, r3, r4, r5), picture, emptySet()).first { Ranking.sameLanguage(it.first, "Telugu") }
        assertEquals(listOf(r4.id, r5.id, r1.id), offer.second.map { it.id })
    }

    @Test fun everyMissingLanguageIsOfferedTeluguFirst() {
        val tamil = row("OneTouch", "Tamil", "Kannada")
        val telugu = row("CastleTV", "Telugu", "Hindi", i = 1)
        val offers = AddAudio.offers(listOf(picture, tamil, telugu), picture, emptySet())
        assertEquals(listOf("Telugu", "Tamil", "Kannada"), offers.map { it.first })
    }

    @Test fun fixedAudioOnDeviceSameProviderAndCurrentAreNotDonors() {
        val fixed = row("Fixed", "Telugu", selectable = false)
        val device = row("Device", "Telugu", "Hindi").copy(onDevice = "vaplayer")
        val sameProvider = row("Mapple", "Telugu", "Hindi", i = 3)
        val good = row("CastleTV", "Telugu", "Hindi", i = 4)
        val sources = listOf(picture, fixed, device, sameProvider, good)
        assertEquals(listOf(good.id), AddAudio.donors(sources, "te", picture).map { it.id })
        assertTrue(AddAudio.offers(listOf(picture, fixed, device), picture, emptySet()).isEmpty())
    }

    @Test fun donorsAreCappedAtThreeAndSkipFailed() {
        val rows = (1..5).map { row("P$it", "Telugu", "Hindi", i = it) }
        val all = listOf(picture) + rows
        assertEquals(rows.take(3).map { it.id }, AddAudio.donors(all, "Telugu", picture).map { it.id })
        assertEquals(rows.drop(1).take(3).map { it.id }, AddAudio.donors(all, "Telugu", picture, setOf(rows[0].id)).map { it.id })
        assertEquals(3, AddAudio.offers(all, picture, emptySet()).single { it.first == "Telugu" }.second.size)
    }

    @Test fun aCarriedLanguageIsNeverOffered() {
        val donor = row("CastleTV", "Telugu", "Tamil")
        val offers = AddAudio.offers(listOf(picture, donor), picture, setOf("te"))
        assertEquals(listOf("Tamil"), offers.map { it.first })
    }

    // ---- The run --------------------------------------------------------------

    @Test fun runReturnsTheSecondDonorAfterARefusal() = runBlocking {
        val d1 = row("A", "Telugu", "Hindi", i = 1); val d2 = row("B", "Telugu", "Hindi", i = 2)
        val seen = ArrayList<String>()
        val r = run(listOf(d1, d2))
        val hit = AddAudio.run(r, tryOne = { if (it.id == d1.id) PairOutcome.Refused("no Telugu") else ok() },
            onTry = { d, n, total -> seen += "${d.provider} $n/$total" })
        assertEquals(d2.id, hit?.donor?.id)
        assertEquals(listOf("A 1/2", "B 2/2"), seen)
    }

    @Test fun runGivesNullWhenTheBudgetIsSpentOnStalledTries() = runBlocking {
        // Real-clock stand-in for 30 000 ms (no kotlinx-coroutines-test on the classpath): same rule, small caps.
        val donors = (1..3).map { row("P$it", "Telugu", "Hindi", i = it) }
        val r = run(donors, totalMs = 300, tryMs = 200)
        val t0 = System.currentTimeMillis()
        val hit = AddAudio.run(r, tryOne = { awaitCancellation() }, onTry = { _, _, _ -> })
        val took = System.currentTimeMillis() - t0
        assertNull(hit)
        assertTrue("took $took", took in 280..1_500)
        assertTrue("tried ${r.tried.size}", r.tried.size in 2..3) // 200 + 100: a third try gets at most the last ms
        // The defaults are the shared caps.
        val d = run(donors)
        assertEquals(30_000L, d.totalMs); assertEquals(15_000L, d.tryMs); assertEquals(3, d.pool.size)
    }

    @Test fun anUndecodableAnswerIsAFailedDonor() = runBlocking {
        val d1 = row("A", "Telugu", "Hindi", i = 1); val d2 = row("B", "Telugu", "Hindi", i = 2)
        val hevc = PairOutcome.Ok("https://vm/h1", PairCodecs(listOf("hvc1.1.6.L120.90"), "mp4a.40.2"), false, 0.0)
        val noHevc = CodecSupport { v, c -> if ((c ?: v ?: "").startsWith("hvc1")) false else true }
        val hit = AddAudio.run(run(listOf(d1, d2)), tryOne = { if (it.id == d1.id) hevc else ok() }, onTry = { _, _, _ -> },
            accept = { AddAudio.decodes(it, noHevc, setOf("audio/mp4a-latm")) })
        assertEquals(d2.id, hit?.donor?.id)
        assertFalse(AddAudio.decodes(ok(), codecs, setOf("audio/opus")))
    }

    // ---- Journey: the VM rules (PlayerVm runs these effects and nothing else) ----

    /** Stand-in for PlayerVm: applies effects to a screen, runs checks with scripted answers. */
    private inner class Sim(val sources: List<Source>, val answer: (Source) -> PairOutcome) {
        val j = AddAudio.Journey()
        var screen = AddAudio.Screen(current = picture, audioLanguage = "Hindi", positionMs = 60_000)
        val log = ArrayList<AddAudio.Effect>()
        val played = ArrayList<Source>()
        var notice = ""
        /** PlayerVm addedNotice: shown again at READY; play() clears it. */
        var addedNotice: String? = null
        var pending: AddAudio.Effect.Check? = null
        /** Task 6: the on-device merge try (duration gate); null = no device path. */
        var device: ((Source) -> Boolean)? = null
        fun label(s: Source) = s.provider
        fun apply(effects: List<AddAudio.Effect>) {
            for (e in effects) {
                log += e
                when (e) {
                    // Same rule as PlayerVm.runEffects: held for READY only while not READY.
                    is AddAudio.Effect.Notice -> { notice = e.text; addedNotice = if (e.untilReady && !screen.ready) e.text else null }
                    AddAudio.Effect.CancelCheck -> pending = null
                    is AddAudio.Effect.ClearHeld -> { addedNotice = null; if (e.stale != null && notice == e.stale) notice = "" }
                    is AddAudio.Effect.Check -> pending = e
                    // Each play() starts a stream that has not loaded yet and clears addedNotice.
                    is AddAudio.Effect.PlayPair -> AddAudio.pairSource(e.run.picture, e.hit, e.run.language).let {
                        addedNotice = null
                        played += it; screen = screen.copy(current = it, pairedAudio = e.hit.donor, fused = e.hit.ok != null, audioLanguage = e.run.language, positionMs = 0, loaded = false, ready = false) }
                    is AddAudio.Effect.Restore -> e.fallback.let {
                        addedNotice = null
                        played += it.source; screen = screen.copy(current = it.source, pairedAudio = it.pairedAudio, fused = it.fused, audioLanguage = it.audioLanguage, positionMs = 0, loaded = false, ready = false) }
                    is AddAudio.Effect.PictureOnly -> { addedNotice = null; played += e.picture; screen = screen.copy(current = e.picture, pairedAudio = null, fused = false, positionMs = 0, loaded = false, ready = false) }
                }
            }
        }
        /** The stream on screen reached READY at [pos]: PlayerVm shows addedNotice, else clears the notice. */
        fun ready(pos: Long) { screen = screen.copy(loaded = true, ready = true, positionMs = pos); j.ready(screen); notice = addedNotice ?: ""; addedNotice = null }
        /** A later seek or rebuffer: BUFFERING (the notice is left alone), then READY again. */
        fun rebuffer(pos: Long) { screen = screen.copy(ready = false); ready(pos) }
        /** Let the pending check finish now. */
        fun finish() = runBlocking {
            val c = pending ?: return@runBlocking
            pending = null
            val dev = device
            val hit = AddAudio.run(c.run, tryOne = { answer(it) }, onTry = { d, n, t -> apply(j.checking(c.gen, c.run, LoadingModel.Copy.checkingAudio(c.run.language, d.provider, n, t), screen)) },
                device = dev?.let { f -> val tryDevice: suspend (Source) -> Boolean = { s -> f(s) }; tryDevice })
            apply(j.result(c.gen, c.run, hit, screen, ::label))
        }
        fun tap(lang: String) = apply(j.tap(lang, sources, screen))
        /** The pair on screen fails at [pos]; [loaded]: it had loaded before failing. */
        fun fail(pos: Long = 90_000, loaded: Boolean = true) = j.deviceFailure(screen.copy(positionMs = pos, loaded = loaded)).also { it?.let(::apply) }
    }

    private val d1 = row("CastleTV", "Telugu", "Hindi", i = 1)
    private val d2 = row("OneTouch", "Telugu", "Hindi", i = 2)
    private val d3 = row("VaPlayer", "Telugu", "Hindi", i = 3)
    private val donorIds = setOf(d1.id, d2.id, d3.id)

    @Test fun successPlaysThePairAndAudioAddedReplacesChecking() {
        val sim = Sim(listOf(picture, d1, d2)) { if (it.id == d1.id) PairOutcome.Refused(null) else ok() }
        sim.tap("Telugu")
        assertTrue(sim.pending != null)
        sim.finish()
        val pair = sim.log.filterIsInstance<AddAudio.Effect.PlayPair>().single()
        assertEquals(d2.id, pair.hit.donor.id)
        val added = sim.log.last() as AddAudio.Effect.Notice
        assertEquals("Telugu audio added from OneTouch.", added.text)
        assertTrue(added.untilReady)
        assertEquals(added.text, sim.notice)
        assertEquals(picture, sim.j.onScreen?.pairFallback?.source)
        assertEquals(picture.id, sim.screen.current?.id)
        assertEquals(d2.id, sim.screen.pairedAudio?.id)
    }

    @Test fun aDeviceFailureRestoresAtOnceThenTriesTheNextDonorBehindIt() {
        val sim = Sim(listOf(picture, d1, d2)) { ok("https://vm/${it.provider}") }
        sim.tap("Telugu"); sim.finish()
        val effects = sim.fail(pos = 90_000)!!
        // Playback is back first: same stream, position and audio as before the run.
        val restore = effects.first() as AddAudio.Effect.Restore
        assertEquals(picture, restore.fallback.source)
        assertEquals("Hindi", restore.fallback.audioLanguage)
        assertEquals(90_000L, restore.positionMs)
        assertTrue(effects[1] is AddAudio.Effect.Check)
        assertEquals(picture, sim.screen.current)
        // The next donor answers: swap to it then.
        sim.finish()
        assertEquals(d2.id, sim.screen.pairedAudio?.id)
        assertEquals("Telugu audio added from OneTouch.", sim.notice)
    }

    @Test fun theFinalDeviceFailureOnlySaysNoWorkingAudio() {
        val sim = Sim(listOf(picture, d1)) { ok() }
        sim.tap("Telugu"); sim.finish()
        val effects = sim.fail()!!
        assertEquals(2, effects.size)
        assertTrue(effects[0] is AddAudio.Effect.Restore)
        assertEquals(AddAudio.Effect.Notice("No server has working Telugu audio. Playback is unchanged.", untilReady = true), effects[1])
        assertNull(sim.pending)
        assertEquals(picture, sim.screen.current)
        // The restored stream reaches READY: the notice is still there (I-A).
        sim.ready(90_000)
        assertEquals("No server has working Telugu audio. Playback is unchanged.", sim.notice)
        // A run spent with no play changes nothing: only the notice.
        val none = Sim(listOf(picture, d1)) { PairOutcome.Refused(null) }
        none.tap("Telugu"); none.finish()
        assertTrue(none.played.isEmpty())
        assertEquals("No server has working Telugu audio. Playback is unchanged.", none.notice)
    }

    @Test fun failedDonorsBeforeAWinnerStillCountTowardTheCap() {
        // Controller bug 1: d1 refused, d2 won, d2 failed on the device: only d3 is left, never d1 again.
        val asked = ArrayList<String>()
        val d4 = row("Extra", "Telugu", "Hindi", i = 4)
        val sim = Sim(listOf(picture, d1, d2, d3, d4)) { asked += it.id; if (it.id == d1.id) PairOutcome.Refused(null) else ok() }
        sim.tap("Telugu"); sim.finish()
        assertEquals(listOf(d1.id, d2.id), asked)
        sim.fail(); sim.finish()
        assertEquals(listOf(d1.id, d2.id, d3.id), asked)
        assertEquals("Checking VaPlayer for Telugu audio (3 of 3)…", sim.j.onScreen?.checking)
        // d3 fails too: cap spent, restored, said so.
        val last = sim.fail()!!
        assertTrue(last.first() is AddAudio.Effect.Restore)
        assertTrue(last.last() is AddAudio.Effect.Notice)
    }

    // Fix wave I2: web landed(). The run ends at the pair's first READY; a later
    // failure of that stream is normal recovery, never the add-audio restore.
    @Test fun aFailureAfterThePairWasReadyIsNotTheJourneys() {
        for (merge in listOf(false, true)) {
            val sim = Sim(listOf(picture, d1, d2)) { if (merge) PairOutcome.Unreachable("x") else ok() }
            if (merge) sim.device = { true }
            sim.tap("Telugu"); sim.finish()
            assertEquals(d1.id, sim.screen.pairedAudio?.id)
            sim.ready(30_000)
            assertEquals("Telugu audio added from CastleTV.", sim.notice)
            sim.log.clear()
            // 30 minutes later the pair's segments 403.
            assertNull("merge=$merge", sim.fail(pos = 1_800_000))
            assertTrue(sim.log.none { it is AddAudio.Effect.Restore || it is AddAudio.Effect.PictureOnly || it is AddAudio.Effect.Check })
            assertTrue(sim.log.filterIsInstance<AddAudio.Effect.Notice>().none { it.text.startsWith("No server has working") })
            assertNull(sim.pending)
        }
    }

    @Test fun aFailureBeforeTheFirstReadyStillRestoresAndTriesTheNext() {
        val sim = Sim(listOf(picture, d1, d2)) { ok() }
        sim.tap("Telugu"); sim.finish()
        // READY of some other stream does not land the pair.
        sim.j.ready(sim.screen.copy(current = d2, pairedAudio = null, fused = false))
        val effects = sim.fail(pos = 5_000, loaded = false)!!
        assertTrue(effects.first() is AddAudio.Effect.Restore)
        assertTrue(effects[1] is AddAudio.Effect.Check)
    }

    // Fix wave M4: web joins the run while its pair is still pending.
    @Test fun aSecondTapWhileTheMergeLoadsJoinsTheRun() {
        for (merge in listOf(true, false)) {
            val sim = Sim(listOf(picture, d1, d2)) { if (merge) PairOutcome.Unreachable("x") else ok() }
            if (merge) sim.device = { true }
            sim.tap("Telugu"); sim.finish()
            val run = sim.j.onScreen!!
            assertNull(sim.j.active)
            val again = sim.j.tap("Telugu", sim.sources, sim.screen)
            assertTrue("merge=$merge", again.none { it is AddAudio.Effect.Check || it is AddAudio.Effect.CancelCheck })
            assertEquals(listOf(AddAudio.Effect.Notice(run.checking!!)), again)
            assertSame(run, sim.j.onScreen)
            // Once READY the pair has landed: the same entry is not offered, but a tap is a new run.
            sim.ready(10_000)
            assertTrue(sim.j.tap("Telugu", sim.sources, sim.screen).any { it is AddAudio.Effect.Check })
        }
    }

    @Test fun aPairErrorNeverPlaysTheDonorAlone() {
        for (answers in listOf<(Source) -> PairOutcome>({ ok() }, { if (it.id == d2.id) PairOutcome.Unreachable("x") else ok() })) {
            val sim = Sim(listOf(picture, d1, d2, d3), answers)
            sim.tap("Telugu"); sim.finish()
            repeat(4) { sim.fail(); sim.finish() }
            // Every row put on screen is the picture or its fused master (picture id), never a donor row.
            assertTrue(sim.played.isNotEmpty())
            assertTrue(sim.played.none { it.id in donorIds })
            assertTrue(sim.played.all { it.id == picture.id })
        }
        // Not this journey's pair (an on-device merge, Task 6): the journey does not decide.
        assertNull(AddAudio.Journey().deviceFailure(AddAudio.Screen(picture, pairedAudio = d1, fused = false)))
    }

    @Test fun anyPickCancelsTheCheckAndItsLateSuccessNeverApplies() {
        val picks: List<Pair<String, (AddAudio.Journey) -> List<AddAudio.Effect>>> = listOf(
            "track/server/language pick" to { j -> j.pick() },
            "title or episode change, leave" to { j -> j.drop() },
            "offline" to { j -> j.offline() },
            "another picture" to { j -> j.otherPicture("other") },
        )
        for ((what, event) in picks) {
            val sim = Sim(listOf(picture, d1)) { ok() }
            sim.tap("Telugu")
            val check = sim.pending!!
            assertEquals(what, AddAudio.Effect.CancelCheck, event(sim.j).first())
            assertTrue(what, check.run.cancelled)
            // A success that was already on its way arrives late.
            sim.apply(sim.j.result(check.gen, check.run, AddAudio.Hit(d1, ok()), sim.screen, sim::label))
            assertTrue(what, sim.log.none { it is AddAudio.Effect.PlayPair })
            assertEquals(what, "", sim.notice)
        }
    }

    @Test fun anotherAddEntryCancelsTheFirstButTheSameEntryOnlyRepeats() {
        val tamil = row("OneTouch", "Tamil", "Hindi", i = 5)
        val sim = Sim(listOf(picture, d1, tamil)) { ok() }
        sim.tap("Telugu")
        val first = sim.pending!!
        first.run.checking = "Checking CastleTV for Telugu audio (1 of 1)…"
        sim.tap("te")
        assertEquals(first, sim.pending)
        assertEquals("Checking CastleTV for Telugu audio (1 of 1)…", sim.notice)
        sim.tap("Tamil")
        assertTrue(first.run.cancelled)
        assertEquals("Tamil", sim.pending!!.run.language)
        sim.finish()
        assertEquals(tamil.id, sim.screen.pairedAudio?.id)
    }

    @Test fun aTrackPickDuringASecondCheckKeepsTheFirstPairHandled() {
        // I1: L1 pair on screen, L2 check in flight, viewer picks a track: L2 stops, L1 failures are still handled.
        val tamil = row("OneTouch", "Tamil", "Telugu", i = 5)
        val sim = Sim(listOf(picture, d1, tamil)) { ok("https://vm/${it.provider}") }
        sim.tap("Telugu"); sim.finish()
        val l1 = sim.screen
        sim.tap("Tamil")
        val l2 = sim.pending!!
        assertEquals(AddAudio.Effect.CancelCheck, sim.j.pick().first())
        sim.apply(sim.j.result(l2.gen, l2.run, AddAudio.Hit(tamil, ok()), sim.screen, sim::label))
        assertEquals(l1, sim.screen)
        assertTrue(sim.fail()!!.first() is AddAudio.Effect.Restore)
        assertEquals(picture, sim.screen.current)
    }

    @Test fun offlineNeitherChecksNorRestoresNorBlamesTheServers() {
        val sim = Sim(listOf(picture, d1, d2)) { ok() }
        sim.screen = sim.screen.copy(offline = true)
        sim.tap("Telugu")
        assertTrue(sim.log.isEmpty())
        // A check that ends after the network dropped says nothing.
        sim.screen = sim.screen.copy(offline = false)
        sim.tap("Telugu")
        sim.screen = sim.screen.copy(offline = true)
        sim.finish()
        assertTrue(sim.log.none { (it is AddAudio.Effect.Notice && it.text.startsWith("No server")) || it is AddAudio.Effect.PlayPair })
        assertTrue(sim.log.any { it is AddAudio.Effect.CancelCheck })
        // A pair that fails offline waits for the network: no restore, no check.
        sim.screen = sim.screen.copy(offline = false)
        sim.tap("Telugu"); sim.finish()
        assertEquals(emptyList<AddAudio.Effect>(), sim.j.deviceFailure(sim.screen.copy(offline = true)))
        assertTrue(sim.j.onScreen != null)
    }

    @Test fun leavingOrANewTitleForgetsThePair() {
        val sim = Sim(listOf(picture, d1, d2)) { ok() }
        sim.tap("Telugu"); sim.finish()
        sim.j.drop()
        assertNull(sim.j.onScreen)
        assertNull(sim.fail())
    }

    @Test fun aResultForAnotherPictureNeverApplies() {
        val sim = Sim(listOf(picture, d1)) { ok() }
        sim.tap("Telugu")
        sim.screen = sim.screen.copy(current = d2) // failover moved on without telling the journey
        sim.finish()
        assertTrue(sim.log.none { it is AddAudio.Effect.PlayPair })
    }

    @Test fun aBackwardSeekDuringTheCheckIsKept() {
        val sim = Sim(listOf(picture, d1)) { ok() }
        sim.tap("Telugu") // tapped at 60 000
        sim.screen = sim.screen.copy(positionMs = 30_000) // the viewer seeks back while donors are checked
        sim.finish()
        assertEquals(30_000L, sim.log.filterIsInstance<AddAudio.Effect.PlayPair>().single().positionMs)
    }

    @Test fun aRestoreAfterThePairPlayedLandsWhereTheViewerWas() {
        val sim = Sim(listOf(picture, d1, d2)) { ok() }
        sim.tap("Telugu"); sim.finish()
        // The pair loaded (duration known) and played on to 300 000 but never reached READY,
        // then the device failed: restore there, not at the tap. (After READY it is normal recovery, I2.)
        val restore = sim.fail(pos = 300_000)!!.first() as AddAudio.Effect.Restore
        assertEquals(300_000L, restore.positionMs)
        // The restored stream has not loaded (reads 0) when the next donor answers: the pair starts at 300 000.
        assertFalse(sim.screen.loaded)
        sim.finish()
        assertEquals(300_000L, sim.log.filterIsInstance<AddAudio.Effect.PlayPair>().last().positionMs)
    }

    @Test fun anUnloadedStreamNeverResetsToZero() {
        val sim = Sim(listOf(picture, d1, d2)) { ok() }
        sim.tap("Telugu")
        sim.screen = sim.screen.copy(positionMs = 0, loaded = false)
        sim.finish()
        assertEquals(60_000L, sim.log.filterIsInstance<AddAudio.Effect.PlayPair>().single().positionMs)
        // The pair fails before it loaded (reads 0): restore at the saved 60 000.
        val restore = sim.fail(pos = 0, loaded = false)!!.first() as AddAudio.Effect.Restore
        assertEquals(60_000L, restore.positionMs)
    }

    @Test fun noticesAfterARestoreOutliveTheRestoredStreamsReady() {
        val sim = Sim(listOf(picture, d1, d2)) { if (it.id == d2.id) PairOutcome.Refused(null) else ok() }
        sim.tap("Telugu"); sim.finish() // fails before READY: still the journey's (I2)
        // First check before any restore: an ordinary notice, READY may clear it.
        assertFalse((sim.log.filterIsInstance<AddAudio.Effect.Notice>().first()).untilReady)
        sim.fail(pos = 70_000)
        // The next check's "Checking…" comes after the restore: it must survive READY.
        val c = sim.pending!!
        sim.apply(sim.j.checking(c.gen, c.run, "Checking OneTouch for Telugu audio (2 of 2)…", sim.screen))
        sim.ready(70_000)
        assertEquals("Checking OneTouch for Telugu audio (2 of 2)…", sim.notice)
        // d2 refuses after the restored stream is READY: the failure notice shows now, not held (I-C).
        sim.finish()
        assertEquals("No server has working Telugu audio. Playback is unchanged.", sim.notice)
        assertNull(sim.addedNotice)
    }

    @Test fun noWorkingAudioNeverComesBackAtALaterRebuffer() {
        // Final device failure: held through the restored stream's READY, shown once, then gone.
        val sim = Sim(listOf(picture, d1)) { ok() }
        sim.tap("Telugu"); sim.finish() // fails before READY: still the journey's (I2)
        sim.fail()
        sim.ready(90_000)
        assertEquals("No server has working Telugu audio. Playback is unchanged.", sim.notice)
        sim.rebuffer(120_000)
        assertEquals("", sim.notice)
        // A spent continuation whose restored stream is already READY: shown now, never held.
        val late = Sim(listOf(picture, d1, d2)) { if (it.id == d2.id) PairOutcome.Refused(null) else ok() }
        late.tap("Telugu"); late.finish() // fails before READY: still the journey's (I2)
        late.fail()
        late.ready(90_000) // the restored stream is READY before d2 answers
        late.finish()
        assertEquals("No server has working Telugu audio. Playback is unchanged.", late.notice)
        assertNull(late.addedNotice)
        late.rebuffer(150_000)
        assertEquals("", late.notice)
    }

    @Test fun aCancelledChecksNoticeNeverComesBack() {
        for (cancel in listOf<(AddAudio.Journey) -> List<AddAudio.Effect>>({ it.pick() }, { it.drop() }, { it.offline() })) {
            val sim = Sim(listOf(picture, d1, d2)) { ok() }
            sim.tap("Telugu"); sim.finish() // fails before READY: still the journey's (I2)
            sim.fail() // restore; the next check's "Checking…" is held for the restored stream's READY
            val c = sim.pending!!
            sim.apply(sim.j.checking(c.gen, c.run, "Checking OneTouch for Telugu audio (2 of 2)…", sim.screen))
            assertEquals("Checking OneTouch for Telugu audio (2 of 2)…", sim.addedNotice)
            sim.apply(cancel(sim.j))
            assertNull(sim.addedNotice)
            assertEquals("", sim.notice)
            sim.ready(90_000)
            assertEquals("", sim.notice)
            sim.rebuffer(100_000)
            assertEquals("", sim.notice)
        }
    }

    @Test fun aPerTryTimeoutIsUnreachable() = runBlocking {
        val r = run(listOf(d1), totalMs = 1_000, tryMs = 100)
        assertNull(AddAudio.run(r, tryOne = { awaitCancellation() }, onTry = { _, _, _ -> }))
        assertEquals(PairOutcome.Unreachable("timeout"), r.outcomes[d1.id])
    }

    // ---- Cancel and single flight ------------------------------------------------

    @Test fun aLateSuccessAfterCancelNeverApplies() = runBlocking {
        val d1 = row("A", "Telugu", "Hindi", i = 1)
        val r = run(listOf(d1))
        val gate = CompletableDeferred<Unit>()
        val result = async { AddAudio.run(r, tryOne = { kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await(); ok() } }, onTry = { _, _, _ -> }) }
        yield(); delay(20)
        r.cancel()
        gate.complete(Unit)
        assertNull(result.await())
        assertNull(r.hit)
        // Job cancellation also stops it, and a cancelled run tries nothing more.
        val r2 = run(listOf(d1))
        var applied = false
        val job = launch { AddAudio.run(r2, tryOne = { awaitCancellation() }, onTry = { _, _, _ -> })?.let { applied = true } }
        delay(20); job.cancel(); job.join()
        assertFalse(applied)
        r2.cancel()
        assertTrue(r2.remaining(System.currentTimeMillis()).isEmpty())
    }

    @Test fun twoTriggersAtOnceNeverRunParallelTries() = runBlocking {
        // Controller bug 3: a double tap or a device-failure callback during a try must not start a second run of the list.
        val donors = (1..3).map { row("P$it", "Telugu", "Hindi", i = it) }
        val r = run(donors)
        val calls = java.util.concurrent.atomic.AtomicInteger()
        val gate = CompletableDeferred<Unit>()
        val a = async { AddAudio.run(r, tryOne = { calls.incrementAndGet(); gate.await(); PairOutcome.Refused(null) }, onTry = { _, _, _ -> }) }
        delay(20)
        assertTrue(r.busy)
        val b = AddAudio.run(r, tryOne = { calls.incrementAndGet(); ok() }, onTry = { _, _, _ -> })
        assertNull(b)
        gate.complete(Unit)
        assertNull(a.await())
        assertEquals(3, calls.get())
        assertEquals(3, r.tried.size)
    }

    // ---- Menu --------------------------------------------------------------------

    private fun group(id: String, vararg f: Format, selected: Int = -1) = Tracks.Group(
        TrackGroup(id, *f), false, IntArray(f.size) { C.FORMAT_HANDLED }, BooleanArray(f.size) { it == selected },
    )
    private fun audio(lang: String?) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).build()

    @Test fun audioMenuListsAddHindiUnderItsGroupAndNeverAnInStreamLanguage() {
        val playing = row("Mapple", "Telugu")
        val donor = row("CastleTV", "Telugu", "Hindi", i = 1)
        val tracks = listOf(group("te", audio("te"), selected = 0))
        val items = PlayerVm.audioMenu(tracks, listOf(playing, donor), playing, unnamed = "Telugu", curLang = "Telugu")
        val add = items.single { it.key == "add:Hindi" }
        assertEquals("Add Hindi audio from another server", add.label)
        assertEquals("Add audio from another server", add.group)
        assertEquals(LoadingModel.Copy.ADD_AUDIO_GROUP, add.group)
        assertTrue(items.none { it.key == "add:Telugu" })
        // After the other-server rows.
        assertTrue(items.indexOfFirst { it.group == PlayerVm.OTHER_SERVERS } < items.indexOf(add))
        // Tracks not known yet: the row's own language still counts as in the stream.
        val early = PlayerVm.audioMenu(emptyList(), listOf(playing, donor), playing, unnamed = "Telugu", curLang = "Telugu")
        assertTrue(early.none { it.key == "add:Telugu" })
        assertTrue(early.any { it.key == "add:Hindi" })
        // Keys are unique (LazyColumn keys).
        assertEquals(items.size, items.map { it.key }.toSet().size)
    }

    // ---- Api.pair and the fused row --------------------------------------------

    @Test fun pairPostsTheLanguageAndReadsEachOutcome() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"url":"https://vm/hybrid/abc/master.m3u8","delta":0.4,"padded":true,"codecs":{"video":["avc1.640028"],"audio":"mp4a.40.2"}}"""))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"not pairable","reason":"the audio source has no audio track in the asked language"}"""))
        server.enqueue(MockResponse().setResponseCode(502).setBody("bad gateway"))
        server.enqueue(MockResponse().setResponseCode(404).setBody("nope"))
        server.start()
        try {
            val api = Api(OkHttpClient(), base = "http://vercel.invalid", vmBase = server.url("").toString().trimEnd('/'))
            val d = row("CastleTV", "Telugu", "Hindi", i = 1)
            val first = api.pair(picture, d, "Telugu", 42, "tv")
            assertEquals(PairOutcome.Ok("https://vm/hybrid/abc/master.m3u8", PairCodecs(listOf("avc1.640028"), "mp4a.40.2"), true, 0.4), first)
            val req = server.takeRequest()
            assertEquals("/hybrid/pair", req.path); assertEquals("POST", req.method)
            val body = req.body.readUtf8()
            assertTrue(body, body.contains("\"language\":\"Telugu\"") && body.contains("\"type\":\"series\"") && body.contains("\"tmdbId\":42"))
            assertTrue(body, body.contains("\"url\":\"${picture.url}\"") && body.contains("\"url\":\"${d.url}\""))
            assertEquals(PairOutcome.Refused("the audio source has no audio track in the asked language"), api.pair(picture, d, "Telugu", 42, "movie"))
            assertTrue(api.pair(picture, d, "Telugu", 42, "movie") is PairOutcome.Unreachable)
            // A 4xx other than 409 is the server's answer, not an outage (Task 6 must not fall back on it).
            assertEquals(PairOutcome.Refused("HTTP 404"), api.pair(picture, d, "Telugu", 42, "movie"))
        } finally { server.shutdown() }
        val dead = Api(OkHttpClient(), base = "http://vercel.invalid", vmBase = "http://127.0.0.1:1")
        assertTrue(dead.pair(picture, picture, "Telugu", 1, "movie") is PairOutcome.Unreachable)
    }

    // ---- Task 6: the on-device merge inside the same journey --------------------------

    @Test fun anOnDeviceMergeErrorTriesTheNextDonorThenRestoresNeverTheDonor() {
        // Backend down: every donor goes to the device merge.
        val sim = Sim(listOf(picture, d1, d2)) { PairOutcome.Unreachable("HTTP 502") }
        sim.device = { true }
        sim.tap("Telugu"); sim.finish()
        // The merged pair is the picture row with the donor as its audio half, not fused.
        assertEquals(picture, sim.screen.current)
        assertEquals(d1.id, sim.screen.pairedAudio?.id)
        assertFalse(sim.screen.fused)
        assertEquals("Telugu audio added from CastleTV.", sim.notice)
        // The merged pair errors: restore at once, then the next donor behind it.
        val e1 = sim.fail(pos = 90_000)!!
        val restore = e1.first() as AddAudio.Effect.Restore
        assertEquals(picture, restore.fallback.source)
        assertNull(restore.fallback.pairedAudio)
        assertEquals(90_000L, restore.positionMs)
        assertTrue(e1[1] is AddAudio.Effect.Check)
        sim.finish()
        assertEquals(d2.id, sim.screen.pairedAudio?.id)
        // The last one errors too: back to the pairFallback, no donor left, said so.
        val e2 = sim.fail(pos = 120_000)!!
        assertEquals(AddAudio.Effect.Restore(restore.fallback, 120_000), e2.first())
        assertEquals(AddAudio.Effect.Notice("No server has working Telugu audio. Playback is unchanged.", untilReady = true), e2.last())
        assertNull(sim.screen.pairedAudio)
        assertTrue(sim.played.none { it.id in donorIds })
        assertTrue(sim.played.all { it.id == picture.id })
    }

    @Test fun anOnDevicePairKeepsEveryJourneyRule() {
        // Caps across continuations: refused d1, device d2 fails on the device, only d3 is left.
        val asked = ArrayList<String>()
        val d4 = row("Extra", "Telugu", "Hindi", i = 4)
        val sim = Sim(listOf(picture, d1, d2, d3, d4)) { asked += it.id; if (it.id == d1.id) PairOutcome.Refused(null) else PairOutcome.Unreachable("x") }
        sim.device = { true }
        sim.tap("Telugu"); sim.finish()
        assertEquals(d2.id, sim.screen.pairedAudio?.id)
        sim.fail(); sim.finish()
        assertEquals(listOf(d1.id, d2.id, d3.id), asked)
        assertEquals(d3.id, sim.screen.pairedAudio?.id)
        assertTrue(sim.fail()!!.last() is AddAudio.Effect.Notice)
        // A cancel (any pick) while the device try is out: the late merge never applies.
        val late = Sim(listOf(picture, d1)) { PairOutcome.Unreachable("x") }
        late.device = { late.apply(late.j.pick()); true }
        late.tap("Telugu"); late.finish()
        assertTrue(late.played.isEmpty())
        assertNull(late.screen.pairedAudio)
        // A second pair on top of a device pair: its fallback is the device pair, restored as a device pair.
        val stack = Sim(listOf(picture, d1, row("OneTouch", "Tamil", i = 5))) { PairOutcome.Unreachable("x") }
        stack.device = { true }
        stack.tap("Telugu"); stack.finish(); stack.ready(70_000)
        stack.tap("Tamil"); stack.finish()
        val back = stack.fail()!!.first() as AddAudio.Effect.Restore
        assertEquals(d1.id, back.fallback.pairedAudio?.id)
        assertFalse(back.fallback.fused)
    }

    @Test fun theFusedRowKeepsThePictureIdentityAndTheServerUrl() {
        val withHeaders = picture.copy(headers = mapOf("Referer" to "x"), segmentToken = "t")
        val s = AddAudio.fusedSource(withHeaders, AddAudio.Hit(row("CastleTV", "Telugu", i = 1), ok()), "Telugu")
        assertEquals(picture.id, s.id)
        assertEquals("https://vm/hybrid/x/master.m3u8", s.url)
        assertTrue(s.hybrid && s.headers.isEmpty() && s.segmentToken == null && s.onDevice == null && !s.progressive)
        assertEquals("Telugu", s.languages.first())
    }
}
