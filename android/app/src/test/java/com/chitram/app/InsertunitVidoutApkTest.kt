package com.chitram.app

import com.chitram.app.resolve.Hls
import com.chitram.app.resolve.InsertunitResolver
import com.chitram.app.resolve.Resolved
import com.chitram.app.resolve.StepException
import com.chitram.app.resolve.TaggedHls
import com.chitram.app.resolve.VidoutResolver
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
import org.junit.Assert.fail
import org.junit.Test

/**
 * APK Insertunit + VIDOUT (server twins providers/insertunit.js, providers/vidout.js),
 * on pages and masters recorded 2026-11-24 (signatures redacted). Language comes
 * only from the master's LANGUAGE tags.
 */
class InsertunitVidoutApkTest {
    private val s = MockWebServer()
    private val base = s.url("").toString().trimEnd('/')
    private val client = OkHttpClient()
    @After fun stop() = s.shutdown()

    private val rrrMaster = Fixtures.read("insertunit/rrr-master.m3u8")
    private val pushpaIuMaster = Fixtures.read("insertunit/pushpa2-master.m3u8")
    private val vPushpa = Fixtures.read("vidout/pushpa2-master.txt")
    private val vRrr = Fixtures.read("vidout/rrr-master.txt")
    private fun langs(r: Resolved) = Hls.languages(r.audio).mapNotNull(com.chitram.app.data.Ranking::languageLabel)

    // ---- pure ------------------------------------------------------------

    @Test fun moviePageGivesTheHlsMaster() {
        val m = InsertunitResolver.masterFromPage(Fixtures.read("insertunit/rrr-page.html"), "movie", 0, 0)
        assertTrue(m!!.startsWith("https://") && m.contains("master.m3u8"))
    }

    @Test fun tvPageGivesTheEpisodeMasterAndNullWhenAbsent() {
        val page = Fixtures.read("insertunit/tv-page.html")
        assertTrue(InsertunitResolver.masterFromPage(page, "tv", 1, 1)!!.startsWith("https://"))
        assertNull(InsertunitResolver.masterFromPage(page, "tv", 99, 1))
        assertNull(InsertunitResolver.masterFromPage("<html>no player</html>", "movie", 0, 0))
    }

    @Test fun rrrMasterKeepsOneAudioGroupAndEveryTaggedLanguage() {
        val r = TaggedHls.row(rrrMaster, "https://x.test/master.m3u8", "insertunit", "Insertunit", mapOf("User-Agent" to "ua"))!!
        // audio0 only: the failover group repeats the same 8 renditions.
        assertEquals(8, r.audio.size)
        assertEquals(listOf("ru", "ru", "ru", "ru", "ru", "ru", "te", "hi"), r.audio.map { it.language })
        assertTrue(langs(r).containsAll(listOf("Telugu", "Hindi")))
        // Russian DEFAULT=YES stays as the master says; the player picks by language.
        assertTrue(r.audio.first().isDefault)
        assertEquals(listOf(720, 360), r.levels.map { it.height })
        assertEquals(mapOf("User-Agent" to "ua"), r.headers)
    }

    @Test fun pushpaInsertunitMasterHasNoTelugu() {
        val r = TaggedHls.row(pushpaIuMaster, "https://x.test/master.m3u8", "insertunit", "Insertunit", emptyMap())!!
        assertFalse(langs(r).contains("Telugu"))
    }

    @Test fun untaggedRenditionStaysUnknownNotItsName() {
        val m = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Telugu\",DEFAULT=YES,URI=\"a.m3u8\"\n" +
            "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO=\"a\"\nv.m3u8\n"
        val r = TaggedHls.row(m, "https://x.test/m.m3u8", "vidout", "VIDOUT", emptyMap())!!
        assertEquals(1, r.audio.size)
        assertNull(r.audio[0].language)
        assertEquals(emptyList<String>(), Hls.languages(r.audio))
    }

    @Test fun unknownTagsNeverBecomeTeluguFromANameAndLabelsRemainAvailable() {
        for (tag in listOf("und", "mul", "zxx")) {
            val text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",LANGUAGE=\"$tag\",NAME=\"Telugu\",URI=\"a.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720,AUDIO=\"a\"\nv.m3u8\n"
            val row = TaggedHls.row(text,"https://fixture.test/m.m3u8","insertunit","Insertunit",emptyMap())!!
            assertTrue(row.audioTagsOnly)
            assertEquals("Telugu",row.audio.first().name)
            assertTrue(Hls.languages(row.audio).isEmpty())
        }
    }

    @Test fun audioGroupMatchesHighestVariantRatherThanFirstListedVariant() {
        val text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"lo\",LANGUAGE=\"ru\",NAME=\"Russian\",URI=\"ru.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"hi\",LANGUAGE=\"te\",NAME=\"Original\",URI=\"te.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=640x360,AUDIO=\"lo\"\nlo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1280x720,AUDIO=\"hi\"\nhi.m3u8\n"
        val row=TaggedHls.row(text,"https://fixture.test/m.m3u8","insertunit","Insertunit",emptyMap())!!
        assertEquals(listOf("Telugu"),langs(row))
    }

    @Test fun vidoutPushpaHasFourTaggedLanguagesAndRrrNone() {
        val p = TaggedHls.row(vPushpa, "https://h.test/hls3/x/master.txt", "vidout", "VIDOUT", VidoutResolver.HEADERS)!!
        assertEquals(listOf("Hindi", "Malayalam", "Tamil", "Telugu"), langs(p))
        assertEquals(listOf(1080, 720, 480), p.levels.map { it.height })
        val r = TaggedHls.row(vRrr, "https://h.test/hls3/y/master.txt", "vidout", "VIDOUT", VidoutResolver.HEADERS)!!
        assertTrue(r.audio.isEmpty())
        assertTrue(r.languages.isEmpty())
    }

