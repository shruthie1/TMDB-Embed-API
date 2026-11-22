package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.LastProviderStore
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.player.DirectRoute
import com.chitram.app.player.LastPlayed
import com.chitram.app.player.OpenSubs
import com.chitram.app.player.PlayPolicy
import com.chitram.app.player.StartCapMeter
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MasterPlaylist
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.NetmirrorResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.PlaylistCache
import com.chitram.app.resolve.PlaylistInterceptor
import com.chitram.app.resolve.ResolveConfig
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.StartCap
import com.chitram.app.resolve.StreamCache
import com.chitram.app.resolve.VaplayerResolver
import com.chitram.app.ui.common.DetailVm
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Fast second Play (phone 1.2.48, 2026-11-22): RRR second Play took 4736 ms to the
 * first frame with every row kept (master, then video playlist, then audio
 * playlist, one after another); Krack's direct link sat 10 s with no frame;
 * prewarm never ran (a saved config from before the flag read as "off").
 */
class FastSecondPlayTest {
    private val server = MockWebServer()
    private val paths = CopyOnWriteArrayList<String>()
    private val perPath = ConcurrentHashMap<String, AtomicInteger>()
    private val referers = CopyOnWriteArrayList<String>()
    private var clock = 1_800_000_000_000L
    private val codecs = CodecSupport { _, _ -> null }
    private lateinit var base: String

