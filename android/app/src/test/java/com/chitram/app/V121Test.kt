package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.PlaybackReport
import com.chitram.app.data.Ranking
import com.chitram.app.data.RawStream
import com.chitram.app.data.Source
import com.chitram.app.data.StreamsResponse
import com.chitram.app.player.FailPolicy
import com.chitram.app.player.OpenSubs
import com.chitram.app.player.PlayPolicy
import com.chitram.app.player.PlayRequest
import com.chitram.app.player.WvcCast
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/** 1.2.1: APK behaves like the website (parity audit U1-U8) plus the WVC mime fix. */
class V121Test {
    private val all = CodecSupport { _, _ -> true }

    private fun raw(p: String, q: String, langs: List<String> = emptyList(), sel: Boolean = false, container: String = "hls") =
        RawStream(url = "https://h/$p-$q", provider = p, quality = q, languages = langs, selectableAudio = sel, container = container)

    private fun ranked(vararg r: RawStream) = Ranking.fromResponse(StreamsResponse(streams = r.toList()), "Telugu", all)

    // ---- WVC: Android matches MIME types case-sensitively ---------------------

    @Test fun wvcHlsMimeIsLowercase() {
        val s = Source(
            id = "a", provider = "castle", label = "", url = "https://vm/m3u8-proxy?url=x.m3u8", progressive = false, quality = "1080p",
            levels = emptyList(), languages = listOf("Telugu"), selectableAudio = false, hybrid = false, subtitles = emptyList(),
            videoCodec = null, codecString = null, unsupported = false,
        )
        val mime = WvcCast.spec(s, PlayRequest("movie", 1, "X")).mime
        assertEquals("application/x-mpegurl", mime)
        assertEquals(mime.lowercase(), mime)
    }

    // ---- U1: subtitles from the OpenSubtitles Stremio addon ------------------

    private val subsJson = """{"subtitles":[
      {"id":"1","url":"https://subs5.strem.io/f/1","lang":"spa","subtitleFileName":"RRR.2022.srt"},
      {"id":"2","url":"https://subs5.strem.io/f/2","lang":"eng","subtitleFileName":"RRR.2022.1080p.WEB-DL.srt","fpsMilli":25000},
      {"id":"3","url":"https://subs5.strem.io/f/3","lang":"eng","subtitleFileName":"RRR.2022.1080p.BluRay.srt","fpsMilli":23976},
      {"id":"4","url":"https://subs5.strem.io/f/4","lang":"tel","subtitleFileName":"Komuram Bheemudo Song (Telugu).srt"},
      {"id":"5","url":"https://subs5.strem.io/f/5","lang":"tel","subtitleFileName":"RRR.2022.Telugu.WEBRip.srt"},
      {"id":"6","url":"https://subs5.strem.io/f/6","lang":"eng","subtitleFileName":"RRR.2022.CAM.srt"},
      {"id":"7","url":"","lang":"eng"}
    ]}"""

    @Test fun subtitlesTeluguThenEnglish() {
        val t = OpenSubs.pick(subsJson, runtimeMin = 187)
        assertEquals(listOf("te", "en", "en"), t.map { it.lang })
        assertEquals("https://subs5.strem.io/f/5", t[0].url) // the song file is not the film
        assertEquals("Telugu (WEB-DL)", t[0].label)
        assertEquals("https://subs5.strem.io/f/3", t[1].url) // 24fps Blu-ray beats the 25fps cut
        assertEquals("English (Blu-ray)", t[1].label)
        assertEquals("English (WEB-DL)", t[2].label)
    }

    @Test fun subtitlesPathAndBadInput() {
        assertEquals("/subtitles/movie/tt8178634.json", OpenSubs.path("tt8178634", 0, 0))
        assertEquals("/subtitles/series/tt1234567:2:5.json", OpenSubs.path("tt1234567", 2, 5))
        assertNull(OpenSubs.path(null, 0, 0))
        assertNull(OpenSubs.path("12345", 0, 0))
        assertTrue(OpenSubs.pick("not json", null).isEmpty())
    }