    @Test fun vidoutUsesOnlyDirectMasters() {
        assertEquals("https://h.test/a/master.txt", VidoutResolver.usableLink(" https://h.test/a/master.txt\n"))
        assertNull(VidoutResolver.usableLink("https://h.test/#player"))
        assertNull(VidoutResolver.usableLink("https://h.test/e/abc123"))
        assertNull(VidoutResolver.usableLink("not a url"))
    }

    // ---- network (MockWebServer) ----------------------------------------

    private fun serveInsertunit(pageCode: Int = 200, master: String = rrrMaster) {
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.getHeader("User-Agent") != InsertunitResolver.UA) return MockResponse().setResponseCode(410)
                val p = request.path!!
                return when {
                    p == "/embed/imdb/tt8178634" -> if (pageCode != 200) MockResponse().setResponseCode(pageCode)
                        else MockResponse().setBody("<script>new Playerjs({hls: \"$base/hls/master.m3u8?sig=x\", poster: \"\"})</script>")
                    p.startsWith("/hls/master.m3u8") -> MockResponse().setBody(master)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @Test fun insertunitResolvesOneTeluguRowWithThePageUserAgent() = runBlocking {
        serveInsertunit()
        val rows = InsertunitResolver(client, origin = base).resolveAll("movie", 579974, "tt8178634", 0, 0)
        assertEquals(1, rows.size)
        assertTrue(langs(rows[0]).contains("Telugu"))
        assertEquals(mapOf("User-Agent" to InsertunitResolver.UA), rows[0].headers)
        assertEquals("insertunit", rows[0].provider)
    }

    @Test fun insertunitNotFoundIsNoRowsAndServerErrorThrows() = runBlocking {
        serveInsertunit(pageCode = 404)
        assertEquals(0, InsertunitResolver(client, origin = base).resolveAll("movie", 1, "tt8178634", 0, 0).size)
        serveInsertunit(pageCode = 503)
        try { InsertunitResolver(client, origin = base).resolveAll("movie", 1, "tt8178634", 0, 0); fail("no throw") } catch (_: StepException) {}
    }

    @Test fun insertunitNeverGuessesAnEpisodeOrAnImdbId() = runBlocking {
        serveInsertunit()
        assertEquals(0, InsertunitResolver(client, origin = base).resolveAll("tv", 1, "tt8178634", 0, 0).size)
        assertEquals(0, InsertunitResolver(client, origin = base).resolveAll("movie", 1, null, 0, 0).size)
        assertEquals(0, s.requestCount)
    }

    private fun serveVidout(catalogue: Map<String, String>) {
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val p = request.path!!
                catalogue[p]?.let { return MockResponse().setBody(it) }
                if (p.startsWith("/hls3/")) {
                    if (request.getHeader("Referer") != "https://vidout.pages.dev/") return MockResponse().setResponseCode(404)
                    return MockResponse().setBody(if (p.contains("pushpa")) vPushpa else vRrr)
                }
                return MockResponse().setResponseCode(404)
            }
        }
    }

    @Test fun vidoutMovieGivesOneTaggedRowWithTheReferer() = runBlocking {
        serveVidout(mapOf("/hls/movie/857598" to "$base/hls3/pushpa/master.txt\n"))
        val rows = VidoutResolver(client, catalogue = "$base/hls").resolveAll("movie", 857598, 0, 0)
        assertEquals(1, rows.size)
        assertTrue(langs(rows[0]).contains("Telugu"))
        assertEquals("https://vidout.pages.dev/", rows[0].headers["Referer"])
    }

    @Test fun vidoutTvReadsTheSeasonMapAndMissingTitleIsNoRows() = runBlocking {
        serveVidout(mapOf("/hls/tv/1/S1.json" to "{\"1\":\"$base/hls3/rrr/master.txt\",\"2\":\"https://x.test/#iframe\"}"))
        val v = VidoutResolver(client, catalogue = "$base/hls")
        assertEquals(1, v.resolveAll("tv", 1, 1, 1).size)
        assertEquals(0, v.resolveAll("tv", 1, 1, 2).size)
        assertEquals(0, v.resolveAll("movie", 404404, 0, 0).size)
        assertEquals(0, v.resolveAll("tv", 1, 0, 0).size)
    }

    @Test fun onDeviceOkLineCarriesRowsAndLanguages() {
        val r = TaggedHls.row(rrrMaster, "https://x.test/master.m3u8", "insertunit", "Insertunit", emptyMap())!!
        val src = com.chitram.app.data.Source("d", "insertunit", "Insertunit", r.url, false, "720p", emptyList(), langs(r).distinct(), true, false, emptyList(), null, null, false,
            audioLanguages = langs(r).distinct())
        val line = com.chitram.app.resolve.OnDeviceResolver.rowsSuffix(listOf(src))
        assertTrue(line, line.startsWith(" rows=1 langs=[") && line.contains("Telugu"))
        assertEquals("", com.chitram.app.resolve.OnDeviceResolver.rowsSuffix(null))
        assertEquals("insertunit", com.chitram.app.resolve.OnDeviceResolver.nameFor("Insertunit"))
        assertEquals("vidout", com.chitram.app.resolve.OnDeviceResolver.nameFor("vidout"))
    }
}
