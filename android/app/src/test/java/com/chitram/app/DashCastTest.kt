package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.player.CastWatch
import com.chitram.app.player.DashCast
import com.chitram.app.player.LanProxy
import com.chitram.app.player.MpdHls
import com.chitram.app.player.PlayRequest
import com.chitram.app.player.WvcCast
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

/**
 * 1.2.51 (P23): casting a MultiMovies `/dash/` row. The receiver cannot carry
 * the signed query, so the cast is HLS whose segment lines are absolute signed
 * sacdn URLs: the VM route first, the phone's LAN pages when the VM is down.
 * Owner 2026-11-22: a cast the receiver refuses re-casts the next source on its
 * own, H.264 first after an HEVC refusal, remembered per receiver.
 */
class DashCastTest {
    private val folder = "https://sacdn.hakunaymatata.com/dash/68264836194533344_0_0_1080_h265_168/"
    private val signed = "Policy=eyJQb2xpY3kiOjF9&Signature=SIG~abc&Key-Pair-Id=KPID"
    private val mpdUrl = "${folder}index.mpd?$signed"
    private val vm = "https://vm.test"
    private val token = "0123456789abcdef0123"
    private val kgf by lazy { Fixtures.read("multimovies/kgf2-68264836194533344-index.mpd") }
    private val init0 by lazy { javaClass.classLoader!!.getResource("fixtures/multimovies/kgf2-init-stream0.m4s")!!.readBytes() }
    private val movie = PlayRequest("movie", 1, "KGF Chapter 2", poster = null)

    private fun row(id: String, url: String, dash: Boolean = false, langs: List<String> = listOf("Telugu"), codec: String? = null,
                    onDevice: String? = "multimovies", unsupported: Boolean = false, provider: String = "multimovies") = Source(
        id = id, provider = provider, label = provider, url = url, progressive = false, quality = "1080p",
        levels = emptyList(), languages = langs, selectableAudio = false, hybrid = false, subtitles = emptyList(),
        videoCodec = codec, codecString = null, unsupported = unsupported, onDevice = onDevice, dash = dash,
    )
    private val dashRow get() = row("mm-dash", mpdUrl, dash = true)
    private val hlsRow = row("castle-1", "https://vm.test/m3u8-proxy?url=x.m3u8", onDevice = null, provider = "castle", codec = "h264")

    // ---- cast URL selection ----

    @Test fun dashRowCastsTheVmRouteWithLanguageAndToken() = runBlocking {
        var probed: String? = null
        val r = DashCast.route(dashRow, vm, vmUp = true, token = token) { probed = it; true }
        val url = (r as DashCast.Route.Vm).url
        assertTrue(url, url.startsWith("$vm/mm/hls/68264836194533344/master.m3u8?s="))
        val s = Regex("[?&]s=([^&]+)").find(url)!!.groupValues[1]
        assertEquals(mpdUrl, String(java.util.Base64.getUrlDecoder().decode(s)))
        assertTrue(url, url.contains("&l=Telugu"))
        assertTrue(url, url.endsWith("&c=$token"))
        // The probe asks for the same master without the token, so it is not counted as the receiver.
        assertEquals(url.removeSuffix("&c=$token"), probed)
        assertFalse("no signature in clear text", url.contains("SIG~abc"))
    }

    @Test fun vmDownOrProbeFailCastsTheLanPages() = runBlocking {
        var calls = 0
        assertEquals(DashCast.Route.Lan, DashCast.route(dashRow, vm, vmUp = false, token = token) { calls++; true })
        assertEquals("a paused VM is not probed", 0, calls)
        assertEquals(DashCast.Route.Lan, DashCast.route(dashRow, vm, vmUp = true, token = token) { false })
    }

    @Test fun nonDashRowsAreUnchanged() = runBlocking {
        assertNull(DashCast.route(hlsRow, vm, vmUp = true, token = token) { true })
        assertNull("a DASH row off sacdn is not ours", DashCast.route(row("x", "https://other.test/a/index.mpd?$signed", dash = true), vm, true, token) { true })
        val spec = WvcCast.spec(hlsRow, movie)
        assertEquals("https://vm.test/m3u8-proxy?url=x.m3u8", spec.url)
        assertEquals(WvcCast.HLS_MIME, spec.mime)
    }

    @Test fun wvcGetsTheHlsUrlForADashRowWithNoHeaders() {
        val url = "$vm/mm/hls/68264836194533344/master.m3u8?s=x&c=$token"
        val spec = WvcCast.spec(dashRow.copy(headers = mapOf("Referer" to "https://mm/")), movie, castUrl = url)
        assertEquals(url, spec.url)
        assertEquals(WvcCast.HLS_MIME, spec.mime)
        assertTrue(spec.headers.isEmpty())
        assertNull(spec.hint)
    }

    /** WVC 6.2.0 on the owner's phone: only these types match an activity (main agent, measured 2026-11-22). */
    private val wvcMatches = setOf("application/vnd.apple.mpegurl", "application/x-mpegurl", "video/mp4")

