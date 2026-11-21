package com.chitram.app

import androidx.media3.common.C
import com.chitram.app.data.Api
import com.chitram.app.data.Source
import com.chitram.app.player.LoadMarks
import com.chitram.app.player.PlayerVm
import com.chitram.app.player.StartRace
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** first-play-slow.md fixes A (race extras), B (SlowCallLog split), C (hedged streams GET), D (log lines). */
class FirstPlayFixesTest {
    private fun row(id: String, provider: String, lang: String) =
        Source(id, provider, provider, "https://x/$id.m3u8", false, "1080p", emptyList(), listOf(lang), false, false, emptyList(), null, null, false, onDevice = provider)

    // ---- A ---------------------------------------------------------------------

    /** RRR: VM stalls, no device row has Telugu, mapple runs 20 s. Vidrift starts at the lead end and starts the film. */
    @Test fun rrrLikeStallStartsExtrasAtLeadEndAndDoesNotWaitForMapple() = runBlocking {
        val lead = 800L
        val vm = CompletableDeferred<List<Source>>() // never answers
        val castle = async { delay(100); listOf(row("nm", "netmirror", "Hindi")) }
        val mapple = async { delay(20_000); emptyList<Source>() }
        val t0 = System.currentTimeMillis()
        val calls = mutableListOf<Pair<String, Long>>()
        val first = StartRace(leadMs = lead).firstMany(vm, listOf(castle, mapple), "Telugu") { why ->
            calls += why to System.currentTimeMillis() - t0
            listOf(async { delay(300); listOf(row("vr", "vidrift", "Telugu")) })
        }
        val ms = System.currentTimeMillis() - t0
        assertEquals("extras start once", 1, calls.size)
        assertTrue("extras at the lead end (${calls[0].second}ms)", calls[0].second in lead until lead + 400)
        assertTrue(calls[0].first.contains("lead"))
        assertTrue("film starts on the Telugu row, not after mapple ($ms ms)", ms < lead + 1_000)
        assertTrue(first.backendPending)
        assertTrue(first.device.any { it.id == "vr" })
        mapple.cancel()
    }

    /** VM fails before the lead ends: extras start then, once, and the race waits for their Telugu row. */
    @Test fun vmFailureStartsExtrasOnceBeforeLeadEnd() = runBlocking {
        val vm = CompletableDeferred<List<Source>>()
        launch { delay(200); vm.completeExceptionally(java.io.IOException("timeout")) }
        val mapple = async { delay(20_000); emptyList<Source>() }
        val t0 = System.currentTimeMillis()
        var n = 0
        var at = 0L
        val first = StartRace(leadMs = 5_000).firstMany(vm, listOf(mapple), "Telugu") { why ->
            n++; at = System.currentTimeMillis() - t0
            assertEquals("VM failed", why)
            listOf(async { delay(200); listOf(row("vr", "vidrift", "Telugu")) })
        }
        assertEquals(1, n)
        assertTrue("at $at ms", at < 1_000)
        assertTrue(first.backendError != null)
        assertEquals(listOf("vr"), first.device.map { it.id })
        assertTrue(System.currentTimeMillis() - t0 < 2_000)
        mapple.cancel()
    }

    /** A Telugu device row inside the lead: no extras, and the VM still leads (fix E is not made). */
    @Test fun teluguDeviceRowKeepsTheFullVmLeadAndStartsNoExtras() = runBlocking {
        val vm = async { delay(600); listOf(row("vm-castle", "CastleTV", "Telugu").copy(onDevice = null)) }
        val castle = async { delay(50); listOf(row("dev-castle", "CastleTV", "Telugu")) }
        var n = 0
        val first = StartRace(leadMs = 2_000).firstMany(vm, listOf(castle), "Telugu") { n++; emptyList() }
        assertEquals(0, n)
        assertFalse(first.backendPending)
        assertEquals(listOf("vm-castle"), first.backend.map { it.id })
    }

    /** VM answered without Telugu: a ready Telugu device row ends the wait at once, not after the grace. */
    @Test fun goodDeviceRowEndsTheGraceWait() = runBlocking {
        val vm = CompletableDeferred(listOf(row("vm-hi", "vidrock", "Hindi").copy(onDevice = null)))
        val tel = CompletableDeferred(listOf(row("dev-te", "castletv", "Telugu")))
        val slow = async { delay(20_000); emptyList<Source>() }
        val t0 = System.currentTimeMillis()
        val first = StartRace(graceMs = 3_000).firstMany(vm, listOf(tel, slow), "Telugu")
        assertTrue(System.currentTimeMillis() - t0 < 1_000)
        assertEquals(listOf("dev-te"), first.device.map { it.id })
        slow.cancel()
    }

