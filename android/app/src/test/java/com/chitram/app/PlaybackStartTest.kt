package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Player
import com.chitram.app.player.LoadTrace
import com.chitram.app.player.MasterCodecs
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.chitram.app.data.Api
import kotlinx.coroutines.runBlocking
import java.util.concurrent.TimeUnit

/** apk-playback.md: castle-demux chunkless start (MasterCodecs) and the before-first-frame trace (LoadTrace). */
class PlaybackStartTest {
    private val master = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="castle-audio",NAME="Hindi",LANGUAGE="hin",DEFAULT=NO,AUTOSELECT=YES,URI="https://h/castle-demux/97788546550d40d1c574882c/audio-0.m3u8"
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="castle-audio",NAME="Telugu",LANGUAGE="tel",DEFAULT=YES,AUTOSELECT=YES,URI="https://h/castle-demux/97788546550d40d1c574882c/audio-4.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.640032",AUDIO="castle-audio"
        https://h/castle-demux/97788546550d40d1c574882c/video.m3u8
    """.trimIndent() + "\n"

    @Test fun fillAddsAacOnlyToTheVariantAndKeepsEveryRendition() {
        val out = MasterCodecs.fill(master)
        assertTrue(out.contains("CODECS=\"avc1.640032,mp4a.40.2\",AUDIO=\"castle-audio\""))
        // Renditions, languages and names are byte-identical (non-negotiable 1).
        assertEquals(master.lines().filter { it.startsWith("#EXT-X-MEDIA") }, out.lines().filter { it.startsWith("#EXT-X-MEDIA") })
        assertEquals(master.lines().size, out.lines().size)
    }

    @Test fun fillLeavesKnownAudioCodecsAndGrouplessVariantsAlone() {
        val withAudio = "#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"a\"\nv.m3u8\n"
        assertEquals(withAudio, MasterCodecs.fill(withAudio))
        val ec3 = "#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f,ec-3\",AUDIO=\"a\"\nv.m3u8\n"
        assertEquals(ec3, MasterCodecs.fill(ec3))
        val noGroup = "#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.64001f\"\nv.m3u8\n"
        assertEquals(noGroup, MasterCodecs.fill(noGroup))
    }

    @Test fun appliesOnlyToCastleDemuxMasters() {
        assertTrue(MasterCodecs.applies("/castle-demux/97788546550d40d1c574882c/master.m3u8"))
        assertFalse(MasterCodecs.applies("/castle-demux/97788546550d40d1c574882c/video.m3u8"))
        assertFalse(MasterCodecs.applies("/castle-demux/97788546550d40d1c574882c/audio-4.m3u8"))
        assertFalse(MasterCodecs.applies("/m3u8-proxy"))
        assertFalse(MasterCodecs.applies("/api/orion/abc/master.m3u8"))
    }

    @Test fun interceptorRewritesTheCastleMasterBodyOverHttp() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(master).setHeader("Content-Type", "application/vnd.apple.mpegurl"))
            server.enqueue(MockResponse().setBody(master))
            server.start()
            val c = OkHttpClient.Builder().addInterceptor(MasterCodecs).build()
            val fixed = c.newCall(Request.Builder().url(server.url("/castle-demux/97788546550d40d1c574882c/master.m3u8")).build()).execute().use { it.body!!.string() }
            assertTrue(fixed.contains("avc1.640032,mp4a.40.2"))
            val other = c.newCall(Request.Builder().url(server.url("/hybrid/abc/master.m3u8")).build()).execute().use { it.body!!.string() }
            assertEquals(master, other)
        }
    }

    @Test fun traceLinesNameTheLoad() {
        assertEquals("play: trace +473ms load-start media/audio lang=te h/x/seg/a4/566.ts",
            LoadTrace.line("load-start", 473, LoadTrace.load(C.DATA_TYPE_MEDIA, C.TRACK_TYPE_AUDIO, "te", -1, -1, "https://h/x/seg/a4/566.ts?t=1")))
        assertEquals("manifest/t-1 237ms 1203B h/m.m3u8", LoadTrace.load(C.DATA_TYPE_MANIFEST, C.TRACK_TYPE_UNKNOWN, null, 237, 1203, "https://h/m.m3u8"))
        assertEquals("READY", LoadTrace.state(Player.STATE_READY))
    }

    // ---- no VM prefetch (owner 2026-11-22: prewarm is on-device only) ------------

    private val body = """{"streams":[{"id":"t","provider":"vidrift","name":"Vidrift · Telugu","url":"https://x/t.m3u8","languages":["Telugu"]}]}"""

    @Test fun playCallsTheVmOnceAndNothingElseCallsItEarly() = runBlocking {
        MockWebServer().use { server ->
            repeat(2) { server.enqueue(MockResponse().setBody(body)) }
            server.start()
            val a = Api(OkHttpClient(), vmBase = server.url("").toString().trimEnd('/'), streamsHedgeMs = 0, streamsCallTimeoutMs = 10_000)
            assertTrue("no VM prefetch entry point", Api::class.java.declaredMethods.none { it.name.contains("prefetch", true) })
            assertEquals(listOf("Telugu"), a.streams("movie", 579974).streams.single().languages)
            assertEquals(1, server.requestCount)
            assertEquals("/api/streams/movie/579974", server.takeRequest().path)
        }
    }
}
