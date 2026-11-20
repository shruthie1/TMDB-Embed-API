package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import com.chitram.app.player.FailPolicy
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleConfig
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.Pow
import com.chitram.app.resolve.ResolveConfig
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.SegmentForbidden
import com.chitram.app.resolve.StreamInterceptor
import com.chitram.app.resolve.VaplayerConfig
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class OnDeviceResolveTest {
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val client = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
    private lateinit var base: String
    private val noCodecs = CodecSupport { _, _ -> null }

    @Before fun start() { server.start(); base = server.url("/").toString().trimEnd('/') }
    @After fun stop() { server.shutdown(); VaplayerResolver.clearCache() }

    private fun serve(handler: (RecordedRequest) -> MockResponse) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen += request; return handler(request) }
        }
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private fun bodyJson(r: RecordedRequest): JsonObject = Json.parseToJsonElement(r.body.clone().readUtf8()).jsonObject

    // ---- PoW ----------------------------------------------------------------

    /** Reference nonces from providers/mapple.js solvePow in Node, 2026-11-20. */
    @Test fun powMatchesNode() {
        assertEquals("10860", Pow.solve("chitram-test-challenge", 12))
        assertEquals("1198", Pow.solve("9f2c1e7a-pow", 18))
        assertEquals(16, Pow.leadingZeroBits(byteArrayOf(0, 0, 0x80.toByte())))
        assertEquals(11, Pow.leadingZeroBits(byteArrayOf(0, 0x10)))
    }

    @Test fun powStopsWhenCancelled() {
        assertNull(Pow.solve("x", 60, active = { false }))
    }

    // ---- mapple -------------------------------------------------------------

    private val masterTe = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="te",NAME="Telugu",DEFAULT=YES,URI="a/te.m3u8"
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="hi",NAME="Hindi",DEFAULT=NO,URI="a/hi.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
        v/1080.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
        v/720.m3u8
    """.trimIndent()

    /** Behaves like mapple.fun: cookie, token, PoW, per-front answers, Referer-gated master. */
    private val masterBare = """
        #EXTM3U
        #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
        v/1080.m3u8
    """.trimIndent()

    private fun mappleSite(frontDelayMs: Map<String, Long> = emptyMap(), hasOn: Set<String> = setOf("s12"), bare: Set<String> = emptySet(), sessionOk: () -> Boolean = { true }) = serve { r ->
        val path = r.requestUrl!!.encodedPath
        when {
            path.startsWith("/watch/") -> MockResponse().addHeader("Set-Cookie", "_mapple_site=c1; Path=/; HttpOnly").setBody("<html/>")
            path == "/api/ui/session" ->
                if (!sessionOk()) MockResponse().setResponseCode(503)
                else if (r.getHeader("Cookie")?.contains("_mapple_site=c1") == true) json("""{"token":"RT"}""") else json("""{"error":"no cookie"}""")
            path == "/api/media-session" -> {
                val b = bodyJson(r)
                val pow = b["pow"] as? JsonObject
                when {
                    b["requestToken"]?.jsonPrimitive?.content != "RT" -> json("""{"error":"Invalid request token"}""")
                    pow == null -> json("""{"requiresPow":true,"pow":{"challenge":"chal","difficulty":8,"challengeId":"cid"}}""")
                    pow["challengeId"]!!.jsonPrimitive.content == "cid" &&
                        pow["nonce"]!!.jsonPrimitive.isString &&
                        pow["nonce"]!!.jsonPrimitive.content == Pow.solve("chal", 8) -> json("""{"token":"ST"}""")
                    else -> json("""{"requiresPow":true,"pow":{"challenge":"chal","difficulty":8,"challengeId":"cid"}}""")
                }
            }
            path == "/api/encrypt" -> {
                val b = bodyJson(r)
                if (b["requestToken"]?.jsonPrimitive?.content != "RT") json("""{"error":"no top-level token"}""")
                else json("""{"url":"/api/stream-encrypted?src=${b["data"]!!.jsonObject["source"]!!.jsonPrimitive.content}"}""")
            }
            path == "/api/stream-encrypted" -> {
                val src = r.requestUrl!!.queryParameter("src")!!
                val okTokens = r.requestUrl!!.queryParameter("token") == "ST" && r.requestUrl!!.queryParameter("requestToken") == "RT"
                val resp = when {
                    !okTokens -> json("""{"error":"bad tokens"}""")
                    src == "s25" -> json("""{"retryable":true,"failureKind":"SOURCE_TIMEOUT"}""")
                    src in hasOn -> json("""{"data":{"stream_url":"$base/m/$src/master.m3u8"}}""")
                    else -> json("""{"data":{"stream_url":"https://cdn.example/playback-unavailable"}}""")
                }
                frontDelayMs[src]?.let { resp.setBodyDelay(it, TimeUnit.MILLISECONDS) }
                resp
            }
            path.startsWith("/m/") ->
                if (r.getHeader("Origin").let { it == base || it == "https://mapple.test" } && r.getHeader("Referer") == r.getHeader("Origin") + "/")
                    MockResponse().setBody(if (path.split('/')[2] in bare) masterBare else masterTe)
                else MockResponse().setResponseCode(404).setBody("""{"error":"Not found"}""")
            else -> MockResponse().setResponseCode(404)
        }
    }

    private fun mappleCfg(vararg fronts: String) = MappleConfig(bases = listOf(base), fronts = fronts.toList(), frontParallelism = 1)

    @Test fun mappleFullChainWithPowAndFrontFailover() = runBlocking {
        mappleSite()
        val kv = MemoryKeyValue()
        val m = MappleResolver(client, HostBook(kv), kv)
        val r = m.resolve(mappleCfg("s25", "mapple", "s12", "s4"), "movie", 770906)!!

        assertEquals("$base/m/s12/master.m3u8", r.url)
        assertEquals("mapple · s12", r.label)
        assertEquals(listOf("Telugu", "Hindi"), r.audio.map { it.label })
        assertTrue(r.audio.first().isDefault)
        assertEquals(listOf(1080, 720), r.levels.map { it.height })
        assertEquals(mapOf("User-Agent" to MappleConfig.MAPPLE_UA, "Referer" to "$base/", "Origin" to base), r.headers)
        assertEquals("s12", kv.get(MappleResolver.KEY_FRONT))
        // Every request to the site carried Referer and Origin.
        assertTrue(seen.all { it.getHeader("Referer") == "$base/" && it.getHeader("Origin") == base })

        // Next resolve: the remembered front first, the failed one (s25) skipped.
        seen.clear()
        assertNotNull(m.resolve(mappleCfg("s25", "mapple", "s12", "s4"), "movie", 770906))
        val encrypts = seen.filter { it.requestUrl!!.encodedPath == "/api/encrypt" }
        assertEquals(1, encrypts.size)
        assertTrue(encrypts.single().body.clone().readUtf8().contains("\"source\":\"s12\""))
        // Session reused: no second /watch or /api/ui/session.
        assertTrue(seen.none { it.requestUrl!!.encodedPath.startsWith("/watch/") })
    }

    @Test fun mappleFrontTimeoutFailsOverToNextFront() = runBlocking {
        mappleSite(frontDelayMs = mapOf("s4" to 3000L), hasOn = setOf("s4", "s12"))
        val kv = MemoryKeyValue()
        val cfg = mappleCfg("s4", "s12").copy(defaultFrontTimeoutMs = 500)
        val t0 = System.currentTimeMillis()
        val r = MappleResolver(client, HostBook(kv), kv).resolve(cfg, "movie", 1)!!
        assertEquals("$base/m/s12/master.m3u8", r.url)
        assertTrue("took ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 2500)
    }

    @Test fun mappleCoolingFrontIsTriedLastNotDropped() = runBlocking {
        // s25 answers SOURCE_TIMEOUT. It cools down, but must still be tried (last).
        mappleSite(hasOn = setOf("s12"))
        var clock = 1_000_000L
        val kv = MemoryKeyValue()
        val m = MappleResolver(client, HostBook(kv), kv) { clock }
        assertNotNull(m.resolve(mappleCfg("s25", "s12"), "movie", 1))
        assertEquals(setOf("s25"), m.coolingFronts())

        // Only s25 configured: cooling, yet still asked (an error, not a silent skip).
        kv.put(MappleResolver.KEY_FRONT, null)
        seen.clear()
        try { m.resolve(mappleCfg("s25"), "movie", 1); fail("all fronts errored: must throw") } catch (e: com.chitram.app.resolve.StepException) {}
        assertEquals(1, seen.count { it.requestUrl!!.encodedPath == "/api/encrypt" })

        // Cooling order: s25 after s4 although s25 is listed first.
        seen.clear()
        m.resolve(mappleCfg("s25", "s4"), "movie", 2)
        val order = seen.filter { it.requestUrl!!.encodedPath == "/api/encrypt" }.map { bodyJson(it)["data"]!!.jsonObject["source"]!!.jsonPrimitive.content }
        assertEquals(listOf("s4", "s25"), order)

        // Cooldown expires: back in configured order.
        clock += 11 * 60 * 1000L
        assertTrue(m.coolingFronts().isEmpty())
    }

    @Test fun mappleTeluguFrontBeatsFasterNoAudioFront() = runBlocking {
        // s4 answers first with no audio list; s12 answers 600 ms later with Telugu.
        mappleSite(hasOn = setOf("s4", "s12"), bare = setOf("s4"), frontDelayMs = mapOf("s12" to 600L))
        val kv = MemoryKeyValue()
        val cfg = MappleConfig(bases = listOf(base), fronts = listOf("s4", "s12"), frontParallelism = 2, betterWaitMs = 2500)
        val r = MappleResolver(client, HostBook(kv), kv).resolve(cfg, "movie", 1)!!
        assertEquals("$base/m/s12/master.m3u8", r.url)
        assertEquals("Telugu", r.audio.first().label)
        assertEquals("s12", kv.get(MappleResolver.KEY_FRONT))

        // No Telugu front at all: the no-audio front still plays after betterWaitMs.
        mappleSite(hasOn = setOf("s4"), bare = setOf("s4"))
        val kv2 = MemoryKeyValue()
        val cfg2 = cfg.copy(fronts = listOf("s4", "mapple"), betterWaitMs = 300)
        val t0 = System.currentTimeMillis()
        val r2 = MappleResolver(client, HostBook(kv2), kv2).resolve(cfg2, "movie", 1)!!
        assertEquals("$base/m/s4/master.m3u8", r2.url)
        assertTrue("took ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 3000)
    }

    @Test fun breakerOpensAfterThreeFailuresAndFreshBypassesIt() = runBlocking {
        var sessionUp = false
        mappleSite(sessionOk = { sessionUp })
        // Config bases must be https, so point https://mapple.test at the mock server.
        val local = server.url("/")
        val routed = client.newBuilder().addInterceptor { ch ->
            val u = ch.request().url
            ch.proceed(if (u.host == "mapple.test") ch.request().newBuilder().url(u.newBuilder().scheme("http").host(local.host).port(local.port).build()).build() else ch.request())
        }.build()
        val inner = server.dispatcher
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.requestUrl!!.encodedPath == ResolveConfigStore.PATH)
                    json("""{"mapple":{"bases":["https://mapple.test"],"fronts":["s12"],"frontParallelism":1}}""")
                else inner.dispatch(request)
        }
        var clock = 1_000_000L
        val kv = MemoryKeyValue()
        val hosts = HostBook(kv)
        val store = ResolveConfigStore(routed, base + ResolveConfigStore.PATH, kv) { clock }
        assertEquals(listOf("https://mapple.test"), store.get().mapple.bases)
        val od = OnDeviceResolver(null, store, MappleResolver(routed, hosts, kv) { clock }, VaplayerResolver(routed, hosts) { null }, { _, _ -> null }) { clock }

        repeat(3) { assertNull(od.resolveOne(OnDeviceResolver.MAPPLE, "movie", 1, 0, 0, noCodecs)) }
        assertTrue(od.isOpen(OnDeviceResolver.MAPPLE))
        seen.clear()
        assertNull(od.resolveOne(OnDeviceResolver.MAPPLE, "movie", 1, 0, 0, noCodecs))
        assertTrue("breaker open: no request", seen.none { it.requestUrl!!.encodedPath != ResolveConfigStore.PATH })

        // The site recovers. A fresh (recovery) resolve ignores the breaker and closes it.
        sessionUp = true
        assertNotNull(od.resolveOne(OnDeviceResolver.MAPPLE, "movie", 1, 0, 0, noCodecs, fresh = true))
        assertFalse(od.isOpen(OnDeviceResolver.MAPPLE))
    }

    @Test fun configParsesRecoveryKnobsAndClampsThem() {
        val c = ResolveConfig.parse("""{"mapple":{"frontCooldownMs":120000,"betterWaitMs":99999999,"defaultFrontTimeoutMs":"bad"}}""")
        assertEquals(120_000L, c.mapple.frontCooldownMs)
        assertEquals(20_000L, c.mapple.betterWaitMs) // clamped
        assertEquals(MappleConfig().defaultFrontTimeoutMs, c.mapple.defaultFrontTimeoutMs) // bad type: default
        assertEquals(8000L, MappleConfig().defaultFrontTimeoutMs)
    }

    @Test fun mappleNoFrontHasItIsNullNotError() = runBlocking {
        mappleSite(hasOn = emptySet())
        val kv = MemoryKeyValue()
        assertNull(MappleResolver(client, HostBook(kv), kv).resolve(mappleCfg("mapple", "s12"), "movie", 1))
    }

    @Test fun mappleHealsToRedirectTarget() = runBlocking {
        mappleSite()
        val dead = MockWebServer()
        dead.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(301).setHeader("Location", "$base/")
        }
        dead.start()
        try {
            val deadBase = dead.url("/").toString().trimEnd('/')
            val kv = MemoryKeyValue()
            val hosts = HostBook(kv)
            val cfg = MappleConfig(bases = listOf(deadBase), fronts = listOf("s12"), frontParallelism = 1)
            val r = MappleResolver(client, hosts, kv).resolve(cfg, "movie", 770906)!!
            assertTrue(r.url.startsWith(base))
            assertEquals(base, r.headers["Origin"])
            assertEquals(base, hosts.healed("mapple"))
            assertEquals(listOf(base, deadBase), hosts.candidates("mapple", cfg.bases))
        } finally { dead.shutdown() }
    }

    // ---- config override ----------------------------------------------------

    @Test fun configOverrideAppliesAndFallsBack() = runBlocking {
        var status = 200
        serve { r ->
            if (r.requestUrl!!.encodedPath == ResolveConfigStore.PATH && status == 200) json(
                """{"version":3,"ttlSec":600,"mapple":{"fronts":["s99","s12"],"bases":["https://mapple.example","ftp://bad"],"sessionPath":"/api/v2/session","frontParallelism":"x"},
                   "vaplayer":{"apiTokenRegex":"(","playerOrigin":"https://player.example/"},"extra":1}""")
            else MockResponse().setResponseCode(if (status == 200) 404 else status)
        }
        var clock = 1_000_000L
        val kv = MemoryKeyValue()
        val store = ResolveConfigStore(client, base + ResolveConfigStore.PATH, kv) { clock }
        val c = store.get()
        assertEquals(3, c.version)
        assertEquals(listOf("s99", "s12"), c.mapple.fronts)
        assertEquals(listOf("https://mapple.example"), c.mapple.bases)
        assertEquals("/api/v2/session", c.mapple.sessionPath)
        assertEquals(MappleConfig().frontParallelism, c.mapple.frontParallelism) // bad type: default
        assertEquals(MappleConfig().mediaSessionPath, c.mapple.mediaSessionPath) // missing: default
        assertEquals(VaplayerConfig().apiTokenRegex, c.vaplayer.apiTokenRegex) // invalid regex: default
        assertEquals("https://player.example", c.vaplayer.playerOrigin)

        // Fresh: no refetch.
        val hits = server.requestCount
        store.get()
        assertEquals(hits, server.requestCount)

        // Stale and the backend is down: keeps the last good copy, retries only after RETRY_MS.
        status = 500
        clock += 601_000
        assertEquals(listOf("s99", "s12"), store.get().mapple.fronts)
        val afterFail = server.requestCount
        store.get()
        assertEquals(afterFail, server.requestCount)

        // A new store (next launch) reads the cached copy from KeyValue with no network.
        val again = ResolveConfigStore(client, base + ResolveConfigStore.PATH, kv) { clock }
        assertEquals(listOf("s99", "s12"), again.current().mapple.fronts)

        // Never fetched and the backend is down: defaults.
        val empty = ResolveConfigStore(client, base + ResolveConfigStore.PATH, MemoryKeyValue()) { clock }
        assertEquals(ResolveConfig(), empty.get())
    }

    @Test fun overriddenFrontListDrivesTheSweep() = runBlocking {
        mappleSite(hasOn = setOf("s7"))
        val override = ResolveConfig.parse("""{"mapple":{"fronts":["s3","s7"]}}""")
        val kv = MemoryKeyValue()
        val cfg = override.mapple.copy(bases = listOf(base), frontParallelism = 1)
        val r = MappleResolver(client, HostBook(kv), kv).resolve(cfg, "movie", 5)!!
        assertEquals("$base/m/s7/master.m3u8", r.url)
        val fronts = seen.filter { it.requestUrl!!.encodedPath == "/api/encrypt" }.map { bodyJson(it)["data"]!!.jsonObject["source"]!!.jsonPrimitive.content }
        assertEquals(listOf("s3", "s7"), fronts)
    }

    // ---- vaplayer -----------------------------------------------------------

    private var apiTokenUsed = false

    private fun vaSite(segmentCode: Int = 200, status: String = "200") = serve { r ->
        val u = r.requestUrl!!
        val origin = "https://nextgencloudfabric.com"
        val playerHdrs = r.getHeader("Referer") == "$origin/" && r.getHeader("Origin") == origin
        when (u.encodedPath) {
            "/embed/va_src.php" -> json("""{"src":"$base/player/abc"}""")
            "/player/abc" -> MockResponse().setBody("""<script>var CONFIG={"apiToken":"AT1","x":1}</script>""")
            "/api.php" -> when {
                !playerHdrs -> MockResponse().setResponseCode(403)
                u.queryParameter("api_token") != "AT1" || apiTokenUsed -> json("""{"status_code":"403","error":"invalid api token"}""")
                status != "200" -> json("""{"status_code":$status}""")
                else -> {
                    apiTokenUsed = true
                    val plain = ByteArray(12) + "$base/pl/master.m3u8\n".toByteArray()
                    json("""{"status_code":"200","data":{"stream_urls":"${plain.toByteString().base64()}","file_name":"x.mkv"},"va":{"w":1,"wasm_url":"$base/wasm.php?w=1"}}""")
                }
            }
            "/wasm.php" -> MockResponse().setHeader("Content-Type", "application/wasm").setBody(okio.Buffer().write(TestWasm.IDENTITY))
            "/generate.php" -> if (u.queryParameter("api_token") == "AT1" && playerHdrs) MockResponse().setBody("HT") else MockResponse().setResponseCode(403)
            "/pl/master.m3u8" -> if (u.queryParameter("token") == "HT" && playerHdrs)
                MockResponse().setBody("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv/720.m3u8\n") else MockResponse().setResponseCode(401)
            "/pl/v/720.m3u8" -> if (u.queryParameter("token") == "HT" && playerHdrs)
                MockResponse().setBody("#EXTM3U\n#EXTINF:6,\nseg0.ts\n") else MockResponse().setResponseCode(403)
            "/pl/v/seg0.ts" -> if (u.queryParameter("token") == "HT" && playerHdrs && segmentCode == 200)
                MockResponse().setBody("G") else MockResponse().setResponseCode(403)
            else -> MockResponse().setResponseCode(404)
        }
    }

    private fun vaCfg() = VaplayerConfig(wrapperBases = listOf(base), apiUrl = "$base/api.php")

    @Test fun vaplayerFullChainDecryptsAndSignsSegments() = runBlocking {
        vaSite()
        val r = VaplayerResolver(client, HostBook(MemoryKeyValue())) { null }.resolve(vaCfg(), "tt0816692", "movie")!!
        assertEquals("$base/pl/master.m3u8?token=HT", r.url)
        assertEquals("HT", r.segmentToken)
        assertEquals(listOf(720), r.levels.map { it.height })
        assertEquals("https://nextgencloudfabric.com", r.headers["Origin"])
        assertEquals(setOf("$base/wasm.php?w=1"), VaplayerResolver.cachedUrls())
        // The segment probe went out with the host token appended by the interceptor.
        val seg = seen.single { it.requestUrl!!.encodedPath == "/pl/v/seg0.ts" }
        assertEquals("HT", seg.requestUrl!!.queryParameter("token"))
        assertEquals("tt0816692", seen.single { it.requestUrl!!.encodedPath == "/api.php" }.requestUrl!!.queryParameter("imdb"))
    }

    @Test fun vaplayerSegment403FailsTheResolve() = runBlocking {
        vaSite(segmentCode = 403)
        try {
            VaplayerResolver(client, HostBook(MemoryKeyValue())) { null }.resolve(vaCfg(), "tt0816692", "movie")
            fail("expected SegmentForbidden")
        } catch (e: SegmentForbidden) { assertTrue(e.message!!.contains("403")) }
    }

    @Test fun vaplayerNotFoundIsNull() = runBlocking {
        vaSite(status = "404")
        assertNull(VaplayerResolver(client, HostBook(MemoryKeyValue())) { null }.resolve(vaCfg(), "tt0000001", "movie"))
    }

    /** CGNAT case end to end: vaplayer fails, mapple still gives a row, nothing hangs. */
    @Test fun failedVaplayerIsDroppedAndMappleStillResolves() = runBlocking {
        val va = MockWebServer()
        va.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/embed/va_src.php" -> MockResponse().setResponseCode(403) // blocked
                else -> MockResponse().setResponseCode(404)
            }
        }
        va.start()
        mappleSite()
        try {
            val vaBase = va.url("/").toString().trimEnd('/')
            val kv = MemoryKeyValue()
            // Configured hosts are unresolvable (.invalid), so nothing leaves the machine;
            // the mock hosts are reached through the healed-host memory.
            kv.put(ResolveConfigStore.KEY, """{"mapple":{"bases":["https://mapple.invalid"]},"vaplayer":{"wrapperBases":["https://vaplayer.invalid"]}}""")
            kv.put(ResolveConfigStore.KEY_AT, System.currentTimeMillis().toString())
            val store = ResolveConfigStore(client, "$base/none", kv)
            val hosts = HostBook(kv)
            hosts.remember("mapple", base, listOf("https://mapple.invalid"))
            hosts.remember("VaPlayer", vaBase, listOf("https://vaplayer.invalid"))
            kv.put(MappleResolver.KEY_FRONT, "s12")
            val od = OnDeviceResolver(null, store, MappleResolver(client, hosts, kv), VaplayerResolver(client, hosts) { null }, imdbFor = { _, _ -> "tt0816692" })
            val t0 = System.currentTimeMillis()
            val rows = od.launch(this, "movie", 770906, 0, 0, noCodecs).map { it.await() }
            assertTrue(System.currentTimeMillis() - t0 < 10_000)
            assertEquals("mapple", rows[0]!!.onDevice)
            assertEquals(listOf("Telugu", "Hindi"), rows[0]!!.languages)
            assertTrue(rows[0]!!.selectableAudio)
            assertNull(rows[1])
        } finally { va.shutdown() }
    }

    // ---- player side --------------------------------------------------------

    @Test fun interceptorAddsHeadersAndTokenOnce() {
        serve { MockResponse().setBody("ok") }
        val h = mapOf("Referer" to "https://p.example/", "Origin" to "https://p.example", "User-Agent" to "UA-X")
        val c = StreamInterceptor.client(client, h, "HT")
        c.newCall(Request.Builder().url("$base/v/seg1.ts").build()).execute().close()
        c.newCall(Request.Builder().url("$base/pl/master.m3u8?token=OWN").build()).execute().close()
        c.newCall(Request.Builder().url("$base/v/seg2.ts?x=1").build()).execute().close()
        val (seg, master, seg2) = seen.toList()
        assertEquals("HT", seg.requestUrl!!.queryParameter("token"))
        assertEquals(listOf("OWN"), master.requestUrl!!.queryParameterValues("token"))
        assertEquals("1", seg2.requestUrl!!.queryParameter("x"))
        assertEquals("HT", seg2.requestUrl!!.queryParameter("token"))
        for (r in seen) {
            assertEquals("https://p.example/", r.getHeader("Referer"))
            assertEquals("https://p.example", r.getHeader("Origin"))
            assertEquals("UA-X", r.getHeader("User-Agent"))
        }
        // mapple rows: headers only, no token.
        seen.clear()
        StreamInterceptor.client(client, h, null).newCall(Request.Builder().url("$base/seg.ts").build()).execute().close()
        assertNull(seen.single().requestUrl!!.queryParameter("token"))
    }

    private fun src(provider: String, langs: List<String>, onDevice: String? = null, selectable: Boolean = false) = Source(
        "$provider-0", provider, provider, "u", false, "Auto", emptyList(), langs, selectable, false, emptyList(), null, null, false, onDevice,
    )

    @Test fun failPolicyNeverRefreshesOnDeviceRows() {
        val va = src("VaPlayer", emptyList(), onDevice = "VaPlayer")
        val backend = src("castle", listOf("Telugu"))
        assertEquals(FailPolicy.Action.RERESOLVE, FailPolicy.onError(va, 403, refreshedOnce = false))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(va, 403, refreshedOnce = false, deviceRetried = true))
        assertEquals(FailPolicy.Action.REFRESH, FailPolicy.onError(backend, 403, refreshedOnce = false))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(backend, 403, refreshedOnce = true))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(backend, 500, refreshedOnce = false))
    }

    @Test fun rankingPutsTeluguMappleFirstAndVaplayerAfterMapple() {
        val backend = src("castle", listOf("Hindi"))
        val mapple = src("mapple", listOf("Telugu", "Hindi"), onDevice = "mapple", selectable = true).copy(id = "device-mapple")
        val va = src("VaPlayer", emptyList(), onDevice = "VaPlayer").copy(id = "device-VaPlayer")
        val other = src("other", emptyList())
        val ranked = Ranking.merge(listOf(backend, other), listOf(va, mapple), "Telugu")
        assertEquals(listOf("device-mapple", "castle-0", "other-0", "device-VaPlayer"), ranked.map { it.id })
        // A late row replaces an earlier copy of itself, never duplicates.
        assertEquals(4, Ranking.merge(ranked, listOf(mapple), "Telugu").size)
        assertFalse(Ranking.merge(ranked, listOf(mapple), "Telugu").map { it.id }.toSet().size < 4)
    }
}
