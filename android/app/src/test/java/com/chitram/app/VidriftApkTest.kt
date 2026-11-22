package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.player.PlayerVm
import com.chitram.app.resolve.AudioTrack
import com.chitram.app.resolve.Hls
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.Resolved
import com.chitram.app.resolve.StepException
import com.chitram.app.resolve.VaplayerResolver
import com.chitram.app.resolve.VidriftResolver
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * APK Vidrift (server twin providers/vidrift.js), on pages and masters recorded
 * 2026-11-21 (test/fixtures/vidrift, copied to fixtures/vidrift).
 */
class VidriftApkTest {
    private val a = MockWebServer()
    private val b = MockWebServer()
    private val baseA = a.url("").toString().trimEnd('/')
    private val baseB = b.url("").toString().trimEnd('/')
    private val client = OkHttpClient()

    @Before fun reset() = VidriftResolver.resetHeal()
    @After fun stop() { a.shutdown(); b.shutdown() }

    private val rrrPage = Fixtures.read("vidrift/rrr-page.html")
    private val krackPage = Fixtures.read("vidrift/krack-page.html")
    private val telugu = Fixtures.read("vidrift/master-telugu.m3u8")
    private val original = Fixtures.read("vidrift/master-original.m3u8")
    private val noAudio = Fixtures.read("vidrift/master-no-audio.m3u8")

    private val ORIG = "/api/orion/36c0c00732d43d2df373f8c4e10e971b/master.m3u8"
    private val HINDI = "/api/orion/fb969c400dbbad41a01f816e419f992b/master.m3u8"
    private val TEL = "/api/orion/4160f9215437e11c789d19d826048e8b/master.m3u8"
    private val BANGLA = "/api/orion/eb12dbd64fdfc1e245c4fa4d98710c9d/master.m3u8"