    private val master = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="hi",NAME="Hindi",DEFAULT=YES,URI="a_hi.m3u8"
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="te",NAME="Telugu",URI="a_te.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"
        v1080.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,AUDIO="aud"
        v720.m3u8
    """.trimIndent()
    private val vod = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n"
    private val live = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n"

    @Before fun setup() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val p = request.requestUrl!!.encodedPath
                paths += p
                perPath.getOrPut(p) { AtomicInteger() }.incrementAndGet()
                request.getHeader("Referer")?.let { referers += "$p $it" }
                val type = "application/vnd.apple.mpegurl"
                return when (p) {
                    "/master.m3u8" -> MockResponse().setBody(master).setHeader("Content-Type", type)
                    "/live.m3u8" -> MockResponse().setBody(live).setHeader("Content-Type", type)
                    "/master2.m3u8" -> MockResponse().setBody("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\nslow.m3u8\n").setHeader("Content-Type", type)
                    // The first request hangs 4 s (a hung prefetch; the old 8 s wait sat through it); later ones answer at once.
                    "/slow.m3u8" -> MockResponse().setBody(vod).setHeader("Content-Type", type)
                        .apply { if (perPath[p]!!.get() == 1) setHeadersDelay(4, TimeUnit.SECONDS) }
                    "/api/resolve" -> MockResponse().setBody(
                        """{"stream":{"server":"x","sources":[{"url":"$base/hi.m3u8","kind":"hls","quality":"1080p","language":"Hindi"},{"url":"$base/te.m3u8","kind":"hls","quality":"1080p","language":"Telugu"}]}}""")
                    "/hi.m3u8", "/te.m3u8" -> MockResponse().setBody(Fixtures.read("multimovies/rrr-bridge-telugu.m3u8"))
                    "/v1080.m3u8", "/v720.m3u8", "/a_te.m3u8", "/a_hi.m3u8" ->
                        MockResponse().setBody(vod).setHeader("Content-Type", type).setBodyDelay(400, TimeUnit.MILLISECONDS)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        base = server.url("").toString().trimEnd('/')
    }

    @After fun stop() = server.shutdown()

    private fun get(c: OkHttpClient, path: String): String = c.newCall(Request.Builder().url("$base$path").build()).execute().use { it.body!!.string() }
    private fun count(path: String) = perPath[path]?.get() ?: 0

    // ---- 1. prewarm config fallback -----------------------------------------

    @Test fun aSavedConfigFromBeforeThePrewarmFlagStillPrewarmsTheBuiltInProviders() {
        // The VM's v2 config (no `prewarm` anywhere), saved 1 h ago and still inside its 6 h life.
        val kv = MemoryKeyValue()
        kv.put(ResolveConfigStore.KEY, """{"version":2,"mapple":{"enabled":true},"netmirror":{"enabled":true},"castletv":{},"multimovies":{},"vaplayer":{}}""")
        kv.put(ResolveConfigStore.KEY_AT, (clock - 3_600_000).toString())
        kv.put(ResolveConfigStore.KEY_FROM, ResolveConfigStore.FROM_VM)
        val store = ResolveConfigStore(OkHttpClient(), "$base/cfg", kv) { clock }
        assertEquals(ResolveConfig.DEFAULT_PREWARM, store.current().prewarm)
        assertFalse(store.current().prewarmExplicit)
        val od = resolver(store)
        assertEquals(listOf("mapple", "netmirror", "castletv", "multimovies", "vidrift"), od.prewarmNames())
        // The once-per-change line names the source: no flag in the saved copy, so the built-in default.
        assertEquals("prewarm: providers=mapple,netmirror,castletv,multimovies,vidrift source=builtin",
            OnDeviceResolver.prewarmLine(od.prewarmNames(), ResolveConfigStore.FROM_BUILTIN))
    }

    @Test fun aConfigWithFlagsNamesItsSource() {
        val kv = MemoryKeyValue()
        kv.put(ResolveConfigStore.KEY, """{"version":3,"mapple":{"prewarm":true},"castletv":{"prewarm":false}}""")
        kv.put(ResolveConfigStore.KEY_AT, clock.toString())
        kv.put(ResolveConfigStore.KEY_FROM, ResolveConfigStore.FROM_REMOTE)
        val store = ResolveConfigStore(OkHttpClient(), "$base/cfg", kv) { clock }
        assertTrue(store.current().prewarmExplicit)
        assertEquals(ResolveConfigStore.FROM_REMOTE, store.source())
        // castletv false is kept; netmirror, multimovies and vidrift have no flag: their default (on).
        assertEquals(listOf("mapple", "netmirror", "multimovies", "vidrift"), resolver(store).prewarmNames())
        assertEquals(ResolveConfigStore.FROM_BUILTIN, ResolveConfigStore(OkHttpClient(), "$base/cfg", MemoryKeyValue()).source())
    }

    // ---- 2. reopen -------------------------------------------------------------

    @Test fun reopeningPrewarmsAgainAndAFailedPageRetries() {
        assertEquals(DetailVm.Reopen.LOAD, DetailVm.reopen(sameTitle = false, loaded = false, failed = false))
        assertEquals(DetailVm.Reopen.PREWARM, DetailVm.reopen(sameTitle = true, loaded = true, failed = false))
        assertEquals(DetailVm.Reopen.LOAD, DetailVm.reopen(sameTitle = true, loaded = false, failed = true))
        assertEquals(DetailVm.Reopen.WAIT, DetailVm.reopen(sameTitle = true, loaded = false, failed = false))
    }

    @Test fun aTitleLeftForAnotherIsPrewarmedAgainOnReturn() {
        val od = resolver(ResolveConfigStore(fake404, "https://vm.test/cfg", MemoryKeyValue()))
        assertTrue(od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te").contains(OnDeviceResolver.MAPPLE))
        // Another title cancels A's unclaimed jobs.
        od.prewarm("movie", 2, 0, 0, codecs, "Telugu", "B", "te")
        // Back on A: its providers start again (NetMirror only once per title inside the TTL).
        val again = od.prewarm("movie", 1, 0, 0, codecs, "Telugu", "A", "te")
        assertEquals(listOf("mapple", "castletv", "multimovies", "vidrift"), again)
    }

    // ---- 3 + 4. playlist cache, parallel playlists ------------------------------

    @Test fun aMasterStartsItsFirstVideoAndAudioPlaylistsInParallel() {
        val cache = PlaylistCache({ clock })
        val c = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te", "Telugu") }
        val t0 = System.currentTimeMillis()
        get(c, "/master.m3u8")
        // The player asks one after another: primary (first variant), the start variant, then Telugu audio.
        get(c, "/v1080.m3u8"); get(c, "/v720.m3u8"); get(c, "/a_te.m3u8")
        val ms = System.currentTimeMillis() - t0
        // Each child playlist takes 400 ms: three in a row would be 1200 ms or more.
        assertTrue("took ${ms}ms", ms < 1_000)
        for (p in listOf("/v1080.m3u8", "/v720.m3u8", "/a_te.m3u8")) assertEquals(p, 1, count(p))
        // Hindi (not the viewer's language) is not fetched ahead; no segment ever.
        assertEquals(0, count("/a_hi.m3u8"))
        assertEquals(0, count("/seg0.ts"))
    }

    @Test fun aSecondPlayGetsEveryPlaylistFromMemoryWithZeroRequests() {
        val cache = PlaylistCache({ clock })
        val first = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te") }
        get(first, "/master.m3u8"); get(first, "/v1080.m3u8"); get(first, "/v720.m3u8"); get(first, "/a_te.m3u8")
        val before = paths.size
        // Second Play: a new player client (another row's headers), the same memory.
        val second = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te") }
        assertEquals(master, get(second, "/master.m3u8"))
        assertEquals(vod, get(second, "/v720.m3u8"))
        assertEquals(vod, get(second, "/a_te.m3u8"))
        assertEquals("0 requests on the second Play", before, paths.size)
    }

    @Test fun keptPlaylistsLiveAsLongAsTheRowAndHonourUrlExpiry() {
        val cache = PlaylistCache({ clock })
        cache.put("https://h.test/m.m3u8", master.toByteArray(), null)
        clock += StreamCache.TTL_MS - 1
        assertTrue(cache.has("https://h.test/m.m3u8"))
        clock += 2
        assertFalse("row TTL over", cache.has("https://h.test/m.m3u8"))
        // A url that expires in 60 s lives 60 s less the 30 s skew, as the row does.
        val exp = (clock / 1000) + 60
        cache.put("https://h.test/x.m3u8?exp=$exp", master.toByteArray(), null)
        clock += 29_000
        assertTrue(cache.has("https://h.test/x.m3u8?exp=$exp"))
        clock += 2_000
        assertFalse("url expiry honoured", cache.has("https://h.test/x.m3u8?exp=$exp"))
    }

    @Test fun aLivePlaylistIsNeverKept() {
        val cache = PlaylistCache({ clock })
        val c = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te") }
        get(c, "/live.m3u8"); get(c, "/live.m3u8")
        assertEquals(2, count("/live.m3u8"))
    }

    @Test fun droppingARowDropsItsPlaylists() {
        val cache = PlaylistCache({ clock })
        val c = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te") }
        get(c, "/master.m3u8"); get(c, "/v1080.m3u8"); get(c, "/v720.m3u8"); get(c, "/a_te.m3u8")
        assertTrue(cache.has("$base/v720.m3u8"))
        assertEquals(4, cache.evict("$base/master.m3u8"))
        assertFalse(cache.has("$base/master.m3u8"))
        assertFalse(cache.has("$base/v720.m3u8"))
    }

    @Test fun warmFetchesTheMasterAndFirstPlaylistsWithTheRowHeadersAndNoSegments() {
        val cache = PlaylistCache({ clock })
        assertTrue(PlaylistInterceptor.warm(OkHttpClient(), cache, "$base/master.m3u8", mapOf("Referer" to "https://row.test/"), null, listOf("te")))
        runBlocking { withTimeout(5_000) { while (!cache.has("$base/a_te.m3u8") || !cache.has("$base/v720.m3u8")) kotlinx.coroutines.delay(20) } }
        assertTrue(cache.has("$base/v1080.m3u8"))
        assertEquals(0, count("/seg0.ts"))
        assertTrue(referers.toString(), referers.contains("/a_te.m3u8 https://row.test/"))
        // Kept already: nothing to warm.
        assertFalse(PlaylistInterceptor.warm(OkHttpClient(), cache, "$base/master.m3u8", emptyMap(), null, listOf("te")))
    }

    @Test fun aFinishedPrewarmWarmsTheTopRankedRowsPlaylistsOnly() {
        MultiMoviesResolver.resetServerState()
        val local = OkHttpClient.Builder().addInterceptor(Interceptor { ch ->
            if (ch.request().url.host == "127.0.0.1" || ch.request().url.host == "localhost") ch.proceed(ch.request())
            else Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(404).message("fake").body("".toResponseBody()).build()
        }).build()
        val warmed = CopyOnWriteArrayList<Source>()
        val kv = MemoryKeyValue()
        val hosts = HostBook(kv)
        val od = OnDeviceResolver(
            null, ResolveConfigStore(fake404, "https://vm.test/cfg", kv), MappleResolver(fake404, hosts, kv), VaplayerResolver(fake404, hosts) { null },
            imdbFor = { _, _ -> null }, titleFor = { _, _ -> null },
            castle = CastleResolver(fake404, hosts = hosts), multimovies = MultiMoviesResolver(local, origin = base),
            netmirror = NetmirrorResolver(fake404, now = { clock }),
            warmPlaylists = { r, _ -> warmed += r },
        ) { clock }
        od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        runBlocking { withTimeout(60_000) { while (warmed.isEmpty()) kotlinx.coroutines.delay(20) } }
        assertEquals(1, warmed.size)
        // The Telugu MultiMovies row ranks first: its playlists are the ones warmed.
        assertEquals("$base/te.m3u8", warmed.single().url)
    }

    /** Gap 4.2: a hung prefetch holds the player at most 1.5 s, and is cancelled before the player fetches. */
    @Test fun aHungPrefetchIsDroppedAfterAShortWait() {
        assertTrue(PlaylistInterceptor.WAIT_MS <= 1_500)
        val cache = PlaylistCache({ clock })
        val c = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te") }
        get(c, "/master2.m3u8")
        runBlocking { withTimeout(2_000) { while (count("/slow.m3u8") < 1) kotlinx.coroutines.delay(10) } }
        val t0 = System.currentTimeMillis()
        assertEquals(vod, get(c, "/slow.m3u8"))
        val ms = System.currentTimeMillis() - t0
        assertTrue("player waited ${ms}ms", ms < 2_500)
        assertEquals("the hung prefetch plus one player fetch", 2, count("/slow.m3u8"))
        assertNull("the hung prefetch is no longer pending", cache.pending("$base/slow.m3u8"))
    }

    /** Gap 3.7: low memory gives the playlist memory back; a UI-hidden trim keeps it. */
    @Test fun lowMemoryDropsTheKeptPlaylists() {
        val cache = PlaylistCache({ clock })
        fun fill() { cache.put("https://h.test/a.m3u8", master.toByteArray(), null); cache.put("https://h.test/b.m3u8", vod.toByteArray(), null) }
        fill()
        assertEquals("TRIM_MEMORY_UI_HIDDEN keeps them", 0, cache.trim(20))
        assertEquals(0, cache.trim(5))
        assertEquals("TRIM_MEMORY_RUNNING_LOW", 2, cache.trim(10))
        assertFalse(cache.has("https://h.test/a.m3u8"))
        fill(); assertEquals("RUNNING_CRITICAL", 2, cache.trim(15))
        fill(); assertEquals("BACKGROUND and up", 2, cache.trim(40))
        val app = java.io.File("src/main/java/com/chitram/app/App.kt").readText()
        assertTrue("App.onTrimMemory trims the playlist cache", Regex("""fun onTrimMemory\([^)]*\)[\s\S]{0,300}playlists\.trim\(""").containsMatchIn(app))
    }

    /** Gap 3.8 (owner rule: cut data on browse): no playlist warm-up on a metered network. */
    @Test fun noPlaylistWarmUpOnMeteredData() {
        MultiMoviesResolver.resetServerState()
        val local = OkHttpClient.Builder().addInterceptor(Interceptor { ch ->
            if (ch.request().url.host == "127.0.0.1" || ch.request().url.host == "localhost") ch.proceed(ch.request())
            else Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(404).message("fake").body("".toResponseBody()).build()
        }).build()
        var metered = true
        val warmed = CopyOnWriteArrayList<Source>()
        val kv = MemoryKeyValue()
        val hosts = HostBook(kv)
        val od = OnDeviceResolver(
            null, ResolveConfigStore(fake404, "https://vm.test/cfg", kv), MappleResolver(fake404, hosts, kv), VaplayerResolver(fake404, hosts) { null },
            imdbFor = { _, _ -> null }, titleFor = { _, _ -> null },
            castle = CastleResolver(fake404, hosts = hosts), multimovies = MultiMoviesResolver(local, origin = base),
            netmirror = NetmirrorResolver(fake404, now = { clock }),
            warmPlaylists = { r, _ -> warmed += r },
            metered = { metered },
        ) { clock }
        od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        runBlocking { withTimeout(60_000) { od.prewarmJobs().forEach { runCatching { it.await() } } } }
        Thread.sleep(300)
        assertEquals("metered: rows resolved, no playlists fetched", 0, warmed.size)
        metered = false
        od.prewarm("movie", 579975, 0, 0, codecs, "Telugu", "RRR 2", "te")
        runBlocking { withTimeout(60_000) { while (warmed.isEmpty()) kotlinx.coroutines.delay(20) } }
        assertEquals(1, warmed.size)
    }

    // ---- 5. start cap ------------------------------------------------------------

    @Test fun theStartIsCappedNear720pThenClimbsAndTheAudioPickIsTheViewersLanguage() {
        val vs = MasterPlaylist.variants(master)
        assertEquals("v720.m3u8", MasterPlaylist.startVariant(vs, StartCap.START_BPS)!!.uri)
        // RRR MultiMovies master (fixture): 2.2 Mbps 1080p HEVC is above the cap, 720p is the start.
        val rrr = Fixtures.read("multimovies/rrr-bridge-telugu.m3u8")
        assertEquals(720, MasterPlaylist.startVariant(MasterPlaylist.variants(rrr), StartCap.START_BPS)!!.height)
        // The Telugu rendition, not the DEFAULT Hindi one: the language pick is untouched.
        assertEquals(listOf("v1080.m3u8", "v720.m3u8", "a_te.m3u8"), MasterPlaylist.firstLoads(master, listOf("te", "Telugu"), StartCap.START_BPS))
        val meter = StartCapMeter(FakeMeter(20_000_000))
        meter.capped = true
        assertEquals(StartCap.START_BPS, meter.bitrateEstimate)
        meter.capped = false
        assertEquals(20_000_000, meter.bitrateEstimate)
        // A slow network is never raised to the cap.
        assertEquals(900_000, StartCapMeter(FakeMeter(900_000)).also { it.capped = true }.bitrateEstimate)
    }

    // ---- 6. direct-link stall ------------------------------------------------------

    @Test fun aDirectPlayWithNoSegmentBy6sGoesToTheProxy() {
        assertEquals(6_000L, DirectRoute.FIRST_SEGMENT_MS)
        assertNull(DirectRoute.stallReason(4_000, framed = false, segmentLoaded = false))
        // Krack direct (img.rousav.tech): no segment by 6 s (its first came at 8.8 s).
        assertEquals("no-first-segment-6s", DirectRoute.stallReason(6_000, framed = false, segmentLoaded = false))
        // A segment came: wait for the frame up to 10 s, as before.
        assertNull(DirectRoute.stallReason(6_000, framed = false, segmentLoaded = true))
        assertEquals("no-first-frame-10s", DirectRoute.stallReason(10_000, framed = false, segmentLoaded = true))
        assertNull(DirectRoute.stallReason(10_000, framed = true, segmentLoaded = true))
    }

    // ---- 7. race log labels ----------------------------------------------------------

    @Test fun cacheHitsAndPrewarmJobsAreLoggedApart() {
        assertEquals(listOf("[race] cache hit: mapple,vidrift"), OnDeviceResolver.raceLines(listOf("mapple", "vidrift"), emptyList()))
        assertEquals(listOf("[race] cache hit: mapple", "[race] continuing prewarm: castletv"), OnDeviceResolver.raceLines(listOf("mapple"), listOf("castletv")))
        assertEquals(emptyList<String>(), OnDeviceResolver.raceLines(emptyList(), emptyList()))
        val sc = StreamCache(null) { clock }
        val od = resolver(ResolveConfigStore(fake404, "https://vm.test/cfg", MemoryKeyValue()), sc)
        sc.putDevice(StreamCache.key("movie", 7, 0, 0), "mapple", "Telugu", listOf(row("m", "mapple", "Telugu")))
        od.prewarm("movie", 7, 0, 0, codecs, "Telugu", "T", "te")
        val (kept, jobs) = od.warmSplit("movie", 7, 0, 0, "Telugu")
        assertEquals(listOf("mapple"), kept)
        assertFalse(jobs.contains("mapple"))
        assertTrue(jobs.contains("castletv"))
    }

    // ---- 8. last provider --------------------------------------------------------------

    @Test fun theLastProviderStartsFirstInsideTheViewersLanguage() {
        val te1 = row("a", "vidrift", "Telugu")
        val te2 = row("b", "multimovies", "Telugu")
        val hi = row("c", "castletv", "Hindi")
        val list = listOf(te1, te2, hi)
        assertEquals(te2, LastPlayed.startRow(list, LastProviderStore.Pin("MultiMovies", false), "Telugu"))
        // Not in the list: the list's own order.
        assertNull(LastPlayed.startRow(list, LastProviderStore.Pin("netmirror", false), "Telugu"))
        // Telugu first wins: a remembered Hindi-only row never starts ahead of a Telugu row.
        assertNull(LastPlayed.startRow(list, LastProviderStore.Pin("castletv", false), "Telugu"))
        // No row in the viewer's language at all: the memory may lead.
        assertEquals(hi, LastPlayed.startRow(listOf(row("d", "vidrock", "Hindi"), hi), LastProviderStore.Pin("castletv", false), "Telugu"))
        // Gap 8.5 (owner rule: language still wins): a manual Hindi pick never starts ahead of a Telugu row.
        assertNull(LastPlayed.startRow(list, LastProviderStore.Pin("castletv", true), "Telugu"))
        // A manual pick inside the viewer's language leads.
        assertEquals(te2, LastPlayed.startRow(list, LastProviderStore.Pin("multimovies", true), "Telugu"))
        assertEquals("[last] movie/579974 provider=multimovies hit", LastPlayed.line("movie", 579974, "multimovies", "hit"))
    }

    @Test fun whenTheLastProviderFailsTheNormalOrderFollowsAndTheMemoryStays() {
        val kv = MemoryKeyValue()
        val store = LastProviderStore(kv) { clock }
        store.put("movie", 1, "multimovies")
        val list = listOf(row("a", "vidrift", "Telugu"), row("b", "multimovies", "Telugu"))
        val start = LastPlayed.startRow(list, store.get("movie", 1), "Telugu")!!
        assertEquals("b", start.id)
        // It failed: failover takes the list's first untried row.
        assertEquals("a", PlayPolicy.nextAlive(list, setOf(start.id), "Telugu", null)!!.id)
        // Nothing is written on a failure: the memory stays until another provider plays 10 s.
        assertEquals("multimovies", store.get("movie", 1)!!.provider)
        assertFalse(LastPlayed.played(framedAtMs = 60_000, positionMs = 69_999, sameRow = true))
        assertTrue(LastPlayed.played(framedAtMs = 60_000, positionMs = 70_000, sameRow = true))
        assertFalse(LastPlayed.played(framedAtMs = 60_000, positionMs = 90_000, sameRow = false))
    }

    @Test fun theMemoryIsPerEpisodeWithTheShowAsFallbackAndKeepsAtLeast200Titles() {
        val kv = MemoryKeyValue()
        val store = LastProviderStore(kv) { clock++ }
        store.put("tv", 9, "castletv", season = 1, episode = 2)
        assertEquals("castletv", store.get("tv", 9, 1, 2)!!.provider)
        // A new episode falls back to the show's last provider.
        assertEquals("castletv", store.get("tv", 9, 1, 3)!!.provider)
        store.put("tv", 9, "netmirror", season = 1, episode = 3)
        assertEquals("castletv", store.get("tv", 9, 1, 2)!!.provider)
        assertEquals("netmirror", store.get("tv", 9, 2, 1)!!.provider)
        // A restart reads the same kv.
        assertEquals("netmirror", LastProviderStore(kv).get("tv", 9, 1, 3)!!.provider)
        for (i in 1..250L) store.put("movie", 1000 + i, "p$i")
        assertTrue(store.size() <= LastProviderStore.MAX_ENTRIES)
        assertEquals("p250", store.get("movie", 1250)!!.provider)
        assertEquals("p51", store.get("movie", 1051)!!.provider)
        for (i in 251..450L) store.put("movie", 1000 + i, "p$i")
        // The oldest go first: 200 newer films are still there.
        assertNull(store.get("movie", 1001))
        assertEquals("p251", store.get("movie", 1251)!!.provider)
    }

    @Test fun prewarmStartsTheLastProviderFirst() {
        val od = resolver(ResolveConfigStore(fake404, "https://vm.test/cfg", MemoryKeyValue()))
        assertEquals(listOf("castletv", "mapple", "netmirror", "multimovies", "vidrift"),
            od.prewarm("movie", 3, 0, 0, codecs, "Telugu", "C", "te", first = "CastleTV"))
    }

    // ---- second Play captions ------------------------------------------------------------

    @Test fun aSecondPlayHasItsCaptionsFromMemory() = runBlocking {
        val subs = MockWebServer()
        subs.enqueue(MockResponse().setBody("""{"subtitles":[{"id":"1","url":"https://s/1.srt","lang":"eng"}]}"""))
        subs.start()
        val b = subs.url("").toString().trimEnd('/')
        val first = OpenSubs.fetchKept(OkHttpClient(), "tt9999991", 0, 0, null, b) { clock }
        assertEquals(1, first.size)
        assertEquals(first, OpenSubs.fetchKept(OkHttpClient(), "tt9999991", 0, 0, null, b) { clock })
        assertEquals(1, subs.requestCount)
        subs.shutdown()
    }

    // ---- helpers -----------------------------------------------------------------------------

    private val fake404 = OkHttpClient.Builder().addInterceptor(Interceptor { ch ->
        Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(404).message("fake").body("".toResponseBody()).build()
    }).build()

    private fun resolver(store: ResolveConfigStore, cache: StreamCache? = null): OnDeviceResolver {
        val kv = MemoryKeyValue()
        val hosts = HostBook(kv)
        return OnDeviceResolver(
            null, store, MappleResolver(fake404, hosts, kv), VaplayerResolver(fake404, hosts) { null },
            imdbFor = { _, _ -> null }, titleFor = { _, _ -> null },
            castle = CastleResolver(fake404, hosts = hosts),
            multimovies = MultiMoviesResolver(fake404, origin = "https://mm.test"),
            netmirror = NetmirrorResolver(fake404, now = { clock }),
            vidrift = com.chitram.app.resolve.VidriftResolver(fake404),
            cache = cache,
        ) { clock }
    }

    private fun row(id: String, provider: String, lang: String) =
        Source(id, provider, provider, "https://x/$id.m3u8", false, "1080p", emptyList(), listOf(lang), false, false, emptyList(), null, null, false, onDevice = provider)

    private class FakeMeter(private val bps: Long) : androidx.media3.exoplayer.upstream.BandwidthMeter {
        override fun getBitrateEstimate(): Long = bps
        override fun getTransferListener(): androidx.media3.datasource.TransferListener? = null
        override fun addEventListener(h: android.os.Handler, l: androidx.media3.exoplayer.upstream.BandwidthMeter.EventListener) = Unit
        override fun removeEventListener(l: androidx.media3.exoplayer.upstream.BandwidthMeter.EventListener) = Unit
    }
}
