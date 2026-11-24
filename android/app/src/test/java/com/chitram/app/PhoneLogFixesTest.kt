package com.chitram.app

import com.chitram.app.player.PlayPolicy
import com.chitram.app.resolve.MasterPlaylist
import com.chitram.app.resolve.PlaylistCache
import com.chitram.app.resolve.PlaylistInterceptor
import com.chitram.app.resolve.StartCap
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 1.2.56 phone log fixes (phone 1.2.54, 2026-11-24, movie/372399).
 *
 * 1. Every MultiMovies (img.rousav.tech) master lists a 1080p 5 Mbps "tiles.m3u8"
 *    first. media3 loads its first chunk from the first variant, then the start cap
 *    picks 720p and cancels it: `load-cancel media/muxed 1790ms 261660B .../tiles/00000.png`.
 * 2. The frozen watchdog re-prepared a post-seek rebuffer at 12 s
 *    (`recover: frozen 12009ms at 542392ms`) with no look at the growing buffer.
 */
class PhoneLogFixesTest {
    // img.rousav.tech/media/0d193b3ee52e34a8e1dd/index.m3u8, fetched 2026-11-24.
    private val rousav = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English  [CC]",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en-in.[CC]",URI="subtitles_englishcc.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,SUBTITLES="subs",CLOSED-CAPTIONS=NONE
        tiles.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2000000,DEFAULT=YES,RESOLUTION=1280x720,SUBTITLES="subs",CLOSED-CAPTIONS=NONE
        video_720p.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,SUBTITLES="subs",CLOSED-CAPTIONS=NONE
        video_480p.m3u8
    """.trimIndent() + "\n"

    @Test fun theStartVariantIsListedFirstAndNothingIsLost() {
        val out = MasterPlaylist.startFirst(rousav, StartCap.START_BPS)
        assertEquals("video_720p.m3u8", MasterPlaylist.variants(out).first().uri)
        // Same variants, same attributes, same media lines: only the order moved.
        assertEquals(MasterPlaylist.variants(rousav).toSet(), MasterPlaylist.variants(out).toSet())
        assertEquals(rousav.lines().filter { it.isNotBlank() }.sorted(), out.lines().filter { it.isNotBlank() }.sorted())
        assertTrue(out.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") < out.indexOf("#EXT-X-STREAM-INF"))
        // Already first, or no master: unchanged (the same object).
        assertTrue(MasterPlaylist.startFirst(out, StartCap.START_BPS) === out)
        val media = "#EXTM3U\n#EXTINF:6,\nseg0.ts\n#EXT-X-ENDLIST\n"
        assertTrue(MasterPlaylist.startFirst(media, StartCap.START_BPS) === media)
    }

    private val server = MockWebServer()
    private val perPath = ConcurrentHashMap<String, AtomicInteger>()

    @After fun stop() = server.shutdown()

    @Test fun thePlayerGetsTheStartVariantFirstAndThe1080pIsNotFetchedAhead() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val p = request.requestUrl!!.encodedPath
                perPath.getOrPut(p) { AtomicInteger() }.incrementAndGet()
                val type = "application/vnd.apple.mpegurl"
                return when (p) {
                    "/index.m3u8" -> MockResponse().setBody(rousav).setHeader("Content-Type", type)
                    "/tiles.m3u8", "/video_720p.m3u8", "/video_480p.m3u8" -> MockResponse()
                        .setBody("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n0.png\n#EXT-X-ENDLIST\n").setHeader("Content-Type", type)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        val cache = PlaylistCache()
        val c = PlaylistInterceptor.attach(OkHttpClient(), cache) { listOf("te") }
        fun get(path: String) = c.newCall(Request.Builder().url(server.url(path)).build()).execute().use { it.body!!.string() }
        val served = get("/index.m3u8")
        assertEquals("video_720p.m3u8", MasterPlaylist.variants(served).first().uri)
        get("/video_720p.m3u8")
        Thread.sleep(300)
        assertEquals(1, perPath["/video_720p.m3u8"]?.get() ?: 0)
        assertEquals("the 1080p is not fetched ahead", 0, perPath["/tiles.m3u8"]?.get() ?: 0)
        // A second Play: the kept master is the reordered one, 0 requests.
        assertEquals(served, get("/index.m3u8"))
        assertEquals(1, perPath["/index.m3u8"]!!.get())
    }

    @Test fun aRebufferWhoseBufferStillGrowsIsNotFrozen() {
        // Position stuck at 542392 ms while the buffer grows: loading, not frozen.
        assertTrue(PlayPolicy.frozenProgress(pos = 542_392, lastPos = 542_392, buffering = true, buffered = 545_000, lastBuffered = 542_392))
        // Buffer not growing: frozen, as before.
        assertFalse(PlayPolicy.frozenProgress(pos = 542_392, lastPos = 542_392, buffering = true, buffered = 542_392, lastBuffered = 542_392))
        // READY with a 0-fps decoder: the buffer may be full and still "grow"; only the position counts.
        assertFalse(PlayPolicy.frozenProgress(pos = 542_392, lastPos = 542_392, buffering = false, buffered = 600_000, lastBuffered = 590_000))
        assertTrue(PlayPolicy.frozenProgress(pos = 543_000, lastPos = 542_392, buffering = false, buffered = 0, lastBuffered = 0))
    }
}
