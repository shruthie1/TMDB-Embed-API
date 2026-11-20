package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Ranking
import com.chitram.app.data.VmHealth
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.TitleMatch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * 1.2.4: A9 (follow a partial /api/streams with one ?full=1 call, merge, re-rank)
 * and the looser Castle title match (TMDB "Mirayi", Castle "Mirai").
 */
class V124Test {
    private val noCodecs = CodecSupport { _, _ -> null }

    private fun row(provider: String, url: String, langs: List<String> = emptyList()) =
        """{"provider":"$provider","title":"$provider","url":"$url","container":"hls","languages":[${langs.joinToString(",") { "\"$it\"" }}]}"""

    // Shape of the VM body for 1222479 (scratchpad/vmrows/raw): partial has only the ready rows.
    private val partial = """{"success":true,"partial":true,"providerErrors":["mapple","vaplayer"],"streams":[
        ${row("CastleTV", "https://v/castle-hin.m3u8", listOf("Hindi"))},
        ${row("vidrock", "https://v/vidrock.m3u8")}]}"""
    private val full = """{"success":true,"providerErrors":["mapple","vaplayer"],"streams":[
        ${row("CastleTV", "https://v/castle-hin.m3u8", listOf("Hindi"))},
        ${row("CastleTV", "https://v/castle-tel.m3u8", listOf("Telugu"))},
        ${row("vidrock", "https://v/vidrock.m3u8")},
        ${row("showsst", "https://v/showsst.m3u8")},
        ${row("multimovies", "https://v/mm.m3u8", listOf("Telugu", "Hindi"))}]}"""

    private fun api(server: MockWebServer, vm: VmHealth? = null, fullTimeoutMs: Long = Api.STREAMS_FULL_TIMEOUT_MS) =
        Api(OkHttpClient(), base = "http://vercel.invalid", vmBase = server.url("").toString().trimEnd('/'), vm = vm, streamsFullTimeoutMs = fullTimeoutMs)

    // ---- A9: two-phase /api/streams -----------------------------------------------