    @Test fun aDashCastNeverSendsTheDashTypeAndAlwaysTheHlsRoute() {
        val spec = WvcCast.spec(dashRow, movie)
        assertEquals(WvcCast.HLS_MIME, spec.mime)
        assertTrue(spec.url, spec.url.startsWith("https://tmdb-187-127-137-163.sslip.io/mm/hls/68264836194533344/master.m3u8?s="))
        assertTrue(spec.headers.isEmpty())
        for (s in listOf(spec, WvcCast.spec(hlsRow, movie), WvcCast.spec(row("p", "https://x/a.mp4", onDevice = null).copy(progressive = true), movie),
                WvcCast.spec(dashRow, movie, castUrl = "http://192.168.1.5:1/k/p/master.m3u8"))) {
            assertTrue(s.mime, s.mime in wvcMatches)
        }
        assertEquals("application/x-mpegurl", WvcCast.HLS_MIME)
    }

    @Test fun rowLanguageIsTheOneKnownLanguage() {
        assertEquals("Telugu", DashCast.rowLanguage(dashRow))
        assertNull(DashCast.rowLanguage(dashRow.copy(languages = listOf("Telugu", "Hindi"))))
        assertNull(DashCast.rowLanguage(dashRow.copy(languages = emptyList())))
    }

    // ---- the HLS built on the phone ----

    private fun pages(lang: String? = "Telugu"): Map<String, MpdHls.Page> {
        val parsed = MpdHls.parseMpd(kgf)
        val codecs = parsed.reps.filter { it.kind == "video" }.associate { it.id to MpdHls.codecFromInit(init0)!! }
        val p = DashCast.pages(parsed, DashCast.parse(mpdUrl)!!, codecs, MpdHls.languageOf(lang)) { "http://192.168.1.5:4000/k/p/$it" }
        return (listOf("master.m3u8") + parsed.reps.map { "${it.id}.m3u8" }).associateWith { p(it)!! }
    }

    @Test fun initHvcCGivesTheFullCodec() {
        assertEquals("hev1.1.6.L150.90", MpdHls.codecFromInit(init0))
        assertNull(MpdHls.codecFromInit(ByteArray(64)))
    }

