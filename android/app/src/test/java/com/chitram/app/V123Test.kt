package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.data.VmHealth
import com.chitram.app.player.FailPolicy
import com.chitram.app.player.StartRace
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.TitleMatch
import com.chitram.app.resolve.TsAudio
import com.chitram.app.resolve.TsAudioSwap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * 1.2.3: cooperative APK Phase 1 (selfcontained/plan.md, PENDING-WORK K1).
 * The VM is used when it answers; the app never dead-ends when it does not.
 */
class V123Test {
    /** Like viewModelScope: a failed VM call must not cancel its siblings. */
    private val vmScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)
    private fun src(id: String, provider: String, langs: List<String> = listOf("Telugu"), onDevice: String? = null, sel: Boolean = false) =
        Source(id, provider, provider, "https://h/$id", false, "1080p", emptyList(), langs, sel, false, emptyList(), null, null, false, onDevice = onDevice)

    // ---- VM breaker ------------------------------------------------------------

    @Test fun breakerOpensAfterTwoFailsAndDoubles() {
        var now = 1_000_000L
        val kv = MemoryKeyValue()
        val vm = VmHealth(kv) { now }
        assertTrue(vm.allow())
        vm.onFailure()
        assertTrue("one blip keeps the VM", vm.allow())
        vm.onFailure()
        assertFalse(vm.allow())
        assertEquals(now + 60_000, vm.openUntil)
        now += 60_000
        assertTrue("half-open probe after 60s", vm.allow())
        assertTrue(vm.halfOpen)
        vm.onFailure()
        assertEquals(now + 120_000, vm.openUntil)
        repeat(10) { vm.onFailure() }
        assertEquals(now + 600_000, vm.openUntil) // capped at 10 min
        vm.onSuccess()
        assertTrue(vm.allow())
        assertFalse(vm.halfOpen)
    }

    @Test fun breakerStateSurvivesAColdStart() {
        val now = 5_000_000L
        val kv = MemoryKeyValue()
        VmHealth(kv) { now }.apply { onFailure(); onFailure() }
        val fresh = VmHealth(kv) { now + 1_000 }
        assertFalse("cached vm.down.until skips the timeout on a cold start", fresh.allow())
    }

    // ---- Api.streams: direct VM origin, short timeouts, breaker ----------------

    @Test fun streamsGoStraightToTheVmAndOpenTheBreaker() = runBlocking {
        val server = MockWebServer()
        repeat(2) { server.enqueue(MockResponse().setResponseCode(502)) }
        server.start()
        val vm = VmHealth(MemoryKeyValue())
        val api = Api(OkHttpClient(), base = "http://vercel.invalid", vmBase = server.url("").toString().trimEnd('/'), vm = vm)
        repeat(2) { runCatching { api.streams("movie", 1) }.exceptionOrNull().let { assertNotNull(it) } }
        assertEquals("no retries stacked on a 5xx", 2, server.requestCount)
        assertEquals("/api/streams/movie/1", server.takeRequest().path)
        val t0 = System.currentTimeMillis()
        val e = runCatching { api.streams("movie", 1) }.exceptionOrNull()
        assertTrue(e is Api.VmDown)
        assertTrue("open breaker answers at once", System.currentTimeMillis() - t0 < 200)
        assertEquals(2, server.requestCount)
        server.shutdown()
    }

    @Test fun aHangingVmIsCutAtTheCallTimeout() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        val api = Api(OkHttpClient(), vmBase = server.url("").toString().trimEnd('/'), vm = VmHealth(MemoryKeyValue()), streamsCallTimeoutMs = 1_000)
        val t0 = System.currentTimeMillis()
        assertTrue(runCatching { api.streams("movie", 1) }.exceptionOrNull() is IOException)
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms", ms in 900..3_000)
        assertEquals(Api.STREAMS_CALL_TIMEOUT_MS, 22_000L)
        assertEquals(Api.VM_CONNECT_TIMEOUT_MS, 3_000L)
        server.shutdown()
    }

    @Test fun halfOpenProbesStatusFirst() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(503)) // /api/status probe fails
        server.start()
        var now = 0L
        val vm = VmHealth(MemoryKeyValue()) { now }
        vm.onFailure(); vm.onFailure()
        now += 60_000
        val api = Api(OkHttpClient(), vmBase = server.url("").toString().trimEnd('/'), vm = vm)
        assertTrue(runCatching { api.streams("movie", 1) }.exceptionOrNull() is Api.VmDown)
        assertEquals("/api/status", server.takeRequest().path)
        assertEquals(1, server.requestCount)
        assertFalse(vm.allow())
        server.shutdown()
    }

    // ---- Device rows never wait on the VM --------------------------------------

    /** VM down (connection refused): device rows are listed within a few seconds. */
    @Test fun vmDownStillListsDeviceRowsFast() = runBlocking {
        val dead = MockWebServer().apply { start() }
        val origin = dead.url("").toString().trimEnd('/')
        dead.shutdown() // nothing listens: connect is refused
        val api = Api(OkHttpClient(), vmBase = origin, vm = VmHealth(MemoryKeyValue()))
        val t0 = System.currentTimeMillis()
        val backend = vmScope.async { api.streams("movie", 1222479).streams.map { src("vm", it.provider ?: "?") } }
        val castle = async { delay(800); src("device-CastleTV", "CastleTV", onDevice = "CastleTV") }
        val mapple = async { delay(20_000); null as Source? }
        val first = StartRace().first(backend, listOf(castle, mapple), "Telugu")
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms", ms < 3_000)
        assertEquals(listOf("device-CastleTV"), first.device.map { it.id })
        assertTrue(first.backend.isEmpty())
        assertNotNull(first.backendError)
        mapple.cancel()
    }

    /** VM accepts the connection and hangs: device rows start once the VM's lead is spent. */
    @Test fun hangingVmDoesNotHoldDeviceRows() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        val api = Api(OkHttpClient(), vmBase = server.url("").toString().trimEnd('/'), vm = VmHealth(MemoryKeyValue()))
        val t0 = System.currentTimeMillis()
        val backend = vmScope.async { api.streams("movie", 1222479).streams.map { src("vm", it.provider ?: "?") } }
        val castle = async { delay(500); src("device-CastleTV", "CastleTV", onDevice = "CastleTV") }
        val first = StartRace().first(backend, listOf(castle), "Telugu")
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms", ms < StartRace.VM_LEAD_MS + 1_500)
        assertTrue(first.backendPending)
        assertEquals(1, first.device.size)
        backend.cancel()
        server.shutdown()
    }

    /** VM answers before any device row: VM rows lead, the device row joins as a twin. */
    @Test fun healthyVmStillLeads() = runBlocking {
        val backend = async { delay(100); listOf(src("CastleTV-0", "CastleTV", sel = true)) }
        val castle = async { delay(300); src("device-CastleTV", "CastleTV", onDevice = "CastleTV") }
        val first = StartRace().first(backend, listOf(castle), "Telugu")
        assertFalse(first.backendPending)
        assertEquals(listOf("CastleTV-0"), first.backend.map { it.id })
        // Same provider from both sides: the device row (late) is a hidden twin.
        val (shown, twins) = StartRace.splitTwins(first.backend, listOfNotNull(castle.await()))
        assertTrue(shown.isEmpty())
        assertEquals("device-CastleTV", twins["castletv"]?.id)
    }

    @Test fun breakerOpenSkipsTheVmEntirely() = runBlocking {
        val castle = CompletableDeferred(src("device-CastleTV", "CastleTV", onDevice = "CastleTV"))
        val first = StartRace().first(null, listOf(castle), "Telugu")
        assertEquals(1, first.device.size)
        assertFalse(first.backendPending)
    }

    // ---- A VM row that fails is re-resolved on the device ----------------------

    @Test fun vmCastleRowFailsOverToTheDeviceTwin() {
        val vmCastle = src("CastleTV-1", "CastleTV")
        assertEquals(FailPolicy.Action.DEVICE, FailPolicy.onError(vmCastle, 404, refreshedOnce = false))
        assertEquals(FailPolicy.Action.DEVICE, FailPolicy.onError(src("mm", "multimovies"), null, refreshedOnce = false))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(vmCastle, 404, refreshedOnce = false, twinTried = true))
        assertEquals(FailPolicy.Action.REFRESH, FailPolicy.onError(src("v", "vidrock"), 403, refreshedOnce = false))
    }

    // ---- Castle muxed Telugu: TS PID swap (port of web/lib/player/tsAudio.js) --

    @Test fun crcIsMpeg2() {
        assertEquals(0x0376E6E7, TsAudio.crc32("123456789".toByteArray(), 0, 9))
    }

    @Test fun teluguPidSwapsIntoTheFirstAacSlot() {
        val ts = TsFixture.segment()
        val before = TsAudio.probe(ts)!!
        assertEquals(listOf("hin", "mal", "tam", "tel", "kan"), before.map { it.lang })
        assertTrue(TsAudio.apply(ts, "tel"))
        // The Telugu payload (marker 0x04) now rides on PID 0x101, the slot media3 reads.
        assertEquals(0x101, TsFixture.pidOfMarker(ts, 0x04))
        assertEquals(0x104, TsFixture.pidOfMarker(ts, 0x01))
        val after = TsAudio.probe(ts)!!
        assertEquals("tel", after.first { it.pid == 0x101 }.lang)
        assertEquals("hin", after.first { it.pid == 0x104 }.lang)
        assertTrue("PMT CRC still valid", TsFixture.pmtCrcOk(ts))
    }

    @Test fun swapRefusesNonTsAndLeavesItAlone() {
        val text = "#EXTM3U\n#EXTINF:6,\nseg.ts\n".toByteArray()
        val copy = text.copyOf()
        assertFalse(TsAudio.apply(text, "tel"))
        assertArrayEquals(copy, text)
        assertNull(TsAudio.probe(text))
    }

    @Test fun swapInterceptorRewritesSegmentsOnly() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(Buffer().write(TsFixture.segment())))
        server.enqueue(MockResponse().setBody("#EXTM3U\n"))
        server.start()
        val client = OkHttpClient.Builder().addInterceptor(TsAudioSwap("Telugu")).build()
        val seg = client.newCall(Request.Builder().url(server.url("/a.ts")).build()).execute().body!!.bytes()
        assertEquals(0x101, TsFixture.pidOfMarker(seg, 0x04))
        assertEquals("#EXTM3U\n", client.newCall(Request.Builder().url(server.url("/i.m3u8")).build()).execute().body!!.string())
        server.shutdown()
    }

    @Test fun swapAppliesToMuxedCastleRowsOnly() {
        assertTrue(TsAudioSwap.wanted(src("c", "CastleTV", listOf("Hindi", "Telugu"))))
        assertFalse(TsAudioSwap.wanted(src("d", "CastleTV", listOf("Hindi", "Telugu"), sel = true))) // castle-demux
        assertFalse(TsAudioSwap.wanted(src("o", "OneTouchTV", listOf("Hindi", "Telugu"))))
        assertEquals("tel", TsAudio.iso3("Telugu"))
    }

    // ---- Castle on the device --------------------------------------------------

    @Test fun castleDecryptsLikeTheServer() {
        // Vector from node crypto (aes-128-cbc, key = iv = base64(key)+"T!BgJB" first 16 bytes).
        val plain = CastleResolver.decrypt(
            "JNv2ioMmHQT7BpZ8Jbj07jSHHEL6ssO6WPLObSJaeqedxTVXXibHBr0h1tUBkH5yWx3170SCATtuLe+qNT8fyFTfnV5YTUOvRHm8904av9U=",
            "azN5Qnl0ZXNGb3JUZXN0",
        )
        assertEquals("""{"code":200,"data":{"rows":[{"id":1234567890123456789,"title":"Mirai"}]}}""", plain)
        // 19-digit ids survive (the server quotes them before JSON.parse).
        assertEquals("1234567890123456789", CastleResolver.rows(plain).first().id)
    }

    @Test fun castleGroupsLanguagesByMediaIdentity() {
        val hits = listOf(
            CastleResolver.Hit("Hindi", "https://c/hls/abc/720/index_2.m3u8?t=1", "720p"),
            CastleResolver.Hit("Telugu", "https://c/hls/abc/720/index_7.m3u8?t=2", "720p"),
            CastleResolver.Hit("Tamil", "https://c/hls/abc/480/index_2.m3u8", "480p"),
            CastleResolver.Hit("Telugu", "https://c/hls/abc/480/index_3.m3u8", "480p"),
        )
        val rows = CastleResolver.group(hits, "Telugu")
        assertEquals("https://c/hls/abc/720/index_2.m3u8?t=1", rows.first().url)
        assertEquals(listOf("Telugu", "Hindi"), rows.first().languages)
        assertEquals(2, rows.size)
    }

    @Test fun titleMatchLikeTheServer() {
        assertEquals(listOf("Pushpa 2: The Rule 2024", "Pushpa 2: The Rule", "Pushpa 2 The Rule", "Pushpa 2"),
            TitleMatch.spellings("Pushpa 2: The Rule", 2024).take(4))
        val rows = listOf("RRR (Hindi)", "Pushpa 2 - The Rule", "Mirai")
        assertEquals("RRR (Hindi)", TitleMatch.find(rows, "RRR") { it })
        assertEquals("Pushpa 2 - The Rule", TitleMatch.find(rows, "Pushpa 2: The Rule") { it })
        // 1.2.4: the fold pass closes the Mirayi/Mirai gap (V124Test.mirayiFindsCastleMirai).
        assertEquals("Mirai", TitleMatch.find(rows, "Mirayi") { it })
        assertNull(TitleMatch.find(listOf("Kalki 2898 AD Part 2"), "Kalki 2898 AD Part 1") { it })
    }

    // ---- MultiMovies on the device ---------------------------------------------

    @Test fun multiMoviesResolvesTeluguFirst() = runBlocking {
        // The resolver asks the plain /api/resolve plus `only=<server>` for every
        // VidBolt server in parallel (all-servers fix), so answer by path, not by queue order.
        MultiMoviesResolver.resetServerState()
        val server = MockWebServer()
        val base = server.url("").toString().trimEnd('/')
        val master = "#EXTM3U\n" +
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Hindi\",LANGUAGE=\"hin\",URI=\"a-hin.m3u8\"\n" +
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Telugu\",LANGUAGE=\"tel\",URI=\"a-tel.m3u8\"\n" +
            "#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",AUDIO=\"a\"\nv1080.m3u8\n"
        val paths = java.util.Collections.synchronizedList(mutableListOf<String>())
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val path = request.path!!
                paths += path
                return when {
                    path == "/api/resolve?type=movie&id=784572" ->
                        MockResponse().setBody("""{"stream":{"server":"x","sources":[{"url":"$base/m/master.m3u8","kind":"hls","quality":"1080p"}]}}""")
                    path.startsWith("/api/resolve") -> MockResponse().setBody("""{"stream":null}""")
                    path == "/m/master.m3u8" -> MockResponse().setBody(master)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val r = MultiMoviesResolver(OkHttpClient(), origin = base).resolve("movie", 784572, 0, 0)!!
        assertTrue(paths.toString(), "/api/resolve?type=movie&id=784572" in paths)
        assertEquals("$base/m/master.m3u8", r.url)
        assertEquals("$base/", r.headers["Referer"])
        assertEquals(listOf("Hindi", "Telugu"), r.audio.mapNotNull { it.label })
        assertEquals(1080, r.levels.first().height)
        server.shutdown()
    }

    // ---- Live, opt-in (CHITRAM_LIVE=1): one Castle chain, one MultiMovies call -

    @Test fun liveCastleMirai() = runBlocking {
        org.junit.Assume.assumeTrue(System.getenv("CHITRAM_LIVE") == "1")
        val c = OkHttpClient()
        val t0 = System.currentTimeMillis()
        val r = CastleResolver(c).resolve("movie", "Mirai", 2025, 0, 0, "Telugu")
        println("LIVE castle Mirai in ${System.currentTimeMillis() - t0}ms: ${r?.url?.take(90)} langs=${r?.audio?.map { it.label }} muxed=${r?.muxed} levels=${r?.levels}")
        assertNotNull(r)
        // First TS segment: which AAC tracks it carries, and whether the swap plan finds Telugu.
        val req = { u: String -> okhttp3.Request.Builder().url(u).apply { r!!.headers.forEach { (k, v) -> header(k, v) } }.build() }
        var url = r!!.url
        var text = c.newCall(req(url)).execute().use { it.body!!.string() }
        val variant = text.lines().firstOrNull { it.isNotBlank() && !it.startsWith("#") && it.contains(".m3u8") }
        if (variant != null) { url = url.toHttpUrl().resolve(variant).toString(); text = c.newCall(req(url)).execute().use { it.body!!.string() } }
        val seg = text.lines().first { it.isNotBlank() && !it.startsWith("#") }
        val bytes = c.newCall(req(url.toHttpUrl().resolve(seg).toString())).execute().use { it.body!!.bytes() }
        println("LIVE castle segment ${bytes.size} bytes, tracks=${TsAudio.probe(bytes)} plan(tel)=${TsAudio.plan(bytes, "tel")}")
    }

    @Test fun liveMultiMovies() = runBlocking {
        org.junit.Assume.assumeTrue(System.getenv("CHITRAM_LIVE") == "1")
        val t0 = System.currentTimeMillis()
        val r = MultiMoviesResolver(OkHttpClient()).resolve("movie", 1222479, 0, 0)
        println("LIVE multimovies 1222479 in ${System.currentTimeMillis() - t0}ms: ${r?.url?.take(90)} langs=${r?.audio?.map { it.label }} top=${r?.levels?.firstOrNull()?.height}")
    }
}