    @Test fun subtitlesFetchFallsBackSilently() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(subsJson))
        server.enqueue(MockResponse().setResponseCode(503))
        server.start()
        val client = OkHttpClient()
        val base = server.url("").toString().trimEnd('/')
        assertEquals(3, OpenSubs.fetch(client, "tt8178634", 0, 0, 187, base).size)
        assertTrue(OpenSubs.fetch(client, "tt8178634", 0, 0, 187, base).isEmpty())
        assertEquals("/subtitles/movie/tt8178634.json", server.takeRequest().path)
        server.shutdown()
        // Nothing listening: empty list, no exception.
        assertTrue(OpenSubs.fetch(client, "tt8178634", 0, 0, 187, base).isEmpty())
    }

    // ---- U2: within a tier the server's learned order stands ------------------

    @Test fun withinTierKeepsServerOrder() {
        val out = ranked(raw("A", "480p", listOf("Telugu")), raw("B", "1080p", listOf("Telugu")), raw("C", "2160p", listOf("Hindi")))
        assertEquals(listOf("A", "B", "C"), out.map { it.provider })
    }

    // ---- U3: server menu by height, labels numbered across the menu -----------

    @Test fun serverMenuByHeightNumberedOnce() {
        val s = ranked(
            raw("Castle", "480p", listOf("Telugu")), raw("Net", "720p", listOf("Telugu")),
            raw("Castle", "1080p", listOf("Hindi")), raw("Mp4", "2160p", listOf("Telugu"), container = "mp4"),
        )
        val menu = Ranking.menuOrder(s)
        assertEquals(listOf("Castle-1080p", "Net-720p", "Castle-480p", "Mp4-2160p"), menu.map { "${it.provider}-${it.quality}" })
        assertEquals(listOf("Castle 1", "Net", "Castle 2", "Mp4"), Ranking.labels(menu))
    }

    // ---- U4: playback report, fire-and-forget ---------------------------------

    @Test fun playbackReportPostsWebPayload() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        server.start()
        val api = Api(OkHttpClient(), server.url("").toString().trimEnd('/'))
        api.reportPlayback(PlaybackReport(type = "tv", tmdbId = 42, season = 1, episode = 2, provider = "Castle", ok = false,
            reason = "switch: no life", startupMs = 0, waitMs = 9000, mediaUrl = "https://vm/x.m3u8", audioLang = "Telugu", device = "mobile"))
        val req = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", req.method)
        assertEquals("/api/playback-report", req.path)
        val body = Json.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("42", body["tmdbId"]!!.jsonPrimitive.content)
        assertEquals("tv", body["type"]!!.jsonPrimitive.content)
        assertEquals("Castle", body["provider"]!!.jsonPrimitive.content)
        assertEquals("false", body["ok"]!!.jsonPrimitive.content)
        assertEquals("false", body["playedOk"]!!.jsonPrimitive.content)
        assertEquals("switch: no life", body["reason"]!!.jsonPrimitive.content)
        assertEquals("https://vm/x.m3u8", body["mediaUrl"]!!.jsonPrimitive.content)
        assertEquals("Telugu", body["audioLang"]!!.jsonPrimitive.content)
        assertNotNull(body["stallCount"])
        server.shutdown()
    }

    @Test fun playbackReportNeverBlocksWhenVmDown() {
        val server = MockWebServer(); server.start(); val base = server.url("").toString().trimEnd('/'); server.shutdown()
        val api = Api(OkHttpClient(), base)
        val t0 = System.nanoTime()
        api.reportPlayback(PlaybackReport(type = "movie", tmdbId = 1, provider = "x", ok = true))
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 200)
    }

    // ---- U5: runtime check ----------------------------------------------------

    @Test fun runtimeVerdict() {
        assertEquals(PlayPolicy.Runtime.UNKNOWN, PlayPolicy.runtimeVerdict(null, 7_200_000))
        assertEquals(PlayPolicy.Runtime.UNKNOWN, PlayPolicy.runtimeVerdict(120, 0))
        assertEquals(PlayPolicy.Runtime.MISMATCH, PlayPolicy.runtimeVerdict(120, 10 * 60_000L))
        assertEquals(PlayPolicy.Runtime.MISMATCH, PlayPolicy.runtimeVerdict(100, 81 * 60_000L))
        assertEquals(PlayPolicy.Runtime.OK, PlayPolicy.runtimeVerdict(100, 82 * 60_000L))
    }

    // ---- U6: dead-source verdict ----------------------------------------------

    @Test fun switchVerdict() {
        assertEquals(8_000L, PlayPolicy.SWITCH_NO_LIFE_MS)
        assertEquals(20_000L, PlayPolicy.SWITCH_HARD_MS)
        assertEquals(PlayPolicy.Switch.LANDED, PlayPolicy.switchVerdict(500, alive = true, frames = true))
        assertEquals(PlayPolicy.Switch.WAIT, PlayPolicy.switchVerdict(7_999, alive = false, frames = false))
        assertEquals(PlayPolicy.Switch.DEAD, PlayPolicy.switchVerdict(8_000, alive = false, frames = false))
        assertEquals(PlayPolicy.Switch.WAIT, PlayPolicy.switchVerdict(19_999, alive = true, frames = false))
        assertEquals(PlayPolicy.Switch.DEAD, PlayPolicy.switchVerdict(20_000, alive = true, frames = false))
    }

    // ---- U7: auto-advance keeps the playing language --------------------------

    @Test fun advanceKeepsLanguageThenHeight() {
        val s = ranked(
            raw("H1", "1080p", listOf("Hindi")), raw("T1", "480p", listOf("Telugu")),
            raw("T2", "720p", listOf("Telugu")), raw("T3", "1080p", listOf("Telugu")),
        )
        val dead = setOf(s.first { it.provider == "T1" }.id)
        // Telugu at 720p was playing: nearest Telugu height wins, never Hindi.
        assertEquals("T2", PlayPolicy.nextAlive(s, dead, "Telugu", 720)?.provider)
        assertEquals("T3", PlayPolicy.nextAlive(s, dead + s.first { it.provider == "T2" }.id, "Telugu", 720)?.provider)
        // No language known: list order.
        assertEquals("T2", PlayPolicy.nextAlive(s, dead, null, null)?.provider)
        // Every Telugu row dead: falls back to the rest rather than nothing.
        assertEquals("H1", PlayPolicy.nextAlive(s, s.filter { "Telugu" in it.languages }.map { it.id }.toSet(), "Telugu", 720)?.provider)
        assertNull(PlayPolicy.nextAlive(s, s.map { it.id }.toSet(), "Telugu", null))
    }

    // ---- U8: offline waits, does not fail over ---------------------------------

    @Test fun offlineErrorWaitsForNetwork() {
        assertEquals(FailPolicy.Action.WAIT_ONLINE, FailPolicy.onError(null, null, refreshedOnce = false, offline = true))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(null, null, refreshedOnce = false, offline = false))
        // 1.1.9 on-device re-resolve stays.
        val dev = ranked(raw("A", "720p")).first().copy(onDevice = "mapple")
        assertEquals(FailPolicy.Action.RERESOLVE, FailPolicy.onError(dev, null, false))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(dev, null, false, deviceRetried = true))
    }
}
