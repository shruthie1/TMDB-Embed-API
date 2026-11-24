package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.NetmirrorResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.ResolveConfig
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Details-page prewarm (prewarm.md): the config's prewarm providers resolve on
 * the device when the page opens, with zero VM calls; Play then continues from
 * those jobs instead of fetching again. Every outside host is faked by an
 * interceptor (404) except MultiMovies, served by a MockWebServer with 2 rows.
 */
class PrewarmTest {
    private val server = MockWebServer()
    private val hits = CopyOnWriteArrayList<String>()
    private val codecs = CodecSupport { _, _ -> null }
    private var clock = 1_000_000L
    /** Every host fails on DNS (no network), the local server too. */
    @Volatile private var down = false
    /** What the device's connectivity check says. */
    @Volatile private var offline = false

    /** Records every request; the local MockWebServer answers for real, every other host 404s. */
    private val client = OkHttpClient.Builder().addInterceptor(Interceptor { ch ->
        val u = ch.request().url
        hits += "${u.host}${u.encodedPath}"
        if (down) throw java.net.UnknownHostException(u.host)
        if (u.host == "127.0.0.1" || u.host == "localhost") ch.proceed(ch.request())
        else Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(404).message("fake").body("".toResponseBody()).build()
    }).build()

    private lateinit var od: OnDeviceResolver
    private lateinit var mm: String