/** A tiny CastleTV-shaped TS segment: PAT, PMT (H.264 + 5 AAC hin/mal/tam/tel/kan), one packet per PID. */
object TsFixture {
    private const val PMT_PID = 0x1000
    private val LANGS = listOf("hin", "mal", "tam", "tel", "kan")

    private fun packet(pid: Int, pusi: Boolean, payload: ByteArray): ByteArray {
        val p = ByteArray(188) { 0xFF.toByte() }
        p[0] = 0x47
        p[1] = ((if (pusi) 0x40 else 0) or ((pid shr 8) and 0x1F)).toByte()
        p[2] = (pid and 0xFF).toByte()
        p[3] = 0x10
        System.arraycopy(payload, 0, p, 4, payload.size)
        return p
    }

    private fun section(body: ByteArray): ByteArray {
        // body starts at table_id; length field covers everything after it incl. CRC
        val len = body.size - 3 + 4
        body[1] = (0xB0 or ((len shr 8) and 0x0F)).toByte()
        body[2] = (len and 0xFF).toByte()
        val crc = TsAudio.crc32(body, 0, body.size)
        return byteArrayOf(0) + body + byteArrayOf((crc ushr 24).toByte(), (crc ushr 16).toByte(), (crc ushr 8).toByte(), crc.toByte())
    }

