package com.chitram.app

import com.chitram.app.data.Source
import com.chitram.app.player.LanProxy
import com.chitram.app.player.PlayRequest
import com.chitram.app.player.WvcCast
import com.chitram.app.resolve.StreamInterceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 1.2.5: C5. The phone serves an on-device row (mapple, vaplayer) on the LAN so
 * the TV can cast it: playlists rewritten to the phone, every upstream request
 * carries the provider headers and vaplayer's ?token=.
 */
class V125Test {
    private val up = MockWebServer()
    private val plain = OkHttpClient()
    private var proxy: LanProxy? = null
    private val seg = ByteArray(188 * 4) { if (it % 188 == 0) 0x47 else (it % 251).toByte() }
    private val headers = mapOf("Referer" to "https://vaplayer.example/", "Origin" to "https://vaplayer.example", "User-Agent" to "ChitramUA")

    @Before fun setUp() {
        up.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                // The provider refuses anything without its Referer (measured 403 on vaplayer).
                if (request.getHeader("Referer") != "https://vaplayer.example/") return MockResponse().setResponseCode(403)
                val path = request.requestUrl!!.encodedPath
                return when (path) {
                    "/hls/master.m3u8" -> MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl").setBody(
                        "#EXTM3U\n" +
                            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Telugu\",LANGUAGE=\"tel\",URI=\"audio/tel.m3u8\"\n" +
                            "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO=\"a\"\n" +
                            "v/index.m3u8\n")
                    // No .m3u8 content type here: the proxy must sniff #EXTM3U.
                    "/hls/v/index.m3u8" -> MockResponse().setHeader("Content-Type", "text/plain").setBody(
                        "#EXTM3U\n#EXT-X-TARGETDURATION:4\n" +
                            "#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1\"\n" +
                            "#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nhttps://cdn2.example/abs/seg1.ts\n#EXT-X-ENDLIST\n")
                    "/hls/v/seg0.ts" -> MockResponse().setHeader("Content-Type", "video/mp2t").setBody(Buffer().write(seg))
                    "/film.mp4" -> {
                        val range = request.getHeader("Range")
                        if (range == "bytes=100-199") MockResponse().setResponseCode(206).setHeader("Content-Type", "video/mp4")
                            .setHeader("Content-Range", "bytes 100-199/1000").setBody(Buffer().write(ByteArray(100) { 7 }))
                        else MockResponse().setHeader("Content-Type", "video/mp4").setBody(Buffer().write(ByteArray(1000) { 7 }))
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        up.start()
    }

    @After fun tearDown() {
        proxy?.close()
        up.shutdown()
    }

    private fun start(token: String? = "TOK", allow: (InetAddress) -> Boolean = LanProxy::isLan): LanProxy {
        val client = StreamInterceptor.client(plain, headers, token)
        return LanProxy(client, InetAddress.getLoopbackAddress(), allow = allow).also { proxy = it }
    }

    private fun get(url: String, range: String? = null) =
        plain.newCall(Request.Builder().url(url).apply { range?.let { header("Range", it) } }.build()).execute()

    @Test fun masterRewriteMapsEveryUriToThePhone() {
        val base = "https://cdn.example/hls/master.m3u8?token=T"
        val out = LanProxy.rewrite(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/tel.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n",
            base,
        ) { url, playlist -> "P[$playlist]$url" }
        assertEquals(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"P[true]https://cdn.example/hls/audio/tel.m3u8\"\n" +
                "#EXT-X-STREAM-INF:BANDWIDTH=1\nP[true]https://cdn.example/hls/v/index.m3u8\n",
            out,
        )
    }

    @Test fun mediaRewriteMapsSegmentsKeysAndInit() {
        val out = LanProxy.rewrite(
            "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"/k\"\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n",
            "https://cdn.example/hls/v/index.m3u8",
        ) { url, playlist -> "P[$playlist]$url" }
        assertEquals(
            "#EXTM3U\n#EXT-X-MAP:URI=\"P[false]https://cdn.example/hls/v/init.mp4\"\n" +
                "#EXT-X-KEY:METHOD=AES-128,URI=\"P[false]https://cdn.example/k\"\n#EXTINF:4,\nP[false]https://cdn.example/hls/v/seg0.ts\n#EXT-X-ENDLIST\n",
            out,
        )
    }

    @Test fun segmentUrlMappingRoundTrips() {
        val p = start()
        val upstream = "https://cdn.example/a/b/seg%2001.ts?x=1&y=2"
        val lan = p.urlFor(upstream, playlist = false)
        assertTrue(lan, lan.startsWith("http://127.0.0.1:${p.port}/${p.key}/"))
        assertTrue(lan, lan.endsWith("/seg%2001.ts") || lan.endsWith("/seg01.ts"))
        assertEquals(upstream, p.upstreamFor(java.net.URI(lan).rawPath))
        assertTrue(p.urlFor("https://cdn.example/play?id=9", playlist = true).endsWith(".m3u8"))
    }

    /** The loopback check: master, variant and one segment through the proxy from this process. */
    @Test fun loopbackServesRewrittenMasterAndSegmentWithHeadersAndToken() {
        val p = start(token = "TOK")
        val master = get(p.urlFor(up.url("/hls/master.m3u8").toString(), playlist = true))
        assertEquals(200, master.code)
        assertEquals("*", master.header("Access-Control-Allow-Origin"))
        assertTrue(master.header("Content-Type")!!.contains("mpegurl"))
        val text = master.body!!.string()
        assertFalse("upstream host leaked: $text", text.contains("localhost:${up.port}") || text.contains("127.0.0.1:${up.port}"))
        val variantUrl = text.lines().first { it.startsWith("http://") }
        val variant = get(variantUrl).body!!.string()
        val segLines = variant.lines().filter { it.startsWith("http://127.0.0.1:${p.port}/") }
        assertEquals(2, segLines.size)
        assertTrue(variant, variant.contains("URI=\"http://127.0.0.1:${p.port}/${p.key}/"))
        val segRes = get(segLines[0])
        assertEquals(200, segRes.code)
        assertTrue(seg.contentEquals(segRes.body!!.bytes()))

        assertEquals(3, up.requestCount)
        val seen = (1..3).map { up.takeRequest(1, TimeUnit.SECONDS)!! }
        for (r in seen) {
            assertEquals("https://vaplayer.example/", r.getHeader("Referer"))
            assertEquals("https://vaplayer.example", r.getHeader("Origin"))
            assertEquals("ChitramUA", r.getHeader("User-Agent"))
            assertEquals("TOK", r.requestUrl!!.queryParameter("token"))
        }
        assertEquals(listOf("/hls/master.m3u8", "/hls/v/index.m3u8", "/hls/v/seg0.ts"), seen.map { it.requestUrl!!.encodedPath })
    }

    @Test fun masterKeepsItsOwnToken() {
        val p = start(token = "TOK")
        get(p.urlFor(up.url("/hls/master.m3u8?token=OWN").toString(), playlist = true)).close()
        assertEquals("OWN", up.takeRequest(1, TimeUnit.SECONDS)!!.requestUrl!!.queryParameter("token"))
    }

    @Test fun rangeRequestsPassThroughForMp4() {
        val p = start(token = null)
        val res = get(p.urlFor(up.url("/film.mp4").toString(), playlist = false), range = "bytes=100-199")
        assertEquals(206, res.code)
        assertEquals("bytes 100-199/1000", res.header("Content-Range"))
        assertEquals(100, res.body!!.bytes().size)
        val r = up.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("bytes=100-199", r.getHeader("Range"))
        assertNull(r.requestUrl!!.queryParameter("token"))
    }

    @Test fun refusesNonLanPeersAndWrongKey() {
        val p = start(allow = { false })
        assertEquals(403, get(p.urlFor(up.url("/hls/master.m3u8").toString(), playlist = true)).code)
        assertEquals(0, up.requestCount)
        val q = LanProxy(plain, InetAddress.getLoopbackAddress())
        try {
            assertEquals(404, get("http://127.0.0.1:${q.port}/wrongkey/00/x.m3u8").code)
        } finally { q.close() }
    }

    @Test fun lanGuard() {
        assertTrue(LanProxy.isLan(InetAddress.getByName("192.168.1.20")))
        assertTrue(LanProxy.isLan(InetAddress.getByName("10.0.0.5")))
        assertTrue(LanProxy.isLan(InetAddress.getByName("127.0.0.1")))
        assertFalse(LanProxy.isLan(InetAddress.getByName("8.8.8.8")))
        // Carrier-grade NAT is the mobile network, not the home LAN.
        assertFalse(LanProxy.isLan(InetAddress.getByName("100.64.3.4")))
    }

    @Test fun picksTheWifiAddress() {
        val pick = LanProxy.pickAddress(listOf(
            "rmnet_data0" to listOf(InetAddress.getByName("10.40.1.2")),
            "lo" to listOf(InetAddress.getByName("127.0.0.1")),
            "wlan0" to listOf(InetAddress.getByName("fe80::1"), InetAddress.getByName("192.168.1.34")),
        ))
        assertEquals("192.168.1.34", pick?.hostAddress)
        assertNull(LanProxy.pickAddress(listOf("rmnet_data0" to listOf(InetAddress.getByName("10.40.1.2")))))
    }

    @Test fun stopsWhenIdle() {
        val idle = CountDownLatch(1)
        val p = LanProxy(plain, InetAddress.getLoopbackAddress(), idleMs = 150, tickMs = 50, onIdle = { idle.countDown() })
        proxy = p
        assertTrue(idle.await(3, TimeUnit.SECONDS))
        assertTrue(p.closed)
    }

    @Test fun castSpecUsesThePhoneUrlForDeviceRows() {
        val s = Source(
            id = "v", provider = "vaplayer", label = "", url = "https://cdn.example/master.m3u8", progressive = false, quality = "1080p",
            levels = emptyList(), languages = listOf("Telugu"), selectableAudio = false, hybrid = false, subtitles = emptyList(),
            videoCodec = null, codecString = null, unsupported = false, onDevice = "vaplayer", headers = headers, segmentToken = "TOK",
        )
        val spec = WvcCast.spec(s, PlayRequest("movie", 1, "Krack"), lanUrl = "http://192.168.1.34:40000/k/aa/master.m3u8")
        assertEquals("http://192.168.1.34:40000/k/aa/master.m3u8", spec.url)
        // The phone adds the headers; the TV sends none and needs no WVC routing.
        assertTrue(spec.headers.isEmpty())
        assertNull(spec.hint)
        // No LAN address: unchanged direct cast with headers and the hint.
        assertEquals(WvcCast.ROUTE_HINT, WvcCast.spec(s, PlayRequest("movie", 1, "Krack")).hint)
    }
}