    @Before fun setup() {
        MultiMoviesResolver.resetServerState()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path.startsWith("/api/resolve")) return MockResponse().setBody(
                    """{"stream":{"server":"x","sources":[{"url":"$mm/hi.m3u8","kind":"hls","quality":"1080p","language":"Hindi"},{"url":"$mm/te.m3u8","kind":"hls","quality":"1080p","language":"Telugu"}]}}""")
                if (path == "/hi.m3u8" || path == "/te.m3u8") return MockResponse().setBody(Fixtures.read("multimovies/rrr-bridge-telugu.m3u8"))
                return MockResponse().setResponseCode(404)
            }
        }
        server.start()
        mm = server.url("").toString().trimEnd('/')
        val kv = MemoryKeyValue()
        // Catalog (Vercel) and VM on distinct fake hosts, so a VM call is countable.
        val api = Api(client, base = "https://catalog.test", vmBase = "https://vm.test")
        val store = ResolveConfigStore(client, "https://vm.test" + ResolveConfigStore.PATH, kv, remoteUrl = "https://catalog.test" + ResolveConfigStore.REMOTE_PATH)
        val hosts = HostBook(kv)
        od = OnDeviceResolver(
            api, store, MappleResolver(client, hosts, kv), VaplayerResolver(client, hosts) { null },
            castle = CastleResolver(client, hosts = hosts),
            multimovies = MultiMoviesResolver(client, origin = mm),
            netmirror = NetmirrorResolver(client, now = { clock }),
            offline = { offline },
        ) { clock }
    }

    @After fun stop() = server.shutdown()

    private fun vmCalls() = hits.count { it.startsWith("vm.test") }
    private fun count(host: String) = hits.count { it.startsWith(host) }
    private fun waitPrewarm() = runBlocking { withTimeout(60_000) { od.prewarmJobs().forEach { runCatching { it.await() } } } }

    @Test fun defaultsAreTheFiveOnDeviceTeluguProvidersNotVaplayer() {
        assertEquals(setOf("mapple", "vidrift", "multimovies", "castletv", "netmirror"), ResolveConfig().prewarm)
        // Order follows the launch order; every one has a resolver on this device.
        assertEquals(listOf("mapple", "netmirror", "castletv", "multimovies", "vidrift"), od.prewarmNames())
    }

    @Test fun configPrewarmIsPerSectionAndMissingOrBadIsTheBuiltInDefault() {
        val c = ResolveConfig.parse(
            """{"version":3,"mapple":{"prewarm":true},"vaplayer":{"prewarm":"true"},"netmirror":{"enabled":true},
               "castletv":{"prewarm":false},"multimovies":{"prewarm":1},"vidrift":{"prewarm":true},"showsst":{"prewarm":true}}""")
        // vaplayer "true" (string) and multimovies 1 are bad: the built-in default (vaplayer off,
        // multimovies on). netmirror without the field: its default (on). onetouchtv absent: off.
        // castletv false and showsst true are booleans: they win.
        assertEquals(setOf("mapple", "vidrift", "showsst", "netmirror", "multimovies"), c.prewarm)
        assertEquals(3, c.version)
        // The shipped JSON: version 4 and the five defaults on, vaplayer off.
        for (f in listOf("../routes/resolve-config.json", "../web/public/resolve-config.json", "../../routes/resolve-config.json", "../../web/public/resolve-config.json")) {
            val file = File(f).takeIf { it.exists() } ?: continue
            val shipped = ResolveConfig.parse(file.readText())
            assertEquals(f, 4, shipped.version)
            assertEquals(f, ResolveConfig.DEFAULT_PREWARM, shipped.prewarm)
        }
    }

    @Test fun prewarmSendsNothingToTheVmAndRunsEveryProviderOnTheDevice() {
        val started = od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        assertEquals(listOf("mapple", "netmirror", "castletv", "multimovies", "vidrift"), started)
        waitPrewarm()
        assertEquals("VM calls during prewarm: ${hits.filter { it.startsWith("vm.test") }}", 0, vmCalls())
        assertTrue(count("mapple.fun") > 0)
        assertTrue(count("api.hlowb.com") > 0)
        assertTrue(count("embed.vidrift") > 0)
        assertTrue(hits.any { it.contains("mobidetect") })
        assertTrue(hits.any { it.startsWith("127.0.0.1/api/resolve") || it.startsWith("localhost/api/resolve") })
    }

    @Test fun playContinuesFromThePrewarmAndFetchesNothingAgainForThoseProviders() = runBlocking {
        od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        waitPrewarm()
        val warmed = listOf("mapple.fun", "api.hlowb.com", "embed.vidrift", "127.0.0.1", "localhost")
        val before = warmed.associateWith(::count)
        val netmirrorBefore = hits.count { it.contains("mobidetect") }
        // Play, VM down so every on-device provider starts (the widest case).
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val late = CompletableDeferred<List<Source>>()
        val jobs = od.launchAll(scope, "movie", 579974, 0, 0, codecs, "Telugu", "RRR", vmDown = true, originalLang = "te", late = late, lateScope = scope)
        val rows = withTimeout(60_000) { jobs.awaitAll() }
        // MultiMovies answered with rows: taken from the prewarm, no new request.
        for (h in listOf("127.0.0.1", "localhost")) assertEquals(h, before.getValue(h), count(h))
        // NetMirror failed upstream (HTTP 404, not the network): its job is reused, never a second NetMirror request.
        assertEquals("no second NetMirror request", netmirrorBefore, hits.count { it.contains("mobidetect") })
        // Gap X2: mapple and castletv ended with 0 rows; Play asks them again.
        assertTrue(count("mapple.fun") > before.getValue("mapple.fun"))
        assertTrue(count("api.hlowb.com") > before.getValue("api.hlowb.com"))
        // MultiMovies rows came from the prewarm with their language tags intact.
        val mmRows = rows[od.names(vmDown = true).indexOf(OnDeviceResolver.MULTIMOVIES)]
        assertEquals(2, mmRows.size)
        assertTrue(mmRows.any { it.languages.contains("Telugu") })
        // mapple failed here, so its late row completes empty: no switch, no hang.
        assertEquals(emptyList<Source>(), withTimeout(5_000) { late.await() })
        // Taken once: a later Play resolves again.
        val again = od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs, "Telugu", originalLang = "te")
        assertEquals(2, again.size)
        assertTrue(count("127.0.0.1") + count("localhost") > before.getValue("127.0.0.1") + before.getValue("localhost"))
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun anotherLanguageOrAStaleJobIsNotReused() = runBlocking {
        fun local() = count("127.0.0.1") + count("localhost")
        od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te")
        waitPrewarm()
        val n = local()
        od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 1, 0, 0, codecs, "Hindi", originalLang = "te")
        assertTrue("another audio language resolves on its own", local() > n)
        val m = local()
        clock += OnDeviceResolver.PREWARM_TTL_MS + 1
        od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 1, 0, 0, codecs, "Telugu", originalLang = "te")
        assertTrue("stale prewarm is dropped", local() > m)
    }

    @Test fun netmirrorIsPrewarmedOnceAtATimeAndNeverTwiceForATitleInsideTheTtl() {
        assertTrue(OnDeviceResolver.NETMIRROR in od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te"))
        // Same page again: nothing new starts.
        assertEquals(emptyList<String>(), od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te"))
        val first = od.prewarmJobs()
        // Another title: the first title's jobs are cancelled (one in flight per device), never queued.
        assertTrue(OnDeviceResolver.NETMIRROR in od.prewarm("movie", 2, 0, 0, codecs, "Telugu", "B", "te"))
        assertTrue("none left running", first.all { it.isCancelled || it.isCompleted })
        waitPrewarm()
        // Back to the first title inside the TTL: no second NetMirror prewarm.
        assertFalse(OnDeviceResolver.NETMIRROR in od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te"))
        // Gap 13.9: not again inside NetMirror's cooldown either.
        clock += OnDeviceResolver.PREWARM_TTL_MS + 1
        od.cancelPrewarm("movie", 1)
        assertFalse(OnDeviceResolver.NETMIRROR in od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te"))
        clock += com.chitram.app.resolve.NetmirrorConfig().cooldownMs
        od.cancelPrewarm("movie", 1)
        assertTrue(OnDeviceResolver.NETMIRROR in od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te"))
        waitPrewarm()
    }

    private fun local() = count("127.0.0.1") + count("localhost")

    /** Gap 13.10: airplane mode, 3 details pages past the dwell, then online: no provider paused. */
    @Test fun offlinePrewarmNeverOpensABreaker() = runBlocking {
        down = true; offline = true
        val n0 = hits.size
        for (id in 1L..3L) {
            assertEquals(emptyList<String>(), od.prewarm("movie", id, 0, 0, codecs, "Telugu", "T$id", "te"))
            waitPrewarm()
        }
        assertEquals("an offline prewarm sends nothing", n0, hits.size)
        // Play while offline: nothing counts toward a breaker.
        repeat(OnDeviceResolver.BREAKER_FAILS + 1) { for (n in od.names(vmDown = true)) od.resolveAll(n, "movie", 9, 0, 0, codecs, "Telugu", title = "X") }
        for (n in od.names(vmDown = true)) assertFalse("$n paused", od.isOpen(n))
        // Online again: Play resolves every provider at once.
        down = false; offline = false
        val before = local()
        assertEquals(2, od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 10, 0, 0, codecs, "Telugu", originalLang = "te").size)
        assertTrue(local() > before)
    }

    /** Gap 13.10 boundary: only an offline reading stops the count; a dead host online still counts. */
    @Test fun aDnsFailureWhileTheDeviceReadsOnlineStillCounts() = runBlocking {
        down = true
        // The connectivity check lags: it says online, the DNS fails. A dead host counts (it may be gone).
        repeat(OnDeviceResolver.BREAKER_FAILS) { od.resolveAll(OnDeviceResolver.CASTLE, "movie", 9, 0, 0, codecs, title = "X") }
        assertTrue(od.isOpen(OnDeviceResolver.CASTLE))
    }

    /** Gap X2: prewarm failed on the network, the network came back, Play inside 120 s resolves again. */
    @Test fun aFailedPrewarmJobIsNotReusedByPlay() = runBlocking {
        down = true // the connectivity check missed it: the prewarm ran and failed
        od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        waitPrewarm()
        down = false
        val before = local()
        val rows = od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs, "Telugu", originalLang = "te")
        assertEquals(2, rows.size)
        assertTrue("Play resolved again", local() > before)
        assertTrue(rows.any { "Telugu" in it.languages })
    }

    /** A mapple stand-in: a Hindi row at once, its Telugu row [lateMs] later through [MappleResolver.Later]. */
    private fun lateMapple(lateMs: Long, calls: java.util.concurrent.atomic.AtomicInteger = java.util.concurrent.atomic.AtomicInteger()) =
        object : MappleResolver(client, HostBook(MemoryKeyValue()), MemoryKeyValue()) {
            override suspend fun resolve(cfg: com.chitram.app.resolve.MappleConfig, type: String, tmdbId: Long, season: Int, episode: Int,
                                         preferred: String, fresh: Boolean, later: Later?): com.chitram.app.resolve.Resolved? {
                calls.incrementAndGet()
                fun row(l: String) = com.chitram.app.resolve.Resolved("mapple", "mapple $l", "https://m.test/$l.m3u8", emptyMap(), null, emptyList(), emptyList(), null, key = "mapple-$l", languages = listOf(l))
                if (later != null) {
                    later.handedOff = true
                    later.scope.launch { delay(lateMs); later.deliver(row("Telugu")) }
                }
                return row("Hindi")
            }
        }

    /** Gap X12: a title only mapple has; its Telugu row comes late. A list entry only, never waited for. */
    @Test fun aLateMappleTeluguRowJoinsTheListWithoutASwitch() = runBlocking {
        val kv = MemoryKeyValue()
        val store = ResolveConfigStore(client, "https://vm.test" + ResolveConfigStore.PATH, kv)
        val calls = java.util.concurrent.atomic.AtomicInteger()
        val od2 = OnDeviceResolver(Api(client, base = "https://catalog.test", vmBase = "https://vm.test"), store, lateMapple(1_500, calls),
            VaplayerResolver(client, HostBook(kv)) { null }, cache = com.chitram.app.resolve.StreamCache(kv) { clock }) { clock }
        od2.prewarm("movie", 77, 0, 0, codecs, "Telugu", "Only Mapple", "te")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val late = CompletableDeferred<List<Source>>()
        val t0 = System.currentTimeMillis()
        val jobs = od2.launchAll(scope, "movie", 77, 0, 0, codecs, "Telugu", "Only Mapple", late = late, lateScope = scope)
        val first = withTimeout(10_000) { jobs[0].await() }
        assertTrue("the start never waits for the late row", System.currentTimeMillis() - t0 < 1_400)
        assertEquals(listOf("Hindi"), first.single().languages)
        val lateRows = withTimeout(10_000) { late.await() }
        assertEquals(listOf("Telugu"), lateRows.single().languages)
        assertEquals("Play continued the prewarm: one mapple resolve", 1, calls.get())
        // PlayerVm joins late rows as list entries; never play() from here.
        val vm = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        val join = vm.substringAfter("private suspend fun joinLate(").substringBefore("\n    }\n")
        assertEquals(0, Regex("""\bplay\(""").findAll(join).count())
        // 2026-11-24: a late row after the end card waits for Try again (no auto-start).
        assertTrue(join.contains("lateAfterEnd(r, rows.size)"))
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun openBreakerSkipsThatProviderOnly() = runBlocking {
        // 3 chain failures in a row open castletv's breaker (BREAKER_FAILS).
        repeat(OnDeviceResolver.BREAKER_FAILS) { od.resolveAll(OnDeviceResolver.CASTLE, "movie", 9, 0, 0, codecs, title = "X") }
        val started = od.prewarm("movie", 9, 0, 0, codecs, "Telugu", "X", "te")
        assertFalse(OnDeviceResolver.CASTLE in started)
        assertTrue(OnDeviceResolver.MAPPLE in started && OnDeviceResolver.MULTIMOVIES in started)
        waitPrewarm()
    }

    @Test fun netmirrorPrewarmLogsOneGreppableLine() {
        val src = listOf(File("src/main/java/com/chitram/app/resolve/OnDevice.kt"), File("app/src/main/java/com/chitram/app/resolve/OnDevice.kt")).first { it.exists() }.readText()
        assertTrue(src.contains("\"prewarm: netmirror \$type/\$id result=\${if (rows.isNotEmpty()) \"rows\" else if (netmirror?.throttled == true) \"throttled\" else \"error\"} ms=\${now() - t0}"))
    }

    // ---- Play starts from a ready prewarmed row (coordinator follow-up) -------

    private fun row(id: String, provider: String, lang: String) =
        Source(id, provider, provider, "https://x/$id.m3u8", false, "1080p", emptyList(), listOf(lang), false, false, emptyList(), null, null, false, onDevice = provider)

    @Test fun aReadyPrewarmedTeluguRowStartsPlaybackWithoutWaitingForTheVm() = runBlocking {
        val vm = CompletableDeferred<List<Source>>() // the VM call is out, still running
        val warmTe = CompletableDeferred(listOf(row("mm-te", "multimovies", "Telugu")))
        val mapple = async { delay(20_000); emptyList<Source>() }
        val t0 = System.currentTimeMillis()
        val first = com.chitram.app.player.StartRace(leadMs = 5_000).firstMany(vm, listOf(mapple, warmTe), "Telugu", warm = listOf(warmTe))
        val ms = System.currentTimeMillis() - t0
        assertTrue("no VM lead wait ($ms ms)", ms < 1_000)
        assertTrue("the VM rows still come, late", first.backendPending)
        assertTrue(vm.isActive)
        assertEquals(listOf("mm-te"), first.device.map { it.id })
        mapple.cancel()
    }

    @Test fun aPrewarmedRowCompletingBeforeTheVmStartsAtOnceToo() = runBlocking {
        val vm = CompletableDeferred<List<Source>>()
        val warm = async { delay(300); listOf(row("vd-te", "vidrift", "Telugu")) }
        val t0 = System.currentTimeMillis()
        val first = com.chitram.app.player.StartRace(leadMs = 5_000).firstMany(vm, listOf(warm), "Telugu", warm = listOf(warm))
        assertTrue(System.currentTimeMillis() - t0 < 1_500)
        assertTrue(first.backendPending)
    }

    @Test fun nothingPrewarmedReadyKeepsTodaysVmLead() = runBlocking {
        // A non-prewarm Telugu row and a prewarmed Hindi-only row: the VM still leads, as before.
        val vm = async { delay(400); listOf(row("vm-te", "castletv", "Telugu")) }
        val castle = CompletableDeferred(listOf(row("dev-te", "castletv", "Telugu")))
        val warmHi = CompletableDeferred(listOf(row("mm-hi", "multimovies", "Hindi")))
        val pending = CompletableDeferred<List<Source>>()
        val first = com.chitram.app.player.StartRace(leadMs = 5_000).firstMany(vm, listOf(castle, warmHi, pending), "Telugu", warm = listOf(warmHi, pending))
        assertFalse(first.backendPending)
        assertEquals(listOf("vm-te"), first.backend.map { it.id })
    }

    @Test fun vmRowsMergeLaterWithoutSwitchingPlayback() {
        // The list after a fast start, then the VM's late rows merged into it.
        val started = com.chitram.app.data.Ranking.merge(emptyList(), listOf(row("mm-te", "multimovies", "Telugu")), "Telugu")
        val merged = com.chitram.app.data.Ranking.merge(started, listOf(row("vm-te", "castletv", "Telugu"), row("vm-hi", "vidrock", "Hindi")), "Telugu")
        assertTrue(merged.map { it.id }.containsAll(listOf("mm-te", "vm-te", "vm-hi")))
        assertEquals(listOf("Telugu"), merged.first { it.id == "mm-te" }.languages)
        // joinVm only merges; it plays only when the start had failed (no switch while playing).
        val vm = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        val join = vm.substringAfter("private suspend fun joinVm(").substringBefore("\n    }\n")
        assertEquals(0, Regex("""\bplay\(""").findAll(join).count())
        assertTrue(join.contains("lateAfterEnd(r, rows.size)"))
        // Play passes the prewarm jobs to the race, and starts prewarmed VM-down-only providers now.
        assertTrue(vm.contains("firstMany(vm, device, preferred, warm = warmJobs,"))
        assertTrue(vm.contains("val warmExtra = warmNames.filter { it !in names }"))
    }

    @Test fun prewarmedNamesListsFreshUntakenJobsOnly() = runBlocking {
        od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        waitPrewarm()
        assertEquals(listOf("mapple", "netmirror", "castletv", "multimovies", "vidrift"), od.prewarmedNames("movie", 579974, 0, 0, "Telugu"))
        assertEquals(emptyList<String>(), od.prewarmedNames("movie", 579974, 0, 0, "Hindi"))
        // VM up: Play starts multimovies from the prewarm with no new request.
        val local = count("127.0.0.1") + count("localhost")
        assertEquals(2, od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs, "Telugu", originalLang = "te").size)
        assertEquals(local, count("127.0.0.1") + count("localhost"))
        assertFalse(OnDeviceResolver.MULTIMOVIES in od.prewarmedNames("movie", 579974, 0, 0, "Telugu"))
        clock += OnDeviceResolver.PREWARM_TTL_MS + 1
        assertEquals(emptyList<String>(), od.prewarmedNames("movie", 579974, 0, 0, "Telugu"))
    }
}
