package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.RawStream
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import com.chitram.app.player.DirectRoute
import com.chitram.app.player.FailPolicy
import com.chitram.app.player.HybridPair
import com.chitram.app.player.PlayPolicy
import com.chitram.app.player.PlayerVm
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.StreamCache
import com.chitram.app.resolve.StreamInterceptor
import com.chitram.app.resolve.UrlExpiry
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 1.2.50 dash-direct (bridge-429.md): MultiMovies `/dash/` sources play the
 * signed sacdn index.mpd with media3 DASH; `/hls/` sources keep the bridge.
 */
class DashDirectTest {
    private val server = MockWebServer()
    private val base = server.url("").toString().trimEnd('/')
    private val codecs = CodecSupport { _, _ -> null }

    @After fun stop() = server.shutdown()
    @Before fun fresh() = MultiMoviesResolver.resetServerState()

    private val mpdTemplate by lazy { Fixtures.read("multimovies/salaar-7844085959171131184-index.mpd") }
    private val bridge by lazy { Fixtures.read("multimovies/rrr-bridge-telugu.m3u8") }
    private val signed = "Policy=P1&Signature=S1&Key-Pair-Id=K1"
    private val dashId = "7844085959171131184"
    private val dashSrc get() = "$base/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F${dashId}_0_0_1080_h265_168%2Fmaster.m3u8&$signed"
    private val hlsSrc get() = "$base/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fhls%2F330483265830305744-0-0-1080-1%2Fmaster.m3u8&$signed"

    /** sacdn.hakunaymatata.com goes to the mock server; everything else is untouched. */
    private val sacdnToMock = OkHttpClient.Builder().addInterceptor { chain ->
        val r = chain.request()
        if (r.url.host != "sacdn.hakunaymatata.com") chain.proceed(r)
        else chain.proceed(r.newBuilder().url(r.url.newBuilder().scheme("http").host(server.hostName).port(server.port).build()).build())
    }.build()