    @Test fun lanMasterHasTeluguFirstCodecsAndLanPlaylists() {
        val master = pages().getValue("master.m3u8")
        assertTrue(master.master)
        val text = master.text
        assertTrue(text, text.contains("""#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="te",NAME="Telugu",DEFAULT=YES"""))
        assertTrue(text, text.contains("""CODECS="hev1.1.6.L150.90,mp4a.40.2""""))
        assertEquals(3, text.lines().count { it.startsWith("#EXT-X-STREAM-INF") })
        assertTrue(text.lines().first { it.startsWith("#EXT-X-STREAM-INF") }.contains("RESOLUTION=2542x1080"))
        assertTrue(text.contains("http://192.168.1.5:4000/k/p/0.m3u8"))
        // With no row language, the MPD `tel` still gives te.
        assertTrue(pages(null).getValue("master.m3u8").text.contains("LANGUAGE=\"te\""))
    }

    @Test fun lanMediaPlaylistsAreSignedAbsoluteSacdnWithMap() {
        val all = pages()
        val video = all.getValue("2.m3u8")
        assertTrue(video.video)
        val lines = video.text.lines()
        assertTrue(lines.any { it == "#EXT-X-MAP:URI=\"${folder}init-stream2.m4s?$signed\"" })
        val segs = lines.filter { it.isNotEmpty() && !it.startsWith("#") }
        assertEquals(1660, segs.size)
        assertTrue(segs.all { it.startsWith(folder) && it.endsWith("?$signed") })
        assertTrue(lines.contains("#EXT-X-ENDLIST"))
        val audio = all.getValue("3.m3u8")
        assertFalse(audio.video)
        assertEquals(1987, audio.text.lines().count { it.isNotEmpty() && !it.startsWith("#") })
    }

    @Test fun signedQueryNeverReachesAnotherHost() {
        for ((name, p) in pages()) for (line in p.text.lines()) {
            if (!line.contains("Signature=")) continue
            val urls = Regex("https?://[^\"\\s]+").findAll(line).map { it.value }.toList()
            assertTrue("$name: $line", urls.isNotEmpty() && urls.all { it.startsWith("https://sacdn.hakunaymatata.com/") })
        }
        assertFalse(pages().getValue("master.m3u8").text.contains("Signature="))
    }

    @Test fun lanProxyServesPagesAndSeesTheReceiver() {
        val lo = InetAddress.getLoopbackAddress()
        val all = pages()
        val p = LanProxy(OkHttpClient(), lo, allow = { true }, pages = { all[it] }, self = { false })
        try {
            val http = OkHttpClient()
            val masterUrl = p.pageUrl("master.m3u8")
            assertNull(p.seen.master)
            http.newCall(Request.Builder().url(masterUrl).header("User-Agent", "VIDAA-WVC").build()).execute().use {
                assertEquals(200, it.code)
                assertTrue(it.header("Content-Type")!!.contains("mpegurl"))
                assertTrue(it.body!!.string().startsWith("#EXTM3U"))
            }
            assertNotNull(p.seen.master)
            assertNull(p.seen.video)
            assertNotNull(p.seen.receiver)
            http.newCall(Request.Builder().url(p.pageUrl("1.m3u8")).build()).execute().use { assertEquals(200, it.code) }
            assertNotNull(p.seen.video)
            http.newCall(Request.Builder().url(p.pageUrl("nope.m3u8")).build()).execute().use { assertEquals(404, it.code) }
        } finally { p.close() }
    }

    // ---- receiver failure: automatic re-cast ----

    @Test fun verdictFromWhatTheReceiverFetched() {
        val t0 = 1_000_000L
        assertEquals(CastWatch.Verdict.PENDING, CastWatch.verdict(CastWatch.Seen(), t0, t0 + 30_000))
        assertEquals(CastWatch.Verdict.ABANDONED, CastWatch.verdict(CastWatch.Seen(), t0, t0 + 121_000))
        val master = CastWatch.Seen(master = t0 + 5_000)
        assertEquals(CastWatch.Verdict.PENDING, CastWatch.verdict(master, t0, t0 + 14_000))
        assertEquals(CastWatch.Verdict.FAIL, CastWatch.verdict(master, t0, t0 + 15_000))
        assertEquals(CastWatch.Verdict.OK, CastWatch.verdict(master.copy(video = t0 + 7_000), t0, t0 + 8_000))
        // A video fetch from an older master does not count for a newer one.
        assertEquals(CastWatch.Verdict.PENDING, CastWatch.verdict(CastWatch.Seen(master = t0 + 9_000, video = t0 + 7_000), t0, t0 + 10_000))
    }

    private val hevcTe = row("a", mpdUrl, dash = true)
    private val hevcTe2 = row("b", "https://sacdn.hakunaymatata.com/dash/2_0_0_1080_h265_1/index.mpd?$signed", dash = true)
    private val avcHi = row("c", "https://vm.test/c.m3u8", langs = listOf("Hindi"), codec = "h264", onDevice = null, provider = "castle")
    private val avcTe = row("d", "https://vm.test/d.m3u8", codec = "h264", onDevice = null, provider = "showsst")
    private val broken = row("e", "https://vm.test/e.m3u8", codec = "h264", unsupported = true, onDevice = null)

    @Test fun hevcFailureRecastsH264TeluguFirstThenRemembers() {
        val kv = MemoryKeyValue()
        val chain = CastWatch.Chain(listOf(hevcTe, hevcTe2, avcHi, avcTe, broken), CastWatch.Memory(kv))
        assertEquals(hevcTe, chain.first(hevcTe))
        // HEVC refused: H.264 rows first (Telugu first, then listed order), the other HEVC row last.
        assertEquals(avcTe, chain.onFail(hevcTe, receiver = "tv1"))
        assertTrue(CastWatch.Memory(kv).hevcBad("tv1"))
        assertEquals(avcHi, chain.onFail(avcTe, receiver = "tv1"))
        assertNull("three attempts per tap", chain.onFail(avcHi, receiver = "tv1"))
    }

    @Test fun noHevcHistoryKeepsTeluguFirstThenListedOrder() {
        val chain = CastWatch.Chain(listOf(hevcTe, avcHi, avcTe, hevcTe2), CastWatch.Memory(MemoryKeyValue()), maxAttempts = 5)
        chain.first(avcHi)
        // An H.264 refusal says nothing about HEVC: Telugu rows in listed order.
        assertEquals(hevcTe, chain.onFail(avcHi, receiver = null))
        assertFalse(CastWatch.Memory(MemoryKeyValue()).hevcBad(null))
    }

    @Test fun laterCastSkipsHevcFirstOnAKnownHevcRefuser() {
        val kv = MemoryKeyValue()
        CastWatch.Memory(kv).markHevcBad("tv1")
        val chain = CastWatch.Chain(listOf(hevcTe, avcHi, avcTe), CastWatch.Memory(kv))
        assertEquals(avcTe, chain.first(hevcTe))
        // No H.264 row at all: cast what plays.
        assertEquals(hevcTe, CastWatch.Chain(listOf(hevcTe, hevcTe2), CastWatch.Memory(kv)).first(hevcTe))
    }

    @Test fun codecAndLogLine() {
        assertTrue(CastWatch.isHevc(hevcTe))
        assertTrue(CastWatch.isHevc(row("z", "https://x/a.m3u8", codec = "hevc", onDevice = null)))
        assertFalse(CastWatch.isHevc(avcTe))
        assertEquals("[cast] multimovies via=vm codec=hevc result=fail", CastWatch.logLine(hevcTe, "vm", CastWatch.Verdict.FAIL))
        assertEquals("[cast] showsst via=lan codec=avc result=ok", CastWatch.logLine(avcTe, "lan", CastWatch.Verdict.OK))
    }
}
