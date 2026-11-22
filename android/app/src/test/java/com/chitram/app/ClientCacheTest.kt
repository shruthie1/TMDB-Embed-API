package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Level
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.RawAudio
import com.chitram.app.data.RawStream
import com.chitram.app.data.Source
import com.chitram.app.data.StreamsResponse
import com.chitram.app.data.SubtitleRef
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.NetmirrorResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.StreamCache
import com.chitram.app.resolve.UrlExpiry
import com.chitram.app.resolve.VaplayerResolver
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
 * Client-side stream cache (owner 2026-11-22, "store the results 20-30 minutes"):
 * resolved rows, on-device and VM, are reused for StreamCache.TTL_MS with 0 requests.
 * MultiMovies and the VM are a MockWebServer; every other host 404s.
 */
class ClientCacheTest {
    private val server = MockWebServer()
    private val hits = CopyOnWriteArrayList<String>()
    private val codecs = CodecSupport { _, _ -> null }
    private var clock = 1_800_000_000_000L
    private val client = OkHttpClient.Builder().addInterceptor(Interceptor { ch ->
        val u = ch.request().url
        hits += "${u.host}${u.encodedPath}"
        if (u.host == "127.0.0.1" || u.host == "localhost") ch.proceed(ch.request())
        else Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(404).message("fake").body("".toResponseBody()).build()
    }).build()

    private lateinit var kv: MemoryKeyValue
    private lateinit var cache: StreamCache
    private lateinit var od: OnDeviceResolver
    private lateinit var api: Api
    private lateinit var mm: String