    /** Masters answer only with Vidrift's own Referer + Origin, as live (403 otherwise). */
    private fun serve(s: MockWebServer, page: String?, masters: Map<String, String?>, pageDelayMs: Long = 0) {
        val origin = s.url("").toString().trimEnd('/')
        s.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path.startsWith("/embed/")) {
                    if (page == null) return MockResponse().setResponseCode(503)
                    assertEquals(VidriftResolver.PAGE_REFERER, request.getHeader("Referer"))
                    return MockResponse().setBody(page).setBodyDelay(pageDelayMs, TimeUnit.MILLISECONDS)
                }
                if (request.getHeader("Origin") != origin || request.getHeader("Referer") != "$origin/") return MockResponse().setResponseCode(403)
                val body = masters[path] ?: return MockResponse().setResponseCode(404)
                return MockResponse().setBody(body)
            }
        }
    }

    private val rrrMasters get() = mapOf(ORIG to original, HINDI to telugu, TEL to telugu, BANGLA to telugu)
    private fun langs(r: Resolved) = (Hls.languages(r.audio) + r.languages).distinct()
    private fun resolver(pageStep: Long = 5_000) = VidriftResolver(client, listOf(baseA, baseB), pageStepMs = pageStep)

    @Test fun rrrGivesOneRowPerLanguageAndOriginalStaysUnlabelledBesideItsOwnTeluguRow() = runBlocking {
        serve(a, rrrPage, rrrMasters)
        val rows = resolver().resolveAll("movie", 579974, 0, 0, originalLang = "te")
        assertEquals(listOf(emptyList(), listOf("Hindi"), listOf("Telugu"), listOf("Bengali")), rows.map(::langs))
        assertEquals("stable ids from the orion id", listOf("vidrift-36c0c00732d43d2df373f8c4e10e971b", "vidrift-fb969c400dbbad41a01f816e419f992b",
            "vidrift-4160f9215437e11c789d19d826048e8b", "vidrift-eb12dbd64fdfc1e245c4fa4d98710c9d"), rows.map { it.key })
        rows.forEach {
            assertEquals(mapOf("User-Agent" to VidriftResolver.UA, "Referer" to "$baseA/", "Origin" to baseA), it.headers)
            assertEquals("vidrift", it.provider)
            assertEquals(1080, it.levels.first().height)
        }
        assertTrue(rows.first().codecs!!.startsWith("hvc1"))
    }

    // Don't Trouble the Trouble (1261763, TMDB te), live 2026-11-21: Original,
    // Hindi, Tamil, Telugu, Malayalam, Kannada. The Original audio is the Tamil
    // track (owner heard Tamil; byte-identical to the Tamil row), and prod
    // showed two "Telugu" rows. Server twin: test/vidrift.test.js.
    private val dtttPage = Fixtures.read("vidrift/dttt-page.html")
    private val dtttIds = listOf("7986230982bb6809d7a2b9e62553bf96", "bc18259d78c1fcb4243c40352e1e648e", "304cd356b4971579515c76cf4bc11dcc",
        "2fc41d4bd36ca36378d03459dba7791b", "9a1f5fb246528cabe936837425539f81", "b90372f155025bd739851e15d012c67d")

    @Test fun dtttOriginalIsNotTeluguWhenThePageHasItsOwnTeluguRow() = runBlocking {
        serve(a, dtttPage, dtttIds.associate { "/api/orion/$it/master.m3u8" to original })
        val rows = resolver().resolveAll("movie", 1261763, 0, 0, originalLang = "te")
        assertEquals(listOf(emptyList(), listOf("Hindi"), listOf("Tamil"), listOf("Telugu"), listOf("Malayalam"), listOf("Kannada")), rows.map(::langs))
        assertNull(rows[0].audio.single().language)
        assertEquals(1, rows.count { "Telugu" in langs(it) })
    }

    @Test fun teluguClaimWinnerIsTheLastTeluguEntryWhenTwoOrMoreSayTelugu() {
        fun n(vararg l: String) = l.map { "Orion · $it" }
        assertEquals(2, VidriftResolver.teluguClaimWinner(n("Telugu", "Hindi", "Telugu")))
        assertNull(VidriftResolver.teluguClaimWinner(n("Original", "Hindi", "Telugu")))
        assertNull(VidriftResolver.teluguClaimWinner(n("Telugu", "Telugu Sub")))
        assertNull("Telugu only", VidriftResolver.teluguClaimWinner(n("Tamil", "Tamil")))
    }

    @Test fun dtttOriginalIsNotTeluguEvenWhenThePageHasNoTeluguEntry() = runBlocking {
        val page = dtttPage.replace(Regex("""\{"index":3,[^{}]*"name":"Orion · Telugu"[^{}]*"rungs":\[[^\]]*][^{}]*},"""), "")
        assertTrue("fixture edit removed the Telugu entry", "Orion · Telugu" !in page)
        serve(a, page, dtttIds.associate { "/api/orion/$it/master.m3u8" to original })
        val rows = resolver().resolveAll("movie", 1261763, 0, 0, originalLang = "te")
        assertEquals(emptyList<String>(), langs(rows[0]))
    }

    // Live 2026-11-22: Vidrift's RRR page listed ONE entry, "Orion · Original",
    // and it was labelled Telugu from TMDB te. Its audio is byte-identical to
    // MultiMovies' "English" RRR source (speech ID ta/hi; the phone played
    // lang=und). Jailer (TMDB ta): Original is a Malayalam track (ml 1.00).
    @Test fun live1122RrrPageWithOnlyOriginalIsNotTelugu() = runBlocking {
        val page = rrrPage.replace(Regex(""",\{"index":[123],[^{}]*"name":"Orion · (Hindi|Telugu|Bangla)","rungs":\[[^\]]*][^{}]*}"""), "")
        assertTrue("fixture edit left only Original", !Regex("Orion · (Hindi|Telugu|Bangla)").containsMatchIn(page))
        serve(a, page, rrrMasters)
        for (tmdb in listOf("te", "ta")) {
            val rows = resolver().resolveAll("movie", 579974, 0, 0, originalLang = tmdb)
            assertEquals(1, rows.size)
            assertEquals(tmdb, emptyList<String>(), langs(rows[0]))
            assertNull(rows[0].audio.single().language)
        }
        assertEquals(null to "Original", VidriftResolver.pageLanguage("Orion · Original"))
    }

    @Test fun twoEntriesSayTeluguOnlyTheLastKeepsIt() = runBlocking {
        serve(a, rrrPage.replace("\"name\":\"Orion · Original\"", "\"name\":\"Orion · Telugu\""), rrrMasters)
        val rows = resolver().resolveAll("movie", 579974, 0, 0)
        assertEquals(listOf(emptyList(), listOf("Hindi"), listOf("Telugu"), listOf("Bengali")), rows.map(::langs))
        assertEquals("vidrift-4160f9215437e11c789d19d826048e8b", rows.single { "Telugu" in langs(it) }.key)
        // A master LANGUAGE tag is its own evidence and still stands.
        val tagged = original.replace("NAME=\"Audio\"", "NAME=\"Audio\",LANGUAGE=\"tel\"")
        assertTrue(tagged.contains("LANGUAGE=\"tel\""))
        assertEquals(listOf("Telugu"), langs(VidriftResolver.rowFor(VidriftResolver.Entry("Orion · Telugu", ORIG), tagged, "$baseA$ORIG", baseA, dropLabel = true)!!))
    }

    @Test fun originalWithoutTmdbLanguageStaysUnlabelled() = runBlocking {
        serve(a, rrrPage, rrrMasters)
        val rows = resolver().resolveAll("movie", 579974, 0, 0, originalLang = null)
        assertEquals(emptyList<String>(), langs(rows[0]))
        assertNull(rows[0].audio.single().language)
        // An unknown TMDB code is not a language either.
        assertEquals(null to "Original", VidriftResolver.pageLanguage("Orion · Original"))
    }

    @Test fun masterLanguageWinsAndOnlyALoneUntaggedRenditionTakesThePageLabel() {
        val hin = AudioTrack("hin", "Audio", true)
        assertEquals(listOf(hin), VidriftResolver.withPageLanguage(listOf(hin), "Telugu"))
        assertEquals("Telugu", VidriftResolver.withPageLanguage(listOf(AudioTrack("und", "Audio", true)), "Telugu").single().language)
        val two = listOf(AudioTrack(null, "Audio", true), AudioTrack(null, "Audio 2", false))
        assertEquals("several renditions keep what the master states", two, VidriftResolver.withPageLanguage(two, "Telugu"))
        // End to end: LANGUAGE="hin" under "Orion · Telugu".
        val e = VidriftResolver.Entry("Orion · Telugu", TEL)
        val r = VidriftResolver.rowFor(e, telugu.replace("NAME=\"Audio\"", "NAME=\"Audio\",LANGUAGE=\"hin\""), "$baseA$TEL", baseA)!!
        assertEquals(listOf("Hindi"), langs(r))
    }

    @Test fun mutedAudioMasterTakesThePageLanguage() {
        val r = VidriftResolver.rowFor(VidriftResolver.Entry("Orion · Telugu", TEL), noAudio, "$baseA$TEL", baseA)!!
        assertEquals(listOf("Telugu"), langs(r))
    }

    @Test fun subtitledLabelsAreNeverAudioAndBanglaIsBengali() {
        for (l in listOf("Telugu Sub", "Telugu subs", "Hindi Subbed", "English subtitles")) assertNull(l, VidriftResolver.pageLanguage("Orion · $l").first)
        assertEquals("Bengali", VidriftResolver.pageLanguage("Orion · Bangla").first)
        assertEquals("Telugu", VidriftResolver.pageLanguage("Orion · Telugu (HQ)").first)
        assertNull(VidriftResolver.langName("und"))
    }

    @Test fun nullOrionStreamsMovesToTheMirrorAndTheMirrorGoesFirstNextTime() = runBlocking {
        serve(a, krackPage, emptyMap())
        serve(b, rrrPage, rrrMasters)
        val rows = resolver().resolveAll("movie", 579974, 0, 0, originalLang = "te")
        assertEquals(4, rows.size)
        assertTrue(rows.all { it.headers["Origin"] == baseB })
        assertEquals(1, a.requestCount)
        // Healed: the mirror is asked first, the first host not at all.
        resolver().resolveAll("movie", 579974, 0, 0, originalLang = "te")
        assertEquals(1, a.requestCount)
    }

    @Test fun deadMasterIsDroppedOthersSurviveAndAllDeadThrows() = runBlocking {
        serve(a, rrrPage, rrrMasters - BANGLA)
        serve(b, null, emptyMap())
        val rows = resolver().resolveAll("movie", 579974, 0, 0, originalLang = "te")
        assertEquals(3, rows.size)
        serve(a, rrrPage, emptyMap())
        try { resolver().resolveAll("movie", 579974, 0, 0, originalLang = "te"); fail("expected a throw") } catch (e: StepException) {
            assertTrue(e.message!!.contains("every master failed"))
        }
    }

    @Test fun everyHostDeadThrowsAndSlowPageIsCutAtItsStep() = runBlocking {
        serve(a, rrrPage, rrrMasters, pageDelayMs = 3_000)
        serve(b, null, emptyMap())
        val t0 = System.currentTimeMillis()
        try { resolver(pageStep = 300).resolveAll("movie", 579974, 0, 0); fail("expected a throw") } catch (e: StepException) {
            assertTrue(e.message!!, e.message!!.contains("no answer in") && e.message!!.contains("HTTP 503"))
        }
        assertTrue("page step caps the slow host", System.currentTimeMillis() - t0 < 2_000)
    }

    @Test fun tvWithoutEpisodeAsksNothing() = runBlocking {
        serve(a, rrrPage, rrrMasters)
        assertEquals(emptyList<Resolved>(), resolver().resolveAll("tv", 1, 0, 0))
        assertEquals(0, a.requestCount)
        assertEquals("$baseA/embed/tv/1/2/3", VidriftResolver.embedUrl(baseA, 1, true, 2, 3))
    }

    @Test fun registeredAsVmDownOnlyAndJoinsTheVmDownLoop() {
        val kv = MemoryKeyValue()
        val od = OnDeviceResolver(null, ResolveConfigStore(client, "http://127.0.0.1:9/config", kv), MappleResolver(client, HostBook(kv), kv),
            VaplayerResolver(client, HostBook(kv)) { null }, titleFor = { _, _ -> null }, imdbFor = { _, _ -> null }, vidrift = VidriftResolver(client))
        assertTrue(OnDeviceResolver.VIDRIFT in od.names(vmDown = true))
        assertTrue(OnDeviceResolver.VIDRIFT !in od.names(vmDown = false))
        assertEquals(listOf(OnDeviceResolver.VIDRIFT), PlayerVm.vmDownExtras(od.names(vmDown = true), od.names(vmDown = false), od.names(vmDown = false)))
        assertEquals(OnDeviceResolver.VIDRIFT, OnDeviceResolver.nameFor("vidrift"))
    }
}
