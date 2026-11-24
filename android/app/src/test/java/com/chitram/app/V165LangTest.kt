package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.HedgedDns
import com.chitram.app.data.Ranking
import com.chitram.app.data.RawStream
import com.chitram.app.data.Source
import com.chitram.app.data.StreamsResponse
import com.chitram.app.player.StartRace
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.FileTags
import com.chitram.app.resolve.ResolveConfig
import kotlinx.coroutines.runBlocking
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.util.concurrent.atomic.AtomicInteger

/** 1.2.65 (j2-lang-latency.md APK 1-7): file-tag languages on device rows, VM merge, DNS warm-up. */
class V165LangTest {
    private fun bytes(name: String) = javaClass.classLoader!!.getResource("fixtures/$name")!!.readBytes()
    private val noCodecs = CodecSupport { _, _ -> null }
    private val server = MockWebServer()
    private val files = HashMap<String, ByteArray>()
    private val ranges = ArrayList<String?>()

    @Before fun up() {
        FileTags.clearCache()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = files[request.path!!.substringBefore('?')] ?: return MockResponse().setResponseCode(404)
                val range = request.getHeader("Range")
                synchronized(ranges) { ranges += range }
                if (range == null) return MockResponse().setBody(Buffer().write(body))
                val (a, b) = range.removePrefix("bytes=").split('-').map { it.toLong() }
                val end = minOf(b, body.size - 1L)
                return MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes $a-$end/${body.size}")
                    .setBody(Buffer().write(body.copyOfRange(a.toInt(), end.toInt() + 1)))
            }
        }
        server.start()
    }

    @After fun down() = server.shutdown()

    private fun row(id: String, provider: String, url: String, langs: List<String> = emptyList(), device: Boolean = true, progressive: Boolean = false,
                    source: String? = null, audio: List<String>? = null) =
        Source(id, provider, provider, url, progressive, "1080p", emptyList(), langs, false, false, emptyList(), null, null, false,
            onDevice = if (device) provider else null, languageSource = source, audioLanguages = audio)

    private fun src(path: String) = listOf(File("src/main/java/com/chitram/app/$path"), File("app/src/main/java/com/chitram/app/$path")).first { it.exists() }.readText()

    // ---- item 3: MP4 moov (ShowsSt) -------------------------------------------------

    @Test fun mp4MoovGivesEveryAudioTrakLanguageAndUndIsUnknown() {
        assertEquals(listOf("Tamil", "Telugu"), FileTags.mp4Languages(bytes("mp4-moov-tam-tel-faststart.mp4")))
        assertEquals(listOf("Tamil"), FileTags.mp4Languages(bytes("mp4-moov-tam-tail.mp4")))
        assertEquals("und is unknown, not a language", emptyList<String>(), FileTags.mp4Languages(bytes("mp4-moov-und.mp4")))
        assertNull("no whole moov: not read", FileTags.mp4Languages(bytes("mp4-moov-tam-tail.mp4").copyOf(200)))
    }

    @Test fun showsstMoovAtTheEndIsFoundByRangeReadsAndKeptPerFile() = runBlocking {
        files["/api"] = bytes("mp4-moov-tam-tail.mp4")
        val url = server.url("/api?d=jailer&token=a").toString()
        val r = row("s", "showsst", url, progressive = true)
        assertTrue(FileTags.wants(r))
        val tags = FileTags.read(OkHttpClient(), r, headBytes = 64)!!
        assertEquals(listOf("Tamil"), tags.languages)
        assertEquals("mp4-tag", tags.source)
        assertTrue("ranged reads only", ranges.all { it != null })
        val n = ranges.size
        assertEquals(tags, FileTags.read(OkHttpClient(), r, headBytes = 64))
        assertEquals("second read of the same file is cached", n, ranges.size)
    }

    // ---- items 4-5: segment 0 PMT / fMP4 init (CastleTV, mapple, VaPlayer) ----------

    @Test fun castleSegmentZeroPmtReplacesApiLabels() = runBlocking {
        files["/master.m3u8"] = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nv/index.m3u8\n".toByteArray()
        files["/v/index.m3u8"] = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n#EXTINF:6,\nseg1.ts\n".toByteArray()
        files["/v/seg0.ts"] = bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        val r = row("c", "CastleTV", server.url("/master.m3u8").toString(), listOf("Hindi", "Ost"), audio = listOf("Hindi", "Ost"))
        val tags = FileTags.read(OkHttpClient(), r)!!
        assertEquals(listOf("Hindi", "Tamil", "Telugu", "Malayalam", "Kannada"), tags.languages)
        assertEquals("ts-pmt", tags.source)
        val after = FileTags.withLanguages(r, tags.languages, tags.source)
        assertEquals(tags.languages, after.audioLanguages)
        assertFalse("now file tags: never read again", FileTags.wants(after))
        assertTrue("Telugu ranks first once the file says Telugu", Ranking.rank(listOf(row("x", "mapple", "https://x/a.m3u8", listOf("Hindi")), after), "Telugu").first() === after)
    }

    @Test fun untaggedSegmentIsUnknownAndMappleTsWithPrefixBytesIsRead() = runBlocking {
        files["/u.m3u8"] = "#EXTM3U\n#EXTINF:6,\nu.ts\n".toByteArray()
        files["/u.ts"] = bytes("vidrock-pmt-und.ts")
        assertEquals(emptyList<String>(), FileTags.read(OkHttpClient(), row("m", "mapple", server.url("/u.m3u8").toString()))!!.languages)
        // Some fronts put a fake image header before the TS.
        files["/p.m3u8"] = "#EXTM3U\n#EXTINF:6,\np.jpg\n".toByteArray()
        files["/p.jpg"] = byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte()) + bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        assertEquals("Telugu", FileTags.read(OkHttpClient(), row("m2", "mapple", server.url("/p.m3u8").toString()))!!.languages[2])
    }

    @Test fun vaplayerFmp4InitMdhdIsRead() = runBlocking {
        files["/va.m3u8"] = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:1,\nv0.m4s\n".toByteArray()
        files["/init.mp4"] = bytes("fmp4-init-tel.mp4")
        val tags = FileTags.read(OkHttpClient(), row("v", "VaPlayer", server.url("/va.m3u8").toString()))!!
        assertEquals(listOf("Telugu"), tags.languages)
        assertEquals("mp4-tag", tags.source)
    }

    @Test fun castleApiLabelsDropNonLanguageWords() {
        assertEquals(listOf("Hindi", "Telugu"), CastleResolver.labels(listOf("Hindi", "Ost", "Telugu", "OST")))
    }

    // ---- item 6: untagged providers are left alone -----------------------------------

    @Test fun onlyTaggedDeviceProvidersAreRead() {
        assertFalse(FileTags.wants(row("o", "OneTouchTV", "https://o/a.m3u8")))
        assertFalse(FileTags.wants(row("d", "vidrift", "https://d/a.m3u8")))
        assertFalse("VM rows: the VM already reads them", FileTags.wants(row("v", "showsst", "https://v/a.mp4", device = false)))
        assertTrue(FileTags.wants(row("m", "mapple", "https://m/a.m3u8")))
    }

    // ---- item 1: dropVmDupes ----------------------------------------------------------

    @Test fun fileKeyIsHostPathAndPrismQuery() {
        assertEquals(FileTags.fileKey("https://cdn.x/a/b.mp4?sig=1"), FileTags.fileKey("https://cdn.x/a/b.mp4?sig=2"))
        assertNotEquals(FileTags.fileKey("https://prism.surrealviews.com/api?d=jailer"), FileTags.fileKey("https://prism.surrealviews.com/api?d=rrr"))
        assertEquals("proxy wrapper unwrapped", FileTags.fileKey("https://cdn.x/a/b.mp4"),
            FileTags.fileKey("https://vm.example/m3u8-proxy?url=" + java.net.URLEncoder.encode("https://cdn.x/a/b.mp4?sig=9", "UTF-8")))
    }

    @Test fun vmRowOfTheSameFileGivesItsLanguagesToTheDeviceRowAndIsDropped() {
        val prism = "https://prism.surrealviews.com/api?d=jailer&token=t"
        val dev = row("d", "showsst", prism, progressive = true)
        val other = row("d2", "mapple", "https://m/a.m3u8", listOf("Hindi"))
        val vm = listOf(
            row("v", "ShowsSt", "https://vm.example/mp4-proxy?url=" + java.net.URLEncoder.encode(prism, "UTF-8"), listOf("Tamil"), device = false, source = "mp4-tag"),
            row("v2", "ShowsSt", "https://prism.surrealviews.com/api?d=other", listOf("Telugu"), device = false, source = "mp4-tag"),
        )
        val (kept, dropped, shown, merged) = StartRace.dropVmDupes(listOf(dev, other), vm)
        assertEquals(listOf("v"), dropped.map { it.id })
        assertEquals("another file stays a row", listOf("v2"), kept.map { it.id })
        assertEquals(listOf("Tamil"), shown.first { it.id == "d" }.languages)
        assertEquals("mp4-tag", shown.first { it.id == "d" }.languageSource)
        assertEquals(listOf("showsst"), merged)
        assertEquals("[lang] vm languages merged onto device row showsst", StartRace.mergedLine("showsst"))
        // joinVm puts the updated device rows and logs the merge.
        val join = src("player/PlayerVm.kt").substringAfter("private suspend fun joinVm(").substringBefore("\n    }\n")
        assertTrue(join.contains("putSources(Ranking.merge(shown, kept,"))
        assertTrue(join.contains("StartRace.mergedLine(it)"))
    }

    @Test fun labelsNeverReplaceFileTags() {
        val dev = row("d", "CastleTV", "https://c/a.m3u8", listOf("Telugu", "Tamil"), source = "ts-pmt")
        assertNull(FileTags.mergeLanguages(dev, row("v", "CastleTV", "https://c/a.m3u8", listOf("Hindi"), device = false)))
        assertNull("empty never replaces", FileTags.mergeLanguages(dev, row("v", "CastleTV", "https://c/a.m3u8", emptyList(), device = false, source = "ts-pmt")))
    }

    // ---- item 2: ?full=1 updates rows already shown -----------------------------------

    @Test fun fullFollowUpUpdatesLanguagesOfShownRowsWithoutNewIds() {
        val playing = row("vm-showsst", "ShowsSt", "https://vm.example/mp4-proxy?url=https%3A%2F%2Fprism.surrealviews.com%2Fapi%3Fd%3Dj2", device = false)
        val shown = listOf(row("c", "CastleTV", "https://c/a.m3u8", listOf("Hindi"), device = false), playing)
        val more = StreamsResponse(success = true, streams = listOf(
            RawStream(url = "https://vm.example/mp4-proxy?url=https%3A%2F%2Fprism.surrealviews.com%2Fapi%3Fd%3Dj2", provider = "ShowsSt", container = "mp4", languages = listOf("Tamil"), languageSource = "mp4-tag"),
            RawStream(url = "https://n/new.m3u8", provider = "vidrock", container = "hls", languages = listOf("Telugu")),
        ))
        val (list, updated) = Ranking.mergeMoreLanguages(shown, more, "Telugu", noCodecs)
        assertEquals(listOf("ShowsSt"), updated)
        assertEquals("one new row only", 3, list.size)
        val s = list.first { it.provider == "ShowsSt" }
        assertEquals("same id: the playing row is not switched", "vm-showsst", s.id)
        assertEquals(listOf("Tamil"), s.languages)
        assertEquals("mp4-tag", s.languageSource)
        assertTrue(src("player/PlayerVm.kt").contains("Ranking.mergeMoreLanguages(sources, more,"))
    }

    // ---- wiring: background only, after the first frame -------------------------------

    @Test fun fileTagReadsStartAfterTheFirstFrameInTheBackground() {
        val vm = src("player/PlayerVm.kt")
        val frame = vm.substringAfter("override fun onRenderedFirstFrame()").substringBefore("override fun onCues")
        assertTrue(frame.indexOf("firstFrameLine(") < frame.indexOf("readFileTags()"))
        val fn = vm.substringAfter("private fun readFileTags()").substringBefore("private fun applyFileTags")
        assertTrue(fn.contains("viewModelScope.launch"))
        assertTrue(fn.contains("withContext(Dispatchers.IO)"))
        assertTrue(fn.contains("\"[lang] \$provider file tags "))
        assertEquals(15_000L, FileTags.BUDGET_MS)
        assertFalse("never touches the playing row", vm.substringAfter("private fun applyFileTags").substringBefore("\n    }\n").contains("play("))
    }

    // ---- item 7: DNS ------------------------------------------------------------------

    private val addr = InetAddress.getByAddress("h", byteArrayOf(1, 2, 3, 4))

    @Test fun everyDnsAnswerIsKeptAndWarmLooksHostsUpOnce() {
        val calls = AtomicInteger()
        val primary = object : Dns { override fun lookup(hostname: String): List<InetAddress> { calls.incrementAndGet(); return listOf(addr) } }
        val dns = HedgedDns(primary, { emptyList() })
        dns.warm(listOf("api.hlowb.com", "API.HLOWB.COM", "mapple.fun"))
        val t0 = System.currentTimeMillis()
        while (calls.get() < 2 && System.currentTimeMillis() - t0 < 2_000) Thread.sleep(10)
        Thread.sleep(50)
        assertEquals(2, calls.get())
        dns.lookup("mapple.fun")
        assertEquals("warmed answer kept", 2, calls.get())
        dns.clear()
        dns.lookup("mapple.fun")
        assertEquals("a network change drops kept answers", 3, calls.get())
    }

    @Test fun warmHostsAreProviderHostsOnlyWithOneNetmirrorDomain() {
        val hosts = ResolveConfig().hosts()
        assertTrue(hosts.contains("mapple.fun"))
        assertTrue(hosts.contains("api.hlowb.com"))
        assertTrue(hosts.contains("api.vidqueen.st"))
        assertEquals(1, hosts.count { it.startsWith("mobiledetect") || it.startsWith("mobidetect") })
        assertFalse("no VM host", hosts.any { "chitram" in it || "vercel" in it })
        assertTrue(src("App.kt").contains("dns.warm(resolveConfig.get().hosts())"))
    }
}