    @Before fun setup() {
        MultiMoviesResolver.resetServerState()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path.startsWith("/api/resolve")) return MockResponse().setBody(
                    """{"stream":{"server":"x","sources":[{"url":"$mm/hi.m3u8","kind":"hls","quality":"1080p","language":"Hindi"},{"url":"$mm/te.m3u8","kind":"hls","quality":"1080p","language":"Telugu"}]}}""")
                if (path == "/hi.m3u8" || path == "/te.m3u8") return MockResponse().setBody(Fixtures.read("multimovies/rrr-bridge-telugu.m3u8"))
                if (path.startsWith("/api/streams/")) return MockResponse().setBody(
                    """{"success":true,"count":1,"streams":[{"url":"$mm/vm/te.m3u8","provider":"castletv","name":"Castle","quality":"1080p",
                       "languages":["Telugu","Hindi"],"audio":[{"language":"Telugu","languageCode":"te","codec":"mp4a"}],"codecs":"avc1.640028,mp4a.40.2"}]}""")
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
            netmirror = NetmirrorResolver(client, now = { clock }),
            cache = cache,
        ) { clock }
    }

    @After fun stop() = server.shutdown()

    /** MultiMovies /api/resolve calls (one resolve asks every server: [perResolve] calls). */
    private fun mmCalls() = hits.count { it.endsWith("/api/resolve") }
    private var perResolve = 0
    /** Whole MultiMovies resolves so far. */
    private fun mmResolves(): Int { if (perResolve == 0) perResolve = mmCalls(); return if (perResolve == 0) 0 else mmCalls().also { assertEquals("whole resolves only", 0, it % perResolve) } / perResolve }
    private fun vmCalls() = hits.count { it.contains("/api/streams/") }
    private fun mmRows(fresh: Boolean = false) = runBlocking {
        withTimeout(30_000) { od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs, "Telugu", fresh = fresh, originalLang = "te") }
    }
    private val key = StreamCache.key("movie", 579974, 0, 0)

    @Test fun cacheHitWithin30MinMakesZeroProviderRequests() {
        val first = mmRows()
        assertEquals(2, first.size)
        assertEquals(1, mmResolves())
        val before = hits.size
        clock += StreamCache.TTL_MS - 1
        val again = mmRows()
        assertEquals("0 requests on a hit", before, hits.size)
        assertEquals("same rows, tags intact", first, again)
        assertTrue(again.any { "Telugu" in it.languages })
        // VM: the second Play inside the TTL reuses the kept answer.
        runBlocking { api.streams("movie", 579974) }
        runBlocking { api.streams("movie", 579974) }
        assertEquals(1, vmCalls())
    }

    @Test fun expiresAt30Min() {
        mmRows()
        assertEquals(1, mmResolves())
        runBlocking { api.streams("movie", 579974) }
        clock += StreamCache.TTL_MS
        mmRows()
        runBlocking { api.streams("movie", 579974) }
        assertEquals(2, mmResolves())
        assertEquals(2, vmCalls())
    }

    @Test fun earlierUrlExpiryIsHonoured() {
        val exp = clock + 10 * 60_000
        val row = sample(url = "https://cdn.test/a/master.m3u8?e=${exp / 1000}&sig=abc")
        cache.putDevice(key, OnDeviceResolver.CASTLE, "Telugu", listOf(row))
        clock = exp - StreamCache.EXPIRY_SKEW_MS - 1
        assertNotNull(cache.device(key, OnDeviceResolver.CASTLE, "Telugu"))
        clock += 1
        assertNull("dead at its url's expiry, not at 30 min", cache.device(key, OnDeviceResolver.CASTLE, "Telugu"))
        // A proxied VM row: the upstream's expires= inside ?url= counts.
        val up = java.net.URLEncoder.encode("https://cdn.test/v.m3u8?expires=${(clock + 5 * 60_000) / 1000}", "UTF-8")
        cache.putVm(key, full = false, StreamsResponse(streams = listOf(RawStream(url = "https://vm.test/m3u8-proxy?url=$up", provider = "castletv"))))
        clock += 5 * 60_000 - StreamCache.EXPIRY_SKEW_MS - 1
        assertNotNull(cache.vm(key, full = false))
        clock += 1
        assertNull(cache.vm(key, full = false))
        // Not an expiry: a small number, or one years away. Unknown keeps the 30 min.
        assertNull(UrlExpiry.at("https://x.test/a.m3u8?e=5", clock))
        assertNull(UrlExpiry.at("https://x.test/a.m3u8?exp=${(clock + 5L * 365 * 86_400_000) / 1000}", clock))
        assertEquals(1_800_000_123_456L, UrlExpiry.at("https://x.test/a?internal_token=v2.1800000123456", 1_800_000_000_000L))
    }

    @Test fun playbackFailureEvictsAndReResolvesExactlyOnce() {
        val rows = mmRows()
        assertEquals(1, mmResolves())
        // The row failed: its provider's kept rows go; the next resolve fetches once, then is kept again.
        od.dropKept("movie", 579974, 0, 0, rows.first())
        assertNull(cache.device(key, OnDeviceResolver.MULTIMOVIES, "Telugu"))
        mmRows()
        assertEquals(2, mmResolves())
        mmRows()
        assertEquals("kept again, no loop", 2, mmResolves())
        // The player's own re-resolve (fresh) also fetches exactly once and replaces the kept rows.
        mmRows(fresh = true)
        assertEquals(3, mmResolves())
        mmRows()
        assertEquals(3, mmResolves())
        // A VM row failing drops the kept VM answer: the next Play asks the VM once.
        val vm = runBlocking { api.streams("movie", 579974) }
        assertEquals(1, vmCalls())
        od.dropKept("movie", 579974, 0, 0, sample(url = vm.streams.first().url!!, onDevice = null))
        runBlocking { api.streams("movie", 579974) }
        runBlocking { api.streams("movie", 579974) }
        assertEquals(2, vmCalls())
        // refresh=1 (FailPolicy REFRESH) never answers from the cache.
        runBlocking { api.streams("movie", 579974, refresh = true) }
        assertEquals(3, vmCalls())
    }

    @Test fun persistenceRoundTripThroughKvKeepsEveryTag() {
        val row = sample(url = "https://cdn.test/te.m3u8")
        cache.putDevice(key, OnDeviceResolver.CASTLE, "Telugu", listOf(row))
        val resp = StreamsResponse(success = true, count = 1, streams = listOf(RawStream(
            url = "https://vm.test/p.m3u8", provider = "vidrift", languages = listOf("Telugu", "Tamil"),
            audio = listOf(RawAudio(language = "Telugu", languageCode = "te", codec = "mp4a", channels = 6.0, isDefault = true)),
            levels = listOf(Level(1080, "1080p", 5_000_000, "avc1.640028")), codecs = "avc1.640028,mp4a.40.2", videoCodec = "h264",
            catalogLanguages = listOf("Telugu", "Hindi"), selectableAudio = true)))
        cache.putVm(key, full = false, resp)
        assertTrue(kv.get(StreamCache.KV_KEY)!!.isNotEmpty())
        // App restart inside the TTL: a new cache over the same kv.
        clock += 60_000
        val restarted = StreamCache(kv) { clock }
        assertEquals(listOf(row), restarted.device(key, OnDeviceResolver.CASTLE, "Telugu"))
        assertEquals(resp, restarted.vm(key, full = false))
        // Another audio language asked is another slot: never answered from Telugu's rows.
        assertNull(restarted.device(key, OnDeviceResolver.CASTLE, "Hindi"))
    }

    @Test fun prewarmSkipsCachedProviders() {
        mmRows()
        assertEquals(1, mmResolves())
        val started = od.prewarm("movie", 579974, 0, 0, codecs, "Telugu", "RRR", "te")
        assertFalse(OnDeviceResolver.MULTIMOVIES in started)
        assertTrue(OnDeviceResolver.MAPPLE in started)
        runBlocking { withTimeout(60_000) { od.prewarmJobs().forEach { runCatching { it.await() } } } }
        assertEquals("0 new MultiMovies requests", 1, mmResolves())
        // Play counts the kept provider as ready prewarm rows (start-race warm list).
        assertTrue(OnDeviceResolver.MULTIMOVIES in od.prewarmedNames("movie", 579974, 0, 0, "Telugu"))
    }

    @Test fun sizeCapEvictsOldest() {
        val row = sample(url = "https://cdn.test/te.m3u8")
        for (i in 1..StreamCache.MAX_TITLES + 1) {
            clock += 1_000
            cache.putDevice(StreamCache.key("movie", i.toLong(), 0, 0), OnDeviceResolver.CASTLE, "Telugu", listOf(row))
        }
        val keys = cache.titleKeys()
        assertEquals(StreamCache.MAX_TITLES, keys.size)
        assertFalse(StreamCache.key("movie", 1, 0, 0) in keys)
        assertTrue(StreamCache.key("movie", StreamCache.MAX_TITLES + 1L, 0, 0) in keys)
        assertEquals(StreamCache.MAX_TITLES, StreamCache(kv) { clock }.titleKeys().size)
    }

    @Test fun tvEpisodesAreSeparateAndIncompleteRowsAreNotKept() {
        val row = sample(url = "https://cdn.test/te.m3u8")
        cache.putDevice(StreamCache.key("tv", 1, 1, 1), OnDeviceResolver.NETMIRROR, "Telugu", listOf(row))
        assertNull(cache.device(StreamCache.key("tv", 1, 1, 2), OnDeviceResolver.NETMIRROR, "Telugu"))
        cache.putDevice(StreamCache.key("tv", 1, 1, 3), OnDeviceResolver.NETMIRROR, "Telugu", listOf(row.copy(incomplete = true)))
        assertNull(cache.device(StreamCache.key("tv", 1, 1, 3), OnDeviceResolver.NETMIRROR, "Telugu"))
    }

    private fun sample(url: String, onDevice: String? = "castletv") = Source(
        id = "device-castletv", provider = "castletv", label = "Castle", url = url, progressive = false, quality = "1080p",
        levels = listOf(Level(1080, "1080p", 4_000_000, "avc1.640028")), languages = listOf("Telugu", "Hindi"),
        selectableAudio = true, hybrid = false, subtitles = listOf(SubtitleRef("https://s.test/en.vtt", "en", "1")),
        videoCodec = "h264", codecString = "avc1.640028,mp4a.40.2", unsupported = false, onDevice = onDevice,
        headers = mapOf("Referer" to "https://castle.test/"), segmentToken = "tok", audioLanguages = listOf("Telugu", "Hindi"),
        catalogLanguages = listOf("Telugu", "Hindi", "Tamil"), netmirrorCatalog = "cat", incomplete = false,
        uriLanguages = listOf("Hindi"), directUrl = "https://cdn.test/direct.m3u8", directHeaders = mapOf("Origin" to "https://castle.test"),
    )
}