    @Test fun playerVmWiresExtrasIntoTheRaceAndJoinsThemLate() {
        val vm = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        assertTrue(vm.contains("firstMany(vm, device, preferred, extras ="))
        assertTrue("late joins cover jobs started in the race", vm.contains("lateJobs = (deviceJobs + listOfNotNull(deviceLate))"))
    }

    // ---- B ---------------------------------------------------------------------

    @Test fun slowCallLineCarriesHeaderAndBodyTimes() {
        val l = com.chitram.app.data.SlowCallLog.line("vm/api/streams/movie/579974", "failed InterruptedIOException", 22_000, 64, 174, 1_150, -1)
        assertEquals("slow http: vm/api/streams/movie/579974 failed InterruptedIOException in 22000ms (dns 64ms, connect 174ms, headers 1150ms, body -1ms)", l)
    }

    // ---- C ---------------------------------------------------------------------

    private fun api(server: MockWebServer, hedgeMs: Long) =
        Api(OkHttpClient(), vmBase = server.url("").toString().trimEnd('/'), streamsHedgeMs = hedgeMs, streamsCallTimeoutMs = 10_000)

    @Test fun noHeadersHedgesOnAFreshConnectionAndTheFirstAnswerWins() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.enqueue(MockResponse().setBody("""{"streams":[]}"""))
        server.start()
        val t0 = System.currentTimeMillis()
        val resp = api(server, 400).streams("movie", 579974)
        val ms = System.currentTimeMillis() - t0
        assertTrue(resp.streams.isEmpty())
        assertTrue("answered by the hedge ($ms ms)", ms < 2_000)
        assertEquals(2, server.requestCount)
        val a = server.takeRequest(); val b = server.takeRequest()
        assertEquals("same GET", a.path, b.path)
        assertEquals("hedge is the first request on its own connection", 0, b.sequenceNumber)
        server.shutdown()
    }

    @Test fun quickHeadersNeverHedge() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"streams":[]}"""))
        server.start()
        api(server, 400).streams("movie", 1)
        Thread.sleep(600)
        assertEquals(1, server.requestCount)
        server.shutdown()
    }

    @Test fun onlyGetIsHedged() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("ok").setHeadersDelay(800, java.util.concurrent.TimeUnit.MILLISECONDS))
        server.start()
        val a = api(server, 200)
        val post = Request.Builder().url(server.url("/x")).post(okhttp3.RequestBody.create(null, ByteArray(0))).build()
        assertEquals("ok", a.hedged(OkHttpClient(), post, 200))
        assertEquals(1, server.requestCount)
        server.shutdown()
    }

    // ---- D ---------------------------------------------------------------------

    @Test fun logLinesHaveGreppablePrefixes() {
        assertEquals("play: start movie/579974 at=1700000000000", PlayerVm.startLine("movie", 579974, 0, 0, 1_700_000_000_000))
        assertEquals("play: start tv/1399 s2e3 at=5", PlayerVm.startLine("tv", 1399, 2, 3, 5))
        assertEquals("play: master 412ms (+430ms since play) embed.vidrift.net/api/orion/abc/master.m3u8",
            PlayerVm.loadLine("master", 412, 430, "https://embed.vidrift.net/api/orion/abc/master.m3u8?t=1"))
        assertTrue(PlayerVm.loadLine("variant", 1, 2, "https://h/v0.m3u8").startsWith("play: variant 1ms"))
        assertTrue(PlayerVm.loadLine("seg0", 1, 2, "https://h/s0.m4s").startsWith("play: seg0 1ms"))
        assertEquals("play: first-frame total=9800ms provider=vidrift sincePlay=2600ms", PlayerVm.firstFrameLine(9_800, "vidrift", 2_600))
    }

    @Test fun loadMarksNameEachFirstLoadOnce() {
        val m = LoadMarks()
        assertEquals("master", m.mark(C.DATA_TYPE_MANIFEST))
        assertEquals("variant", m.mark(C.DATA_TYPE_MANIFEST))
        assertNull(m.mark(C.DATA_TYPE_MANIFEST))
        assertEquals("seg0", m.mark(C.DATA_TYPE_MEDIA_INITIALIZATION))
        assertNull(m.mark(C.DATA_TYPE_MEDIA))
        m.reset()
        assertEquals("master", m.mark(C.DATA_TYPE_MANIFEST))
    }
}