    @Test fun partialThenFullEndsWithEveryRowTeluguFirst() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(partial))
        server.enqueue(MockResponse().setBody(full))
        server.start()
        val a = api(server)
        val first = a.streams("movie", 1222479)
        assertTrue(first.wantsFull)
        val shown = Ranking.fromResponse(first, "Telugu", noCodecs)
        assertEquals(2, shown.size)
        val more = a.streamsFull("movie", 1222479)
        assertNotNull(more)
        assertEquals("/api/streams/movie/1222479", server.takeRequest().path)
        assertEquals("/api/streams/movie/1222479?full=1", server.takeRequest().path)
        val list = Ranking.mergeMore(shown, more!!, "Telugu", noCodecs)
        assertEquals("every row once (dedupe by provider+url)", 5, list.size)
        assertEquals("ids stay unique", 5, list.map { it.id }.toSet().size)
        assertEquals(listOf("Telugu"), list.first().languages)
        assertEquals("https://v/castle-tel.m3u8", list.first().url)
        assertTrue("Telugu rows lead", list.take(2).all { s -> s.languages.contains("Telugu") })
        // The rows already on screen keep their ids: a source that started is not replaced.
        val hin = shown.first { it.url.endsWith("castle-hin.m3u8") }
        assertTrue(list.any { it === hin })
        server.shutdown()
    }

    @Test fun completeAnswerAsksNothingMore() {
        val r = Api.json.decodeFromString(com.chitram.app.data.StreamsResponse.serializer(), """{"success":true,"streams":[]}""")
        assertFalse(r.wantsFull)
        val e = Api.json.decodeFromString(com.chitram.app.data.StreamsResponse.serializer(), """{"providerErrors":["mapple"],"streams":[]}""")
        assertTrue("a provider that threw is asked again", e.wantsFull)
    }

    @Test fun fullKeepsSeasonAndEpisode() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(full))
        server.start()
        api(server).streamsFull("tv", 7, 2, 3)
        assertEquals("/api/streams/series/7?season=2&episode=3&full=1", server.takeRequest().path)
        server.shutdown()
    }

    @Test fun fullTimeoutGivesNullAndLeavesTheBreakerAlone() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(full).setHeadersDelay(5, TimeUnit.SECONDS))
        server.start()
        val vm = VmHealth(MemoryKeyValue())
        val t0 = System.currentTimeMillis()
        assertNull(api(server, vm, fullTimeoutMs = 300).streamsFull("movie", 1))
        assertTrue("cut at its own timeout", System.currentTimeMillis() - t0 < 3_000)
        assertTrue("an optional follow-up never pauses the VM", vm.allow())
        server.shutdown()
    }

    @Test fun vmDownFollowUpGivesNull() = runBlocking {
        val server = MockWebServer()
        server.start()
        val a = api(server)
        server.shutdown() // refused
        assertNull(a.streamsFull("movie", 1))
        val s2 = MockWebServer()
        s2.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        s2.start()
        assertNull(api(s2).streamsFull("movie", 1))
        s2.shutdown()
    }

    @Test fun openBreakerSkipsTheFollowUp() = runBlocking {
        val server = MockWebServer()
        server.start()
        val vm = VmHealth(MemoryKeyValue())
        repeat(2) { vm.onFailure() }
        assertNull(api(server, vm).streamsFull("movie", 1))
        assertEquals(0, server.requestCount)
        server.shutdown()
    }

    @Test fun fullWithNothingNewKeepsTheList() {
        val first = Api.json.decodeFromString(com.chitram.app.data.StreamsResponse.serializer(), partial)
        val shown = Ranking.fromResponse(first, "Telugu", noCodecs)
        assertEquals(shown, Ranking.mergeMore(shown, first, "Telugu", noCodecs))
    }

    // ---- Castle title match fallback ----------------------------------------------

    private data class R(val title: String, val year: Int? = null)

    @Test fun mirayiFindsCastleMirai() {
        val rows = listOf(R("Mirchi", 2013), R("Mirai", 2025))
        assertEquals(R("Mirai", 2025), TitleMatch.find(rows, "Mirayi", year = 2025, getYear = { it.year }) { it.title })
        assertEquals("no year on either side still matches", R("Mirai"), TitleMatch.find(listOf(R("Mirai")), "Mirayi") { it.title })
    }

    @Test fun looseMatchNeverTakesADifferentFilm() {
        // Same loose spelling, wrong year: a different film.
        assertNull(TitleMatch.find(listOf(R("Mirai", 2010)), "Mirayi", year = 2025, getYear = { it.year }) { it.title })
        assertNull(TitleMatch.find(listOf(R("Mirchi", 2013), R("Mira", 2025)), "Mirayi", year = 2025, getYear = { it.year }) { it.title })
        assertNull(TitleMatch.find(listOf(R("Ma", 2025)), "Maya", year = 2025, getYear = { it.year }) { it.title })
        assertNull(TitleMatch.find(listOf(R("Kalki 2898 AD Part 2", 2025)), "Kalki 2898 AD Part 1", year = 2025, getYear = { it.year }) { it.title })
    }

    @Test fun spacesAndPunctuationDoNotHideAMatch() {
        val rows = listOf(R("Alavaikunthapurramuloo", 2020))
        assertEquals(rows[0], TitleMatch.find(rows, "Ala Vaikunthapurramuloo", year = 2020, getYear = { it.year }) { it.title })
        assertEquals(R("OK Jaanu", 2017), TitleMatch.find(listOf(R("OK Jaanu", 2017)), "O.K. Jaanu", year = 2017, getYear = { it.year }) { it.title })
    }

    @Test fun originalTitleIsTriedWhenTheTitleMisses() {
        val rows = listOf(R("Mirai", 2025))
        assertNull(TitleMatch.find(rows, "Superyodha", year = 2025, getYear = { it.year }) { it.title })
        assertEquals(rows[0], TitleMatch.find(rows, "Superyodha", alternates = listOf("Mirai"), year = 2025, getYear = { it.year }) { it.title })
    }

    @Test fun castleRowCarriesItsYear() {
        val plain = """{"code":200,"data":{"rows":[{"id":8792434518776832,"title":"Mirai","publishTime":1757671200000}]}}"""
        val r = CastleResolver.rows(plain).single()
        assertEquals("8792434518776832", r.id)
        assertEquals(2025, r.year)
    }

    // ---- Live, opt-in (CHITRAM_LIVE=1) ----------------------------------------------

    /** One VM call plus its ?full=1 follow-up for a title that answers partial first. */
    @Test fun liveTwoPhase() = runBlocking {
        org.junit.Assume.assumeTrue(System.getenv("CHITRAM_LIVE") == "1")
        val a = Api(OkHttpClient())
        val t0 = System.currentTimeMillis()
        val first = a.streams("movie", 1222479)
        val t1 = System.currentTimeMillis()
        val shown = Ranking.fromResponse(first, "Telugu", noCodecs)
        println("LIVE first in ${t1 - t0}ms partial=${first.partial} errors=${first.providerErrors} rows=${shown.size} ${shown.map { it.provider }}")
        if (!first.wantsFull) return@runBlocking
        val more = a.streamsFull("movie", 1222479)
        val list = if (more == null) shown else Ranking.mergeMore(shown, more, "Telugu", noCodecs)
        println("LIVE full in ${System.currentTimeMillis() - t1}ms rows=${more?.streams?.size} merged=${list.size} top=${list.take(3).map { "${it.provider}${it.languages}" }}")
        assertNotNull(more)
        assertTrue(list.size >= shown.size)
    }

    /** One Castle chain with the TMDB spelling the phone gets ("Mirayi"). */
    @Test fun liveCastleMirayi() = runBlocking {
        org.junit.Assume.assumeTrue(System.getenv("CHITRAM_LIVE") == "1")
        val t0 = System.currentTimeMillis()
        val r = CastleResolver(OkHttpClient()).resolve("movie", "Mirayi", 2025, 0, 0, "Telugu")
        println("LIVE castle Mirayi in ${System.currentTimeMillis() - t0}ms: ${r?.url?.take(90)} langs=${r?.audio?.map { it.label }}")
        assertNotNull(r)
    }
}
