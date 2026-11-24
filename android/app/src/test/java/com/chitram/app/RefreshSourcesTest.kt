package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.player.LoadingModel
import com.chitram.app.player.RefreshModel
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.SourceRefresh
import com.chitram.app.resolve.StreamCache
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * "Refresh sources" (owner 2026-11-22): kept rows dropped, providers and the VM
 * (refresh=1, once) asked anew, one refresh per title per 30 s, and the
 * idle -> refreshing -> result -> cooldown journey. MultiMovies and the VM are a
 * MockWebServer; every other host gets a local 404 (no real network, no NetMirror).
 */
class RefreshSourcesTest {
    private val server = MockWebServer()
    private val hits = CopyOnWriteArrayList<String>()
    /** Full VM request paths, query included. */
    private val vmPaths = CopyOnWriteArrayList<String>()
    private val codecs = CodecSupport { _, _ -> null }
    private var clock = 1_800_000_000_000L
    private var vmToken = "a"
    /** No network: every host, the local server too, fails on DNS. */
    @Volatile private var down = false
    @Volatile private var offline = false
    private val client = OkHttpClient.Builder().addInterceptor(Interceptor { ch ->
        val u = ch.request().url
        hits += "${u.host}${u.encodedPath}"
        if (down) throw java.net.UnknownHostException(u.host)
        if (u.host == "127.0.0.1" || u.host == "localhost") ch.proceed(ch.request())
        else Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(404).message("fake").body("".toResponseBody()).build()
    }).build()

    private lateinit var kv: MemoryKeyValue
    private lateinit var cache: StreamCache
    private lateinit var od: OnDeviceResolver
    private lateinit var api: Api
    private lateinit var refresh: SourceRefresh
    private lateinit var mm: String

