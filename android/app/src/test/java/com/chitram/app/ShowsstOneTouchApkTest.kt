package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.OneTouchTvResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.ShowsstResolver
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * showsst and OneTouchTV resolved on the device (ports of providers/showsst.js and
 * providers/onetouchtv.js). Rows keep the server's fields; neither claims a language.
 */
class ShowsstOneTouchApkTest {
    private val server = MockWebServer()
    private val base = server.url("").toString().trimEnd('/')
    private val codecs = CodecSupport { _, _ -> null }
    private val seen = CopyOnWriteArrayList<RecordedRequest>()

    @After fun stop() = server.shutdown()

    private fun serve(routes: (String) -> MockResponse) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen += request; return routes(request.path!!) }
        }
    }

    private fun od(showsst: ShowsstResolver? = null, onetouch: OneTouchTvResolver? = null, title: Triple<String, Int?, String?>? = null, tmdbIdFor: suspend (String, Int?, Boolean) -> Long? = { _, _, _ -> null }): OnDeviceResolver {
        val kv = MemoryKeyValue()
        val client = OkHttpClient()
        return OnDeviceResolver(null, ResolveConfigStore(client, "$base/config", kv), MappleResolver(client, HostBook(kv), kv),
            VaplayerResolver(client, HostBook(kv)) { null }, titleFor = { _, _ -> title }, imdbFor = { _, _ -> "tt10919420" },
            showsst = showsst, onetouch = onetouch, tmdbIdFor = tmdbIdFor)
    }

    // ---- showsst ------------------------------------------------------------

    private fun showsstBody(qualities: String) =
        """{"hx":{},"meta":{"id":579974},"subtitles":[{"file":"$base/sub/en.vtt","label":"English"}],
           "source":{"source":"moviebox","label":"MovieBox","url":"$base/mp4/auto","qualities":[$qualities]}}"""

    private val mp4Head = MockResponse().setResponseCode(206).setHeader("Content-Type", "video/mp4")
        .setBody(okio.Buffer().write(byteArrayOf(0, 0, 0, 0x20) + "ftypisom".toByteArray() + ByteArray(4)))

    @Test fun showsstRrrGivesEveryMp4QualityAsProgressiveRowsWithNoLanguage() = runBlocking {
        serve { p ->
            when {
                p.startsWith("/movie?id=579974&mode=json") -> MockResponse().setBody(showsstBody(
                    """{"quality":"1080p","codec":"h264","url":"$base/mp4/1080","type":"mp4"},
                       {"quality":"2160p","codec":"hevc","url":"$base/mp4/2160","type":"mp4"},
                       {"quality":"720p","codec":"h264","url":"$base/mp4/720","type":"mp4"}"""))
                p.startsWith("/mp4/") -> mp4Head
                else -> MockResponse().setResponseCode(404)
            }
        }
        val mirror = ShowsstResolver.Mirror(base, "https://player.vidqueen.st")
        val rows = od(showsst = ShowsstResolver(OkHttpClient(), listOf(mirror))).resolveAll(OnDeviceResolver.SHOWSST, "movie", 579974, 0, 0, codecs)
        // HEVC dropped as on the server; one row per remaining quality.
        assertEquals(listOf("$base/mp4/1080", "$base/mp4/720"), rows.map { it.url })
        assertEquals(listOf("1080p", "720p"), rows.map { it.quality })
        assertTrue(rows.all { it.progressive })
        assertTrue(rows.all { it.languages.isEmpty() && it.audioLanguages == null })
        assertEquals(2, rows.map { it.id }.toSet().size)
        assertEquals("showsst", rows[0].provider)
        assertEquals("showsst · MovieBox", rows[0].label)
        assertEquals("showsst", rows[0].onDevice)
        assertEquals(mapOf("User-Agent" to ShowsstResolver.UA, "Referer" to "https://player.vidqueen.st/", "Origin" to "https://player.vidqueen.st"), rows[0].headers)
        assertEquals(listOf("English"), rows[0].subtitles.map { it.lang })
        // The api gate: the player's Origin and Chrome's fetch metadata on the call.
        val api = seen.first { it.path!!.startsWith("/movie") }
        assertEquals("https://player.vidqueen.st", api.getHeader("Origin"))
        assertEquals("cors", api.getHeader("Sec-Fetch-Mode"))
        assertEquals("en-US,en;q=0.9", api.getHeader("Accept-Language"))
    }

    @Test fun showsstTvAsksSeasonAndEpisodeSpelledOut() = runBlocking {
        serve { p -> if (p.startsWith("/tv?")) MockResponse().setBody("""{"source":null}""") else MockResponse().setResponseCode(404) }
        val rows = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror(base, base))).resolveAll("tv", 93405, 2, 3)
        assertTrue(rows.isEmpty())
        assertEquals("/tv?id=93405&season=2&episode=3&mode=json", seen.single().path)
    }

    @Test fun showsstFailsOverToTheNextMirrorOnNon2xxButNotOnANullSource() = runBlocking {
        serve { p ->
            when {
                p.startsWith("/a/") -> MockResponse().setResponseCode(403).setBody("forbidden")
                p.startsWith("/b/movie") -> MockResponse().setBody(showsstBody("""{"quality":"480p","codec":"h264","url":"$base/x.mp4"}"""))
                else -> MockResponse().setResponseCode(404)
            }
        }
        val rows = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror("$base/a", base), ShowsstResolver.Mirror("$base/b", base))).resolveAll("movie", 1, 0, 0)
        assertEquals(listOf("$base/x.mp4"), rows.map { it.resolved.url })
        assertTrue(rows.single().progressive)
    }

    @Test fun showsstHlsSourceStaysHls() = runBlocking {
        serve { p ->
            if (p.startsWith("/movie")) MockResponse().setBody("""{"source":{"label":"VidAPI","url":"$base/hls/master","manifest":"x"}}""")
            else MockResponse().setBody("#EXTM3U\n")
        }
        val rows = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror(base, base))).resolveAll("movie", 1, 0, 0)
        assertFalse(rows.single().progressive)
        assertEquals("Auto", rows.single().quality)
    }

    @Test fun showsstEveryMirrorDownIsAFailureNotEmpty() = runBlocking {
        serve { MockResponse().setResponseCode(503) }
        val od = od(showsst = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror(base, base))))
        // resolveAll never throws: a failure is a missing row and counts on the breaker.
        assertTrue(od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 1, 0, 0, codecs).isEmpty())
        repeat(2) { od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 1, 0, 0, codecs) }
        assertTrue(od.isOpen(OnDeviceResolver.SHOWSST))
    }

    // ---- OneTouchTV ---------------------------------------------------------

    private fun enc(json: String) = MockResponse().setBody(OneTouchTvResolver.encrypt("""{"result":$json}"""))

    private val squidSearch = """[
        {"id":"446345-squid-game-season-3-2025","title":"Squid Game Season 3 (2025)","type":"drama","year":"2025"},
        {"id":"978626-squid-game-2021","title":"Squid Game (2021)","type":"drama","year":"2021"}]"""

    private fun squidRoutes(p: String): MockResponse = when {
        p.startsWith("/vod/search?keyword=Squid%20Game") -> enc(squidSearch)
        p == "/vod/978626-squid-game-2021/detail" -> enc("""{"title":"Squid Game (2021)","episodes":[{"episode":"2","playId":"2"},{"episode":"1","playId":"1"}]}""")
        p == "/vod/978626-squid-game-2021/episode/1" -> enc("""{"sources":[
            {"type":"hls","quality":"auto","name":"loklok","url":"https://akm-cdn-play.hitv.ltd/a/sd.mp4.m3u8?hdnts=exp=4102444800_acl=/a/*"},
            {"type":"hls","quality":"auto","name":"loklok","url":"https://akm-cdn-play.hitv.ltd/a/sd.mp4.m3u8?hdnts=exp=4102444800_acl=/a/*"},
            {"type":"hls","quality":"1080p","name":"myasiantv.es","url":"https://kisscloud.online/cdn/hls/x/master.m3u8?expires=4102444800"}],
            "track":[{"file":"https://aapanel.devcorp.me/en.vtt","name":"English","kind":"captions"},{"file":"","name":"Empty"}]}""")
        else -> MockResponse().setResponseCode(404)
    }

    @Test fun decryptReadsTheRealUpstreamAlphabet() {
        // Recorded 2026-11-21: /vod/search?keyword=RRR, as the api sent it.
        val plain = OneTouchTvResolver.decrypt(Fixtures.read("onetouchtv/rrr-search.enc"))
        assertTrue(plain.contains("\"id\":\"mk-rrr-2022\""))
        assertTrue(plain.contains("\"title\":\"RRR (2022)\""))
        assertEquals("""{"a":"/+?"}""", OneTouchTvResolver.decrypt(OneTouchTvResolver.encrypt("""{"a":"/+?"}""")))
    }

    @Test fun oneTouchSquidGameEpisodeOneGivesDedupedHlsRowsWithNoLanguage() = runBlocking {
        serve(::squidRoutes)
        val rows = od(onetouch = OneTouchTvResolver(OkHttpClient(), base = base), title = Triple("Squid Game", 2021, "오징어 게임"))
            .resolveAll(OnDeviceResolver.ONETOUCH, "tv", 93405, 1, 1, codecs)
        assertEquals(2, rows.size)
        assertEquals(listOf("Auto", "1080p"), rows.map { it.quality })
        assertTrue(rows.none { it.progressive })
        assertTrue(rows.all { it.languages.isEmpty() && it.audioLanguages == null })
        assertEquals("OneTouchTV", rows[0].provider)
        assertEquals("Squid Game (2021)\nAuto · HLS", rows[0].label)
        // No Referer to the stream CDN: hitv.ltd 403s a foreign one.
        assertEquals(mapOf("User-Agent" to "Mozilla/5.0"), rows[0].headers)
        assertEquals(listOf("English"), rows[0].subtitles.map { it.lang })
        assertEquals(2, rows.map { it.id }.toSet().size)
        assertEquals("onetouchtv", OnDeviceResolver.nameFor(rows[0].provider))
    }

    @Test fun oneTouchRejectsAMatchThatIsAnotherTmdbTitle() = runBlocking {
        serve(::squidRoutes)
        val rows = od(onetouch = OneTouchTvResolver(OkHttpClient(), base = base), title = Triple("Squid Game", 2021, null), tmdbIdFor = { _, _, _ -> 1L })
            .resolveAll(OnDeviceResolver.ONETOUCH, "tv", 93405, 1, 1, codecs)
        assertTrue(rows.isEmpty())
        assertTrue(seen.none { it.path!!.contains("/detail") })
    }

    private fun rrrRoutes(search: MockResponse): (String) -> MockResponse = { p ->
        when {
            p.startsWith("/vod/search") -> search
            p.endsWith("/detail") -> enc("""{"episodes":[{"episode":"1","playId":"7"}]}""")
            p.contains("/episode/7") -> enc("""{"sources":[{"type":"hls","quality":"auto","name":"loklok","url":"$base/rrr.m3u8"}]}""")
            else -> MockResponse().setResponseCode(404)
        }
    }

    @Test fun oneTouchRrrWithYearSuffixMatches() = runBlocking {
        // Recorded search lists "RRR (2022)": the trailing year is stripped before the title compare.
        serve(rrrRoutes(MockResponse().setBody(Fixtures.read("onetouchtv/rrr-search.enc"))))
        val verified = CopyOnWriteArrayList<Pair<String, Int?>>()
        val rows = OneTouchTvResolver(OkHttpClient(), base = base).resolveAll("movie", 579974, "RRR", 2022, null, 0, 0) { t, y, _ -> verified += t to y; null }
        assertEquals("$base/rrr.m3u8", rows.single().resolved.url)
        assertTrue(seen.any { it.path == "/vod/mk-rrr-2022/detail" })
        // The TMDB cross-check gets the bare title and the stated year.
        assertEquals(listOf("RRR" to 2022), verified.toList())
    }

    @Test fun oneTouchRrrWithAFarYearOrAWrongShortTitleIsRejected() = runBlocking {
        serve(rrrRoutes(enc("""[{"id":"old","title":"RRR (1999)","type":"movie"},{"id":"rrrr","title":"RRRR (2022)","type":"movie"},{"id":"rx","title":"RX 100 (2022)","type":"movie"}]""")))
        val rows = OneTouchTvResolver(OkHttpClient(), base = base).resolveAll("movie", 579974, "RRR", 2022, null, 0, 0)
        assertTrue(rows.isEmpty())
        assertTrue(seen.none { it.path!!.contains("/detail") })
        assertEquals("RRR" to 2022, OneTouchTvResolver.splitTitleYear("RRR (2022)"))
        assertEquals("RRR" to null, OneTouchTvResolver.splitTitleYear("RRR"))
    }

    @Test fun oneTouchMovieTakesTheFirstEpisodeAndTheYearMustAgree() = runBlocking {
        serve { p ->
            when {
                p.startsWith("/vod/search") -> enc("""[{"id":"old","title":"Parasite","type":"movie","year":"1982"},{"id":"new","title":"Parasite","type":"movie","year":"2019"},{"id":"show","title":"Parasite","type":"drama","year":"2019"}]""")
                p == "/vod/new/detail" -> enc("""{"episodes":[{"episode":"1","playId":"9"}]}""")
                p == "/vod/new/episode/9" -> enc("""{"sources":[{"type":"mp4","quality":"720","url":"$base/f.mp4"}]}""")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val rows = OneTouchTvResolver(OkHttpClient(), base = base).resolveAll("movie", 496243, "Parasite", 2019, null, 0, 0)
        assertEquals("$base/f.mp4", rows.single().resolved.url)
        assertTrue(rows.single().progressive)
        assertEquals("Parasite\n720p · MP4", rows.single().resolved.label)
    }

    @Test fun oneTouchSearch404IsTheNextSpellingNotAFailure() = runBlocking {
        serve { p ->
            when {
                p.startsWith("/vod/search?keyword=B%C4%81hubali") -> MockResponse().setResponseCode(404)
                p.startsWith("/vod/search?keyword=Bahubali") -> enc("""[{"id":"b1","title":"Bahubali: The Beginning","type":"movie","year":"2015"}]""")
                p == "/vod/b1/detail" -> enc("""{"episodes":[{"episode":"1","playId":"1"}]}""")
                p == "/vod/b1/episode/1" -> enc("""{"sources":[{"type":"hls","url":"$base/b.m3u8"}]}""")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val rows = OneTouchTvResolver(OkHttpClient(), base = base).resolveAll("movie", 256040, "Bāhubali: The Beginning", 2015, null, 0, 0)
        assertEquals(listOf("$base/b.m3u8"), rows.map { it.resolved.url })
    }

    @Test fun oneTouchDetail404ServesLastGoodThenRetriesOnceWithout() = runBlocking {
        var detail404 = false
        serve { p -> if (detail404 && p.endsWith("/detail")) MockResponse().setResponseCode(404) else squidRoutes(p) }
        val r = OneTouchTvResolver(OkHttpClient(), base = base, notFoundRetryMs = 1)
        val first = r.resolveAll("tv", 93405, "Squid Game", 2021, null, 1, 1)
        assertEquals(2, first.size)
        detail404 = true
        assertEquals(first.map { it.resolved.url }, r.resolveAll("tv", 93405, "Squid Game", 2021, null, 1, 1).map { it.resolved.url })
        // No last-good for another episode: retried once, then the 404 is a failure.
        val fail = runCatching { r.resolveAll("tv", 93405, "Squid Game", 2021, null, 1, 2) }
        assertTrue(fail.isFailure)
        // 1 good + 1 last-good + 2 (first try and the one retry).
        assertEquals(4, seen.count { it.path!!.endsWith("/detail") && it.path!!.contains("978626") })
    }

    @Test fun oneTouchLaterSeasonUsesCinemetaAbsoluteEpisode() = runBlocking {
        serve { p ->
            when {
                p.startsWith("/vod/search") -> enc("""[{"id":"aot","title":"Attack on Titan","type":"anime","year":"2013"}]""")
                p == "/vod/aot/detail" -> enc("""{"episodes":[{"episode":"27","playId":"27"},{"episode":"2","playId":"2"}]}""")
                p == "/vod/aot/episode/27" -> enc("""{"sources":[{"type":"hls","url":"$base/s2e2.m3u8"}]}""")
                p == "/meta/series/tt2560140.json" -> MockResponse().setBody("""{"meta":{"videos":[{"season":1,"number":25},{"season":1,"number":1},{"season":2,"number":1},{"season":0,"number":5}]}}""")
                else -> MockResponse().setResponseCode(404)
            }
        }
        val rows = OneTouchTvResolver(OkHttpClient(), base = base, cinemeta = base).resolveAll("tv", 1429, "Attack on Titan", 2013, "tt2560140", 2, 2)
        assertEquals(listOf("$base/s2e2.m3u8"), rows.map { it.resolved.url })
    }

    @Test fun onlyWhenTheVmIsDownAndUrlExpiryIsRead() {
        val od = od(showsst = ShowsstResolver(OkHttpClient()), onetouch = OneTouchTvResolver(OkHttpClient()))
        assertFalse(od.names(vmDown = false).contains(OnDeviceResolver.SHOWSST))
        assertFalse(od.names(vmDown = false).contains(OnDeviceResolver.ONETOUCH))
        assertTrue(od.names(vmDown = true).containsAll(listOf(OnDeviceResolver.SHOWSST, OnDeviceResolver.ONETOUCH)))
        assertEquals("showsst", OnDeviceResolver.nameFor("showsst"))
        assertEquals(1795275514000L, com.chitram.app.resolve.OneTouchTvResolver.expiryOf("https://h/a.m3u8?hdnts=exp=1795275514_acl=/x/*"))
        assertEquals(1795279103000L, com.chitram.app.resolve.OneTouchTvResolver.expiryOf("https://h/m.m3u8?md5=x&expires=1795279103"))
        assertNull(com.chitram.app.resolve.OneTouchTvResolver.expiryOf("https://h/m.m3u8"))
    }
}