    /** Plain resolve lists [sources]; MPD answers with [mpd]; any `/?url=` is the bridge. Returns every path asked. */
    private fun serve(sources: List<Pair<String, String?>>, mpd: () -> MockResponse = { MockResponse().setBody(mpdTemplate) }): MutableList<String> {
        val asked = java.util.Collections.synchronizedList(mutableListOf<String>())
        val list = sources.joinToString(",") { (u, l) -> """{"url":"$u","kind":"hls","quality":"1080p"${l?.let { ",\"language\":\"$it\"" } ?: ""}}""" }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                asked += path
                if (path.startsWith("/api/resolve")) return if ("only=" in path) MockResponse().setBody("""{"stream":null}""")
                    else MockResponse().setBody("""{"stream":{"server":"callisto","sources":[$list]}}""")
                if (path.startsWith("/dash/") && "/index.mpd" in path) return mpd()
                if (path.startsWith("/?url=")) return MockResponse().setBody(bridge)
                return MockResponse().setBody("")
            }
        }
        return asked
    }

    private fun resolver() = MultiMoviesResolver(sacdnToMock, origin = base)

    // ---- 1. resolver row shape ---------------------------------------------------

    @Test fun dashSourceIsASignedMpdRowAndHlsSourceKeepsTheBridge() = runBlocking {
        val asked = serve(listOf(dashSrc to "Telugu", hlsSrc to "Hindi"))
        val rows = resolver().resolveAll("movie", 770906, 0, 0)
        assertEquals(2, rows.size)
        val d = rows.single { it.dash }
        assertTrue(d.url, d.url.startsWith("https://sacdn.hakunaymatata.com/dash/${dashId}_0_0_1080_h265_168/index.mpd?"))
        assertTrue(d.url.endsWith("?$signed"))
        assertEquals(listOf(1080, 720, 480), d.levels.map { it.height })
        assertEquals("hev1,mp4a.40.2", d.codecs)
        assertEquals(listOf("Telugu"), d.audio.mapNotNull { it.label })
        assertEquals("multimovies-$dashId", d.key)
        val h = rows.single { !it.dash }
        assertEquals(hlsSrc, h.url)
        assertEquals(listOf("Hindi"), h.audio.mapNotNull { it.label })
        assertEquals("the dash master is never fetched through the bridge", 0, asked.count { it.startsWith("/?url=") && "%2Fdash%2F" in it })
        assertEquals("one MPD GET: liveness and lang share it", 1, asked.count { "/index.mpd" in it })
    }

    @Test fun anMpdWithNoRepresentationIsNotARow() = runBlocking {
        serve(listOf(dashSrc to "Telugu", hlsSrc to "Hindi")) { MockResponse().setBody(mpdTemplate.replace(Regex("<Representation[\\s\\S]*?</Representation>"), "")) }
        val rows = resolver().resolveAll("movie", 770906, 0, 0)
        assertEquals(listOf(false), rows.map { it.dash })
    }

    @Test fun aDeadMpdDropsOnlyItsRow() = runBlocking {
        serve(listOf(dashSrc to "Telugu", hlsSrc to "Hindi")) { MockResponse().setResponseCode(403) }
        val rows = resolver().resolveAll("movie", 770906, 0, 0)
        assertEquals(listOf(hlsSrc), rows.map { it.url })
    }

    @Test fun dashRowReachesSourceAndCacheWithItsMimeAndLanguage() = runBlocking {
        serve(listOf(dashSrc to "Telugu"))
        val r = resolver().resolveAll("movie", 770906, 0, 0).single()
        val s = OnDeviceResolver.toSource(r, codecs)
        assertTrue(s.dash)
        assertFalse(s.progressive)
        assertEquals(listOf("Telugu"), s.languages)
        val kv = MemoryKeyValue()
        StreamCache(kv).putDevice("movie:770906:0:0", "multimovies", "Telugu", listOf(s))
        val back = StreamCache(kv).device("movie:770906:0:0", "multimovies", "Telugu")!!.single()
        assertTrue("dash survives the device cache", back.dash)
        assertEquals(listOf("Telugu"), back.languages)
    }

    // ---- 2. signed query, playing row only -------------------------------------

    private fun seen(i: StreamInterceptor, url: String): String {
        var out = ""
        val c = OkHttpClient.Builder().addInterceptor(i).addInterceptor { ch ->
            out = ch.request().url.toString()
            Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body("".toResponseBody()).build()
        }.build()
        c.newCall(Request.Builder().url(url).build()).execute().close()
        return out
    }

    private val mpdA = "https://sacdn.hakunaymatata.com/dash/1_h265/index.mpd?Policy=PA&Signature=SA&Key-Pair-Id=KA"
    private val mpdB = "https://sacdn.hakunaymatata.com/dash/2_h265/index.mpd?Policy=PB&Signature=SB&Key-Pair-Id=KB"

    @Test fun sacdnSegmentsGetThePlayingRowsSignedQuery() {
        val a = StreamInterceptor(emptyMap(), null, signedFrom = mpdA)
        assertEquals("https://sacdn.hakunaymatata.com/dash/1_h265/chunk-stream0-00001.m4s?Policy=PA&Signature=SA&Key-Pair-Id=KA",
            seen(a, "https://sacdn.hakunaymatata.com/dash/1_h265/chunk-stream0-00001.m4s"))
        assertEquals("already signed: untouched", mpdA, seen(a, mpdA))
        assertEquals("another host: untouched", "https://img.rousav.tech/x/seg.ts", seen(a, "https://img.rousav.tech/x/seg.ts"))
        val b = StreamInterceptor(emptyMap(), null, signedFrom = mpdB)
        assertTrue("row B gets B's query, never A's", seen(b, "https://sacdn.hakunaymatata.com/dash/2_h265/init-stream3.m4s").endsWith("?Policy=PB&Signature=SB&Key-Pair-Id=KB"))
        val none = StreamInterceptor(emptyMap(), null)
        assertEquals("a row with no MPD adds nothing", "https://sacdn.hakunaymatata.com/dash/1_h265/init-stream3.m4s",
            seen(none, "https://sacdn.hakunaymatata.com/dash/1_h265/init-stream3.m4s"))
    }

    @Test fun signedFromComesOnlyFromADashRow() {
        val dash = devRow(mpdA, dash = true)
        assertEquals(mpdA, StreamInterceptor.signedFrom(dash))
        assertNull(StreamInterceptor.signedFrom(devRow("https://sacdn.hakunaymatata.com/hls/x/master.m3u8?Policy=P&Signature=S&Key-Pair-Id=K", dash = false)))
    }

    // ---- 3. mime type ------------------------------------------------------------

    @Test fun dashRowPlaysAsMpd() {
        assertEquals(MimeTypes.APPLICATION_MPD, PlayPolicy.mimeFor(devRow(mpdA, dash = true)))
        assertEquals(MimeTypes.APPLICATION_M3U8, PlayPolicy.mimeFor(devRow("https://h/master.m3u8", dash = false)))
        assertNull(PlayPolicy.mimeFor(devRow("https://h/a.mp4", dash = false).copy(progressive = true)))
        assertFalse("a dash row never takes the base client", PlayPolicy.usesBaseClient(devRow(mpdA, dash = true).copy(onDevice = null, headers = emptyMap()), false))
    }

    @Test fun backendDashRowIsNotProgressive() {
        val s = Ranking.toSource(RawStream(url = "https://vm/mm/x/index.mpd", provider = "multimovies", container = "dash"), 0, codecs)!!
        assertTrue(s.dash)
        assertFalse(s.progressive)
        val byUrl = Ranking.toSource(RawStream(url = "https://vm/mm/x/index.mpd?a=1", provider = "multimovies"), 0, codecs)!!
        assertTrue(byUrl.dash)
    }

    // ---- 4. language from the MPD reaches the track label ----------------------

    private fun group(vararg f: Format) = Tracks.Group(TrackGroup("1:1", *f), false, IntArray(f.size) { C.FORMAT_HANDLED }, BooleanArray(f.size) { it == 0 })
    private fun audio(lang: String?) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).build()

    @Test fun mpdTelReachesTheAudioMenuAsTelugu() {
        // media3's DashManifestParser puts AdaptationSet@lang into Format.language; Format normalizes tel -> te.
        val f = audio("tel")
        assertEquals("te", f.language)
        val row = devRow(mpdA, dash = true).copy(languages = listOf("Telugu"))
        val items = PlayerVm.audioMenu(listOf(group(f)), listOf(row), row, unnamed = "Telugu", curLang = "Telugu")
        assertEquals("Telugu", items.first().label)
        assertEquals("ta", audio("tam").language)
    }

    @Test fun mpdAudioLangIsRewrittenOnlyWhenThePlanDisagrees() {
        val mpd = mpdTemplate
        assertEquals("tel kept", mpd, StreamInterceptor.mpdWithLang(mpd, "te"))
        val eng = mpd.replace(" lang=\"tel\"", " lang=\"eng\"")
        assertTrue("eng (no evidence) on a Bengali row -> ben", StreamInterceptor.mpdWithLang(eng, "bn").contains(" lang=\"bn\""))
        val none = mpd.replace(" lang=\"tel\"", "")
        assertTrue("no lang -> the row's", StreamInterceptor.mpdWithLang(none, "kn").contains("contentType=\"audio\" lang=\"kn\"") ||
            Regex("""<AdaptationSet[^>]*contentType="audio"[^>]*lang="kn"""").containsMatchIn(StreamInterceptor.mpdWithLang(none, "kn")))
        assertEquals("video set untouched", 1, Regex("lang=").findAll(StreamInterceptor.mpdWithLang(none, "kn")).count())
    }

    @Test fun theMpdResponseCarriesTheRowsLanguage() {
        val eng = mpdTemplate.replace(" lang=\"tel\"", " lang=\"eng\"")
        val i = StreamInterceptor(emptyMap(), null, signedFrom = mpdA, audioLang = "bn")
        val c = OkHttpClient.Builder().addInterceptor(i).addInterceptor { ch ->
            Response.Builder().request(ch.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(eng.toResponseBody("application/dash+xml".toMediaType())).build()
        }.build()
        val body = c.newCall(Request.Builder().url(mpdA).build()).execute().use { it.body!!.string() }
        assertTrue(body.contains(" lang=\"bn\""))
        assertFalse(body.contains(" lang=\"eng\""))
    }

    @Test fun rowLanguageCodeIsTheSingleKnownLanguage() {
        assertEquals("te", StreamInterceptor.audioLangOf(devRow(mpdA, dash = true).copy(audioLanguages = listOf("Telugu"))))
        assertNull("no language: the MPD tag stands", StreamInterceptor.audioLangOf(devRow(mpdA, dash = true).copy(audioLanguages = emptyList())))
        assertNull("not dash", StreamInterceptor.audioLangOf(devRow("https://h/m.m3u8", dash = false).copy(audioLanguages = listOf("Telugu"))))
    }

    // ---- 5. fallback when an MPD row fails ---------------------------------------

    @Test fun aFailedDashRowHasNoProxyAndMovesOn() {
        val d = devRow(mpdA, dash = true)
        assertEquals(d, DirectRoute.forPlay(d, emptySet()))
        assertFalse(DirectRoute.shouldFallBack(d, framed = false, vmUp = true))
        assertEquals(FailPolicy.Action.RERESOLVE, FailPolicy.onError(d, 403, refreshedOnce = false))
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(d, 403, refreshedOnce = false, deviceRetried = true))
    }

    // ---- expiry, pairing -----------------------------------------------------------

    @Test fun cloudFrontPolicyStatesTheExpiry() {
        val now = 1_795_000_000_000L
        val policy = """{"Statement":[{"Resource":"https://sacdn.hakunaymatata.com/dash/1_h265/*","Condition":{"DateLessThan":{"AWS:EpochTime":1795600000}}}]}"""
        val enc = java.util.Base64.getEncoder().encodeToString(policy.toByteArray()).replace('+', '-').replace('=', '_').replace('/', '~')
        assertEquals(1_795_600_000_000L, UrlExpiry.at("https://sacdn.hakunaymatata.com/dash/1_h265/index.mpd?Policy=$enc&Signature=S&Key-Pair-Id=K", now))
        assertNull(UrlExpiry.at("https://sacdn.hakunaymatata.com/dash/1_h265/index.mpd?Policy=junk&Signature=S", now))
    }

    /**
     * Bare `hev1` (sacdn MPD codecs): media3 maps it to video/hevc, and its
     * profile parser gives null (fewer than 4 parts). MediaCodecInfo treats a
     * null profile as "no profile check", so the track is not rejected for it.
     */
    @Test fun bareHev1IsHevcWithNoProfileToReject() {
        assertEquals(MimeTypes.VIDEO_H265, MimeTypes.getVideoMediaMimeType("hev1"))
        val f = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H265).setCodecs("hev1").build()
        // media3 logs "Ignoring malformed HEVC codec string" here; its logger needs android.util.Log, so off on the JVM.
        androidx.media3.common.util.Log.setLogLevel(androidx.media3.common.util.Log.LOG_LEVEL_OFF)
        assertNull(androidx.media3.exoplayer.mediacodec.MediaCodecUtil.getCodecProfileAndLevel(f))
    }

    @Test fun pairingGateReadsTheMpdDuration() = runBlocking {
        val secs = HybridPair.mediaSeconds(mpdA, false) { mpdTemplate }
        assertEquals(2 * 3600 + 54 * 60 + 4.2, secs!!, 0.01)
    }

    private fun devRow(url: String, dash: Boolean) = Source(
        id = "device-multimovies-x", provider = "multimovies", label = "MultiMovies", url = url, progressive = false, quality = "1080p",
        levels = emptyList(), languages = emptyList(), selectableAudio = false, hybrid = false, subtitles = emptyList(),
        videoCodec = null, codecString = null, unsupported = false, onDevice = "multimovies",
        headers = MultiMoviesResolver.streamHeaders(MultiMoviesResolver.ORIGIN), dash = dash,
    )
}