    @Before fun setup() {
        MultiMoviesResolver.resetServerState()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path.startsWith("/api/resolve")) return MockResponse().setBody(
                    """{"stream":{"server":"x","sources":[{"url":"$mm/hi.m3u8","kind":"hls","quality":"1080p","language":"Hindi"},{"url":"$mm/te.m3u8","kind":"hls","quality":"1080p","language":"Telugu"}]}}""")
                if (path == "/hi.m3u8" || path == "/te.m3u8") return MockResponse().setBody(Fixtures.read("multimovies/rrr-bridge-telugu.m3u8"))
                if (path.startsWith("/api/streams/")) {
                    vmPaths += path
                    return MockResponse().setBody(
                        """{"success":true,"count":1,"streams":[{"url":"$mm/vm/te-$vmToken.m3u8","provider":"castletv","name":"Castle","quality":"1080p",
                           "languages":["Telugu","Hindi"],"audio":[{"language":"Telugu","languageCode":"te","codec":"mp4a"}],"codecs":"avc1.640028,mp4a.40.2"}]}""")
                }
                return MockResponse().setResponseCode(404)
            }
        }
        server.start()
        mm = server.url("").toString().trimEnd('/')
        kv = MemoryKeyValue()
        cache = StreamCache(kv) { clock }
        api = Api(client, base = "https://catalog.test", vmBase = mm, streamCache = cache)
        val store = ResolveConfigStore(client, "https://vm.test" + ResolveConfigStore.PATH, kv, remoteUrl = "https://catalog.test" + ResolveConfigStore.REMOTE_PATH)
        val hosts = HostBook(kv)
        od = OnDeviceResolver(
            Api(client, base = "https://catalog.test", vmBase = "https://vm.test"), store, MappleResolver(client, hosts, kv), VaplayerResolver(client, hosts) { null },
            castle = CastleResolver(client, hosts = hosts),
            multimovies = MultiMoviesResolver(client, origin = mm),
            cache = cache,
            offline = { offline },
        ) { clock }
        refresh = SourceRefresh(od, vm = { t, i, s, e -> api.streams(t, i, s, e, refresh = true) }, vmUp = { true }) { clock }
    }

    @After fun stop() = server.shutdown()

    private val key = StreamCache.key("movie", 579974, 0, 0)
    private fun mmCalls() = hits.count { it.endsWith("/api/resolve") }
    private fun mmRows() = runBlocking { withTimeout(30_000) { od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs, "Telugu", originalLang = "te") } }
    private fun run(): SourceRefresh.Result = runBlocking {
        withTimeout(60_000) { refresh.run("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te", also = listOf(OnDeviceResolver.MULTIMOVIES)) }
    }

    @Test fun refreshDropsKeptRowsAndAsksProvidersAgain() {
        mmRows()
        runBlocking { api.streams("movie", 579974) }
        val afterFirst = mmCalls()
        // A plain second resolve is a cache hit: 0 requests.
        mmRows()
        assertEquals("hit gives 0 requests", afterFirst, mmCalls())
        assertNotNull(cache.device(key, OnDeviceResolver.MULTIMOVIES, "Telugu"))
        val oldUrls = cache.urls(key)
        vmToken = "b"
        val res = run() as SourceRefresh.Done
        assertTrue("fresh MultiMovies requests on refresh: ${mmCalls() - afterFirst}", mmCalls() - afterFirst > 0)
        assertEquals("kept urls reported", oldUrls, res.kept)
        assertEquals(2, res.device.count { it.onDevice.equals(OnDeviceResolver.MULTIMOVIES, true) })
        // Stored rows replaced by the new ones: the VM answer is the new one.
        assertTrue(cache.vm(key, full = false)!!.streams.single().url!!.endsWith("te-b.m3u8"))
        assertNotNull(cache.device(key, OnDeviceResolver.MULTIMOVIES, "Telugu"))
        // Telugu tags intact.
        assertTrue(res.device.any { "Telugu" in it.languages })
    }

    @Test fun refreshSendsRefresh1ToTheVmExactlyOnce() {
        runBlocking { api.streams("movie", 579974) }
        assertEquals(1, vmPaths.size)
        val res = run() as SourceRefresh.Done
        val during = vmPaths.drop(1)
        assertEquals("one VM call per refresh: $during", 1, during.size)
        assertTrue(during.single(), during.single().contains("refresh=1"))
        assertNotNull(res.vm)
        assertFalse(res.failed)
    }

    @Test fun secondTapWithin30sIsThrottled() {
        assertTrue(run() is SourceRefresh.Done)
        val before = hits.size
        clock += SourceRefresh.COOLDOWN_MS - 1
        val second = run()
        assertTrue("second tap inside 30 s: $second", second is SourceRefresh.Throttled)
        assertEquals("0 requests when throttled", before, hits.size)
        assertEquals(clock + 1, (second as SourceRefresh.Throttled).readyAt)
        clock += 1
        assertTrue(run() is SourceRefresh.Done)
        // Another episode is another title: not throttled by this one.
        assertTrue(runBlocking { refresh.run("movie", 1, 0, 0, codecs, "Telugu") } is SourceRefresh.Done)
    }

    @Test fun refreshDropsPrewarmJobs() {
        od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        val jobs = od.prewarmJobs()
        assertTrue(jobs.isNotEmpty())
        run()
        assertTrue("no prewarm job left to reuse", od.prewarmJobs().isEmpty())
        assertTrue(jobs.all { it.isCancelled })
    }

    @Test fun vmFailureAndNoRowsIsAFailedRefresh() {
        val down = SourceRefresh(od, vm = { _, _, _, _ -> throw java.io.IOException("down") }, vmUp = { true }) { clock }
        val res = runBlocking { withTimeout(60_000) { down.run("movie", 999, 0, 0, codecs, "Telugu") } } as SourceRefresh.Done
        assertNull(res.vm)
        assertTrue(res.device.isEmpty())
        assertTrue(res.failed)
    }

    /** Gap 10.5: Refresh tapped offline. The kept rows survive, no breaker counts, the line says so. */
    @Test fun offlineRefreshKeepsKeptRows() {
        mmRows()
        runBlocking { api.streams("movie", 579974) }
        val keptDevice = cache.device(key, OnDeviceResolver.MULTIMOVIES, "Telugu")
        val keptVm = cache.vm(key, full = false)
        assertNotNull(keptDevice); assertNotNull(keptVm)
        down = true; offline = true
        val res = run() as SourceRefresh.Done
        assertTrue(res.failed)
        assertEquals("Couldn't refresh. Try again.", RefreshModel.outcome(res.kept, res.device, res.failed, "Telugu"))
        assertEquals("kept device rows survive", keptDevice, cache.device(key, OnDeviceResolver.MULTIMOVIES, "Telugu"))
        assertEquals("kept VM answer survives", keptVm, cache.vm(key, full = false))
        for (n in od.names(vmDown = true)) assertFalse("$n paused", od.isOpen(n))
        // Online again, after the cooldown: the refresh replaces the rows.
        down = false; offline = false
        clock += SourceRefresh.COOLDOWN_MS
        vmToken = "b"
        val ok = run() as SourceRefresh.Done
        assertFalse(ok.failed)
        assertTrue(cache.vm(key, full = false)!!.streams.single().url!!.endsWith("te-b.m3u8"))
    }

    /** Gap 10.5: online, the VM fails but a provider answers: the kept VM answer stays. */
    @Test fun aFailedVmRefreshKeepsTheKeptVmAnswer() {
        runBlocking { api.streams("movie", 579974) }
        val keptVm = cache.vm(key, full = false)
        val down = SourceRefresh(od, vm = { _, _, _, _ -> throw java.io.IOException("down") }, vmUp = { true }) { clock }
        val res = runBlocking { withTimeout(60_000) { down.run("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te", also = listOf(OnDeviceResolver.MULTIMOVIES)) } } as SourceRefresh.Done
        assertFalse(res.failed)
        assertEquals(keptVm, cache.vm(key, full = false))
    }

    /** Gap 10.10: a refresh waits for mapple's late Telugu row (fake mapple, row at 1.5 s). */
    @Test fun refreshWaitsForMapplesLateTeluguRow() = runBlocking {
        val kv2 = MemoryKeyValue()
        val mapple = object : MappleResolver(client, HostBook(kv2), kv2) {
            override suspend fun resolve(cfg: com.chitram.app.resolve.MappleConfig, type: String, tmdbId: Long, season: Int, episode: Int,
                                         preferred: String, fresh: Boolean, later: Later?): com.chitram.app.resolve.Resolved? {
                fun row(l: String) = com.chitram.app.resolve.Resolved("mapple", "mapple $l", "https://m.test/$l.m3u8", emptyMap(), null, emptyList(), emptyList(), null, key = "mapple-$l", languages = listOf(l))
                if (later != null) { later.handedOff = true; later.scope.launch { kotlinx.coroutines.delay(1_500); later.deliver(row("Telugu")) } }
                return row("Hindi")
            }
        }
        val store = ResolveConfigStore(client, "https://vm.test" + ResolveConfigStore.PATH, kv2)
        val od2 = OnDeviceResolver(null, store, mapple, VaplayerResolver(client, HostBook(kv2)) { null }, cache = StreamCache(kv2) { clock }) { clock }
        val answered = CopyOnWriteArrayList<Pair<String, Int>>()
        val rows = withTimeout(30_000) { od2.refreshAll(listOf(OnDeviceResolver.MAPPLE), "movie", 77, 0, 0, codecs, "Telugu") { n, c -> answered += n to c } }
        assertEquals(setOf(listOf("Hindi"), listOf("Telugu")), rows.map { it.languages }.toSet())
        assertEquals(OnDeviceResolver.MAPPLE to 2, answered.last())
        // Kept with the late row, as a live resolve would add it.
        val kept = withTimeout(5_000) {
            var n: Int? = null
            while (n != 2) { kotlinx.coroutines.delay(50); n = StreamCache(kv2) { clock }.device(StreamCache.key("movie", 77, 0, 0), OnDeviceResolver.MAPPLE, "Telugu")?.size }
            n
        }
        assertEquals(2, kept)
    }

    /** Gap 10.3: refresh while a row plays. The playing row is never switched; auto-start only from the failure card. */
    @Test fun applyRefreshKeepsThePlayingRow() {
        val a = src("a", "u-a", listOf("Telugu"))
        val b = src("b", "u-b", listOf("Telugu"))
        val keep = { list: List<Source>, cur: Source -> list + cur }
        // Playing A; the new answer has only B: A stays listed, nothing starts.
        val playing = RefreshModel.apply(listOf(b), failed = false, current = a, errored = false, keep = keep)
        assertEquals(listOf("b", "a"), playing.list!!.map { it.id })
        assertNull(playing.start)
        // A is in the new answer: listed once, still nothing starts.
        val again = RefreshModel.apply(listOf(a, b), failed = false, current = a, errored = false, keep = keep)
        assertEquals(listOf("a", "b"), again.list!!.map { it.id })
        assertNull(again.start)
        // Failure card: the best new row starts.
        val failedCard = RefreshModel.apply(listOf(b), failed = false, current = a, errored = true, keep = keep)
        assertEquals(listOf("b"), failedCard.list!!.map { it.id })
        assertEquals("b", failedCard.start!!.id)
        // Nothing came back: the old list stays (null), nothing starts.
        val none = RefreshModel.apply(emptyList(), failed = true, current = a, errored = false, keep = keep)
        assertNull(none.list); assertNull(none.start)
        // PlayerVm.applyRefresh uses this helper and plays only its `start`.
        val vm = listOf(java.io.File("src/main/java/com/chitram/app/player/PlayerVm.kt"), java.io.File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        val body = vm.substringAfter("private fun applyRefresh(").substringBefore("\n    }\n")
        assertTrue(body.contains("RefreshModel.apply("))
        assertEquals(1, Regex("""\bplay\(""").findAll(body).count())
        assertTrue(body.contains("plan.start?.let { first ->"))
    }

    // ---- Journey state (RefreshModel) ------------------------------------------

    private fun src(id: String, url: String, langs: List<String>) =
        Source(id, "CastleTV", "CastleTV", url, false, "1080p", emptyList(), langs, false, false, emptyList(), null, null, false)

    @Test fun idleRefreshingUpdatedCooldownIdle() {
        val t0 = 1_000_000L
        var m = RefreshModel()
        assertEquals(RefreshModel.State.IDLE, m.state(t0))
        assertEquals("Refresh sources", m.label(t0))
        m = m.start(t0, t0 + SourceRefresh.COOLDOWN_MS)
        assertEquals(RefreshModel.State.REFRESHING, m.state(t0 + 100))
        assertEquals("Refreshing…", m.label(t0 + 100))
        m = m.answered("castletv", 2).answered("mapple", 1)
        assertEquals("castletv 2 · mapple 1", m.chips())
        val after = listOf(src("a", "u1", listOf("Telugu")), src("b", "u2", listOf("Hindi")), src("c", "u3", listOf("Telugu", "Hindi")))
        m = m.finish(t0 + 5_000, RefreshModel.outcome(setOf("old"), after, failed = false, preferred = "Telugu"))
        assertEquals("Updated: 3 sources (2 Telugu)", m.noteAt(t0 + 5_000))
        // Result hides after ~3 s.
        assertNull(m.noteAt(t0 + 5_000 + RefreshModel.NOTE_MS))
        assertEquals(RefreshModel.State.COOLDOWN, m.state(t0 + 5_000))
        assertEquals("Refresh again in 25s", m.label(t0 + 5_000))
        assertEquals("Refresh again in 1s", m.label(t0 + 29_500))
        assertEquals(RefreshModel.State.IDLE, m.state(t0 + SourceRefresh.COOLDOWN_MS))
        assertEquals("Refresh sources", m.label(t0 + SourceRefresh.COOLDOWN_MS))
    }

    @Test fun noChangeFailedAndEmptyResults() {
        val rows = listOf(src("a", "u1", listOf("Telugu")))
        assertEquals("No new sources", RefreshModel.outcome(setOf("u1"), rows, failed = false, preferred = "Telugu"))
        assertEquals("Couldn't refresh. Try again.", RefreshModel.outcome(setOf("u1"), emptyList(), failed = true, preferred = "Telugu"))
        assertEquals("No sources found yet", RefreshModel.outcome(setOf("u1"), emptyList(), failed = false, preferred = "Telugu"))
        assertEquals("Updated: 1 source (1 Telugu)", RefreshModel.outcome(emptySet(), rows, failed = false, preferred = "Telugu"))
    }

    @Test fun pressDuringCooldownSaysWhenAndStaysAControl() {
        val t0 = 1_000_000L
        val m = RefreshModel().start(t0, t0 + 30_000).finish(t0 + 2_000, "No new sources").blocked(t0 + 10_000, t0 + 30_000)
        assertFalse(m.running)
        assertEquals("Refresh again in 20s", m.noteAt(t0 + 10_000))
        assertEquals("Refresh again in 20s", m.label(t0 + 10_000))
    }

    @Test fun autoStartOnlyWhenTheCurrentSourceHadFailed() {
        val rows = listOf(src("a", "u1", listOf("Telugu")))
        // Something plays: never switched by a refresh.
        assertFalse(RefreshModel.autoStart(errored = false, rows = rows))
        // Failure card: the best new row starts.
        assertTrue(RefreshModel.autoStart(errored = true, rows = rows))
        assertFalse(RefreshModel.autoStart(errored = true, rows = emptyList()))
    }

    @Test fun failureCardOffersRefreshAndTvFocusStartsThere() {
        val list = listOf(src("a", "u1", listOf("Telugu")))
        fun input(failed: Boolean, sources: List<Source>?, attempts: List<LoadingModel.Attempt>) = LoadingModel.Input(
            now = 90_000, playAt = 0, title = "RRR", preferred = "Telugu", sources = sources, labels = LoadingModel.labelRows(emptyMap(), list),
            firstListSize = sources?.size ?: 0, attempts = attempts, checks = emptyList(), framed = false, failed = failed,
        )
        val failed = LoadingModel.view(input(true, list, listOf(LoadingModel.Attempt("a", 0, 1, LoadingModel.RowState.FAILED, LoadingModel.Reason.NO_ANSWER))))
        assertEquals("Couldn't play any source", failed.headline)
        assertTrue(failed.showTryAgain && failed.showPickSource)
        assertEquals(LoadingModel.Focus.REFRESH, LoadingModel.tvFocus(failed))
        val empty = LoadingModel.view(input(true, emptyList(), emptyList()))
        assertEquals("No sources found for RRR", empty.headline)
        assertTrue(empty.showTryAgain)
        assertFalse(empty.showPickSource)
        assertEquals(LoadingModel.Focus.REFRESH, LoadingModel.tvFocus(empty))
        val loading = LoadingModel.view(input(false, null, emptyList()))
        assertFalse(loading.phase == LoadingModel.Phase.FAILED)
        assertEquals(LoadingModel.Focus.DETAILS, LoadingModel.tvFocus(loading))
    }
}