    fun segment(): ByteArray {
        val pat = section(byteArrayOf(0x00, 0, 0, 0x00, 0x01, 0xC1.toByte(), 0, 0, 0x00, 0x01, (0xE0 or (PMT_PID shr 8)).toByte(), (PMT_PID and 0xFF).toByte()))
        val es = ArrayList<Byte>()
        es += listOf(0x1B, 0xE1, 0x00, 0xF0, 0x00).map { it.toByte() }
        LANGS.forEachIndexed { i, l ->
            val pid = 0x101 + i
            es += listOf(0x0F, 0xE0 or (pid shr 8), pid and 0xFF, 0xF0, 6).map { it.toByte() }
            es += listOf(0x0A, 4).map { it.toByte() }
            es += l.toByteArray().toList()
            es += 0.toByte()
        }
        val pmt = section(byteArrayOf(0x02, 0, 0, 0x00, 0x01, 0xC1.toByte(), 0, 0, 0xE1.toByte(), 0x00, 0xF0.toByte(), 0x00) + es.toByteArray())
        val out = java.io.ByteArrayOutputStream()
        out.write(packet(0, true, pat))
        out.write(packet(PMT_PID, true, pmt))
        out.write(packet(0x100, false, byteArrayOf(0x55)))
        for (i in 0 until 5) out.write(packet(0x101 + i, false, byteArrayOf((i + 1).toByte())))
        return out.toByteArray()
    }

    /** PID of the audio packet whose first payload byte is `marker`. */
    fun pidOfMarker(b: ByteArray, marker: Int): Int {
        var i = 0
        while (i + 188 <= b.size) {
            val pid = ((b[i + 1].toInt() and 0x1F) shl 8) or (b[i + 2].toInt() and 0xFF)
            if (pid in 0x101..0x105 && b[i + 4].toInt() == marker) return pid
            i += 188
        }
        return -1
    }

    fun pmtCrcOk(b: ByteArray): Boolean {
        val i = 188 // second packet
        val s = i + 4 + 1
        val len = ((b[s + 1].toInt() and 0x0F) shl 8) or (b[s + 2].toInt() and 0xFF)
        return TsAudio.crc32(b, s, s + 3 + len) == 0
    }
}
