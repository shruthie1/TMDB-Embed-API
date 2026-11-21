package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Source
import com.chitram.app.data.SubtitleRef
import com.chitram.app.player.FailPolicy
import com.chitram.app.player.PlayPolicy
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.StreamInterceptor
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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK multimovies (apk-multimovies-report.md): every VidBolt source is a row and
 * keeps its language (server twin: providers/multimovies.js audioFromMaster), plus
 * the multimovies-slow-rca.md player fixes.
 */
class MultiMoviesApkTest {
    private val server = MockWebServer()
    private val base = server.url("").toString().trimEnd('/')
    private val codecs = CodecSupport { _, _ -> null }

    @After fun stop() = server.shutdown()
    @org.junit.Before fun freshServerState() = MultiMoviesResolver.resetServerState()

    private fun master(audioLine: String) =
        "#EXTM3U\n$audioLine\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO=\"a\"\nv720.m3u8\n"

    private fun generic(name: String = "Audio") = "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"$name\",DEFAULT=YES,URI=\"a.m3u8\""

    /** /api/resolve lists `sources` ({path, language}); each path answers with its master (null = 404). */
    private fun serve(sources: List<Pair<String, String?>>, masters: Map<String, String?>) {
        val list = sources.joinToString(",") { (p, l) -> """{"url":"$base$p","kind":"hls","quality":"1080p"${l?.let { ",\"language\":\"$it\"" } ?: ""}}""" }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path.startsWith("/api/resolve")) return MockResponse().setBody("""{"stream":{"server":"x","sources":[$list]}}""")
                val body = masters[path] ?: return MockResponse().setResponseCode(404)
                return MockResponse().setBody(body)
            }
        }
    }

    private fun labels(r: com.chitram.app.resolve.Resolved) = r.audio.mapNotNull { it.label }

    // ---- Fix 1: every source is a row, VidBolt language kept ------------------

    @Test fun rrrReturnsEverySourceAndTheTeluguRowIsLabelledTelugu() = runBlocking {
        val bridge = Fixtures.read("multimovies/rrr-bridge-telugu.m3u8")
        serve(
            listOf("/hi/master.m3u8" to "Hindi", "/te/master.m3u8" to "Telugu", "/en/master.m3u8" to "English"),
            mapOf("/hi/master.m3u8" to bridge, "/te/master.m3u8" to bridge, "/en/master.m3u8" to bridge),
        )
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        assertEquals(3, rows.size)
        assertEquals(listOf(listOf("Hindi"), listOf("Telugu"), listOf("English")), rows.map(::labels))
        assertEquals(listOf("$base/hi/master.m3u8", "$base/te/master.m3u8", "$base/en/master.m3u8"), rows.map { it.url })
        // Distinct row ids, or Ranking.merge would fold them into one.
        val sources = rows.map { OnDeviceResolver.toSource(it, codecs) }
        assertEquals(3, sources.map { it.id }.toSet().size)
        assertEquals(listOf("Telugu"), sources[1].languages)
    }

    @Test fun masterLanguageBeatsTheSourceLanguage() = runBlocking {
        serve(listOf("/m.m3u8" to "Telugu"), mapOf("/m.m3u8" to master("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Audio\",LANGUAGE=\"hin\",URI=\"a.m3u8\"")))
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0)
        assertEquals(listOf("Hindi"), labels(rows.single()))
    }

    @Test fun subAndOriginalAreNotAudioLanguages() = runBlocking {
        serve(
            listOf("/a.m3u8" to "Arabic sub", "/b.m3u8" to "Original", "/c.m3u8" to null),
            mapOf("/a.m3u8" to master(generic()), "/b.m3u8" to master(generic()), "/c.m3u8" to master(generic())),
        )
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0)
        assertEquals(3, rows.size)
        // Generic "Audio" stays unlabelled (old fallback), never claimed as Arabic.
        assertTrue(rows.all { it.audio.single().language == null })
    }

    @Test fun aNamedRenditionIsNotOverriddenAndUndTakesTheSource() = runBlocking {
        serve(
            listOf("/n.m3u8" to "Telugu", "/u.m3u8" to "Telugu", "/t.m3u8" to "Telugu"),
            mapOf(
                "/n.m3u8" to master(generic("Tamil")),
                "/u.m3u8" to master("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Track 1\",LANGUAGE=\"und\",URI=\"a.m3u8\""),
                "/t.m3u8" to master(generic("[2] Audio")),
            ),
        )
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0)
        assertEquals(listOf(listOf("Tamil"), listOf("Telugu"), listOf("Telugu")), rows.map(::labels))
    }

    @Test fun oneDeadMasterDropsOnlyItsRow() = runBlocking {
        serve(listOf("/dead.m3u8" to "Hindi", "/ok.m3u8" to "Telugu"), mapOf("/dead.m3u8" to null, "/ok.m3u8" to master(generic())))
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0)
        assertEquals(listOf(listOf("Telugu")), rows.map(::labels))
    }

    @Test fun onDeviceResolveAllKeepsEveryMultiMoviesRowTeluguFirst() = runBlocking {
        val bridge = Fixtures.read("multimovies/rrr-bridge-telugu.m3u8")
        serve(listOf("/hi.m3u8" to "Hindi", "/te.m3u8" to "Telugu"), mapOf("/hi.m3u8" to bridge, "/te.m3u8" to bridge))
        val kv = MemoryKeyValue()
        val client = OkHttpClient()
        val od = OnDeviceResolver(null, ResolveConfigStore(client, "$base/config", kv), MappleResolver(client, HostBook(kv), kv),
            VaplayerResolver(client, HostBook(kv)) { null }, multimovies = MultiMoviesResolver(client, origin = base))
        val all = od.resolveAll(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs)
        assertEquals(2, all.size)
        assertEquals(setOf(listOf("Hindi"), listOf("Telugu")), all.map { it.languages }.toSet())
        assertEquals(listOf("Telugu"), od.resolveOne(OnDeviceResolver.MULTIMOVIES, "movie", 579974, 0, 0, codecs, "Telugu")!!.languages)
    }

    // ---- Fix 2a: an HLS subtitle playlist is never sideloaded as a VTT caption

    @Test fun hlsSubtitlePlaylistsAreNotSideloaded() {
        val subs = listOf(
            SubtitleRef("https://img.rousav.tech/media/e05abdef7075cb76ef3b/subtitles_english.m3u8", "en"),
            SubtitleRef("https://vm/m3u8-proxy?url=https%3A%2F%2Fh%2Fsubs.m3u8", "en"),
            SubtitleRef("https://h/subs/en.vtt", "en"),
            SubtitleRef("https://h/subs/te.srt", "te"),
            // Review I6: a proxied VTT and a .m3u8 in a query string are real caption files.
            SubtitleRef("https://vm/m3u8-proxy?url=https%3A%2F%2Fh%2Fsubs%2Fen.vtt", "en"),
            SubtitleRef("https://h/sub.vtt?from=index.m3u8", "en"),
        )
        assertEquals(listOf("https://h/subs/en.vtt", "https://h/subs/te.srt", "https://vm/m3u8-proxy?url=https%3A%2F%2Fh%2Fsubs%2Fen.vtt", "https://h/sub.vtt?from=index.m3u8"),
            PlayPolicy.sideloadable(subs).map { it.url })
    }

    // ---- Fix 2b: a VM multimovies row that delivered bytes is not re-resolved on the device

    private fun vmRow(provider: String) =
        Source("vm-$provider", provider, provider, "https://vm/m3u8-proxy?url=x", false, "1080p", emptyList(), listOf("Telugu"), false, false, emptyList(), null, null, false)

    @Test fun aliveVmMultiMoviesRowFailsOverInsteadOfDevice() {
        val mm = vmRow("multimovies")
        assertEquals(FailPolicy.Action.FAILOVER, FailPolicy.onError(mm, null, refreshedOnce = false, rowDelivered = true))
        assertEquals(FailPolicy.Action.DEVICE, FailPolicy.onError(mm, null, refreshedOnce = false, rowDelivered = false))
        // CastleTV's device path is a different route: unchanged.
        assertEquals(FailPolicy.Action.DEVICE, FailPolicy.onError(vmRow("CastleTV"), null, refreshedOnce = false, rowDelivered = true))
    }

    // ---- Fix 2c: a mapple proxy-host failure is a dead row now; the same proxied row is not replayed

    private val mapple = Source("device-mapple", "mapple", "mapple", "https://proxy2.jordanblackwell.bid/playlist/abc", false, "1080p",
        emptyList(), listOf("Telugu"), true, false, emptyList(), null, null, false, onDevice = "mapple", headers = mapOf("Referer" to "https://mapple.fun/"))

    @Test fun mappleProxyHostConnectFailureIsDeadAtOnce() {
        assertTrue(PlayPolicy.proxyHostDead(mapple, "https://proxy2.jordanblackwell.bid/playlist/abc", httpReplied = false, framed = false))
        assertTrue(PlayPolicy.proxyHostDead(mapple, "https://proxy2.jordanblackwell.bid/video/seg1", httpReplied = false, framed = false))
        // A reply, a frame, another host, or another provider: the normal path.
        assertFalse(PlayPolicy.proxyHostDead(mapple, "https://proxy2.jordanblackwell.bid/playlist/abc", httpReplied = true, framed = false))
        assertFalse(PlayPolicy.proxyHostDead(mapple, "https://proxy2.jordanblackwell.bid/playlist/abc", httpReplied = false, framed = true))
        assertFalse(PlayPolicy.proxyHostDead(mapple, "https://subs.example/en.vtt", httpReplied = false, framed = false))
        assertFalse(PlayPolicy.proxyHostDead(mapple.copy(provider = "CastleTV", onDevice = "CastleTV"), mapple.url, httpReplied = false, framed = false))
    }

    @Test fun theSameProxiedMappleRowIsNotReplayed() {
        assertTrue(FailPolicy.unchangedProxiedRetry(mapple, mapple.copy()))
        assertFalse(FailPolicy.unchangedProxiedRetry(mapple, mapple.copy(url = "https://proxy2.jordanblackwell.bid/playlist/new-session")))
    }

    // ---- Fix 2d (review I1/I2): 3 s only with a proxy fallback; 8 s on-device and resolver

    @Test fun connectTimeoutIsShortOnlyWhenAProxyFallbackExists() {
        assertEquals(8_000, MultiMoviesResolver(OkHttpClient()).http.connectTimeoutMillis)
        val vmDirect = vmRow("multimovies").copy(url = "https://img.rousav.tech/m/index.m3u8", proxyUrl = "https://vm/m3u8-proxy?url=x")
        assertEquals(3_000L, PlayPolicy.connectTimeoutMs(vmDirect))
        assertEquals(8_000L, PlayPolicy.connectTimeoutMs(mapple))
        assertEquals(null, PlayPolicy.connectTimeoutMs(vmRow("CastleTV")))
        assertEquals(3_000, StreamInterceptor.playerClient(OkHttpClient(), emptyMap(), null, 3_000L).connectTimeoutMillis)
        assertEquals(10_000, StreamInterceptor.playerClient(OkHttpClient(), emptyMap(), null, null).connectTimeoutMillis)
    }

    // ---- Review C1: source language only on a master with ONE audio rendition

    @Test fun twoGenericRenditionsKeepTheirNames() = runBlocking {
        val two = "#EXTM3U\n" +
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Audio 1\",URI=\"a1.m3u8\"\n" +
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Audio 2\",URI=\"a2.m3u8\"\n" +
            "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO=\"a\"\nv720.m3u8\n"
        serve(listOf("/d.m3u8" to "Telugu"), mapOf("/d.m3u8" to two))
        val row = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0).single()
        assertEquals(listOf(null, null), row.audio.map { it.language })
        assertEquals(listOf("Audio 1", "Audio 2"), row.audio.map { it.name })
    }

    // ---- Review I3: server sourceLanguage rules exactly

    @Test fun sourceLanguageFollowsTheServerRules() {
        assertEquals("Telugu", MultiMoviesResolver.sourceLanguage("Telugu"))
        assertEquals("Telugu", MultiMoviesResolver.sourceLanguage("tel"))
        assertEquals(null, MultiMoviesResolver.sourceLanguage("Telugu subbed"))
        assertEquals(null, MultiMoviesResolver.sourceLanguage("Arabic subs"))
        assertEquals(null, MultiMoviesResolver.sourceLanguage("Hindi dubbed"))
        assertEquals(null, MultiMoviesResolver.sourceLanguage("Dual Audio"))
        assertEquals(null, MultiMoviesResolver.sourceLanguage("Original"))
        assertEquals("Telugu", MultiMoviesResolver.sourceLanguage("Original", originalLang = "te"))
        assertEquals(null, MultiMoviesResolver.sourceLanguage("Original", originalLang = "xx"))
    }

    @Test fun originalSourceTakesTheTitlesOriginalLanguage() = runBlocking {
        serve(listOf("/o.m3u8" to "Original"), mapOf("/o.m3u8" to master(generic())))
        val row = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0, originalLang = "te").single()
        assertEquals(listOf("Telugu"), labels(row))
    }

    // Vidrift's "Original" for 1261763 (TMDB te) is the Tamil track (2026-11-21).
    // Server twin: test/multimovies.test.js originalLanguageFor.
    @Test fun originalSourceStaysUnlabelledWhenAnotherSourceNamesTheLanguage() = runBlocking {
        serve(listOf("/o.m3u8" to "Original", "/te.m3u8" to "Telugu", "/ta.m3u8" to "Tamil"),
            mapOf("/o.m3u8" to master(generic()), "/te.m3u8" to master(generic()), "/ta.m3u8" to master(generic())))
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1261763, 0, 0, originalLang = "te")
        val orig = rows.single { it.url == "$base/o.m3u8" }
        assertFalse(labels(orig).toString(), "Telugu" in labels(orig))
        assertEquals(1, rows.count { "Telugu" in labels(it) })
    }

    @Test fun originalLanguageForFollowsTheServerRule() {
        assertEquals("te", MultiMoviesResolver.originalLanguageFor(listOf("Original", "Hindi"), "te"))
        assertEquals(null, MultiMoviesResolver.originalLanguageFor(listOf("Original", "Hindi", "Telugu"), "te"))
        assertEquals(null, MultiMoviesResolver.originalLanguageFor(listOf("Original", "tel"), "te"))
        assertEquals("te", MultiMoviesResolver.originalLanguageFor(listOf("Original", "Telugu Sub"), "te"))
        assertEquals("te", MultiMoviesResolver.originalLanguageFor(listOf("Original", "Original"), "te"))
        assertEquals(null, MultiMoviesResolver.originalLanguageFor(listOf("Original"), null))
    }

    // ---- Review I4: stable ids from the master url, not the index

    @Test fun rowIdsComeFromTheMasterNotTheOrder() = runBlocking {
        val bridge = Fixtures.read("multimovies/rrr-bridge-telugu.m3u8")
        val sacdn = "/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5820588283537016992_0_0_1080_h265_795%2Fmaster.m3u8&Signature=A"
        serve(listOf(sacdn to "Telugu", "/media/e05abdef/index.m3u8?api_key=1" to "Hindi"),
            mapOf(sacdn to bridge, "/media/e05abdef/index.m3u8?api_key=1" to bridge))
        val first = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0)
        serve(listOf("/media/e05abdef/index.m3u8?api_key=2" to "Hindi", sacdn.replace("Signature=A", "Signature=B") to "Telugu"),
            mapOf("/media/e05abdef/index.m3u8?api_key=2" to bridge, sacdn.replace("Signature=A", "Signature=B") to bridge))
        val again = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0)
        assertEquals("multimovies-5820588283537016992", first.first { labels(it) == listOf("Telugu") }.key)
        assertEquals(first.associate { it.key to labels(it) }, again.associate { it.key to labels(it) })
        // The same master twice (rotated signature) is one row.
        assertEquals(2, first.map { it.key }.toSet().size)
    }

    // ---- Review I5: one slow master drops only its own row

    @Test fun aSlowMasterDropsOnlyItsRow() = runBlocking {
        val ok = master(generic())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.startsWith("/api/resolve") -> MockResponse().setBody(
                    """{"stream":{"sources":[{"url":"$base/slow.m3u8","kind":"hls","language":"Hindi"},{"url":"$base/fast.m3u8","kind":"hls","language":"Telugu"}]}}""")
                request.path == "/slow.m3u8" -> MockResponse().setBody(ok).setHeadersDelay(5, java.util.concurrent.TimeUnit.SECONDS)
                else -> MockResponse().setBody(ok)
            }
        }
        val t0 = System.currentTimeMillis()
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base, masterTimeoutMs = 800).resolveAll("movie", 1, 0, 0)
        assertEquals(listOf(listOf("Telugu")), rows.map(::labels))
        assertTrue("took ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 3_000)
        // The whole budget is never spent on masters: what finished is kept.
        val capped = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 1, 0, 0, budgetMs = 1_000)
        assertEquals(listOf(listOf("Telugu")), capped.map(::labels))
    }

    // ---- Fix 2e: a row judged dead is never reported ok ------------------------

    @Test fun deadVerdictDoesNotMarkTheRowLanded() {
        val vm = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        assertFalse("DEAD must not set landed (checkRuntime would report ok)", Regex("""landed\s*=\s*true\s*//\s*judged""").containsMatchIn(vm))
        val runtime = vm.substringAfter("private fun checkRuntime()").substringBefore("report(s, ok = true")
        assertTrue("checkRuntime must skip a judged row", runtime.contains("judged"))
    }

    // ---- Owner: nested server entries of one provider are distinguishable

    @Test fun nestedServerEntriesAreDistinguishable() {
        fun row(id: String, url: String, langs: List<String>) = vmRow("multimovies").copy(id = id, url = url, languages = langs)
        val enc = { u: String -> java.net.URLEncoder.encode(u, "UTF-8") }
        val rows = listOf(
            row("a", "https://vm/m3u8-proxy?url=" + enc("https://dash-hls-bridge.johndoesdmc.workers.dev/?url=" + enc("https://sacdn.hakunaymatata.com/dash/1_h265/v3.m3u8")), listOf("Telugu")),
            row("b", "https://vm/m3u8-proxy?url=" + enc("https://img.rousav.tech/media/e05/index.m3u8"), emptyList()),
            row("c", "https://vm/m3u8-proxy?url=" + enc("https://img.rousav.tech/media/f99/index.m3u8"), emptyList()),
            row("d", "https://img.rousav.tech/media/g11/index.m3u8", listOf("Hindi")),
        )
        assertEquals("bridge", com.chitram.app.player.ServerTag.host(rows[0].url))
        assertEquals("rousav", com.chitram.app.player.ServerTag.host(rows[1].url))
        val tags = com.chitram.app.player.ServerTag.tags(rows)
        assertEquals(mapOf("a" to "bridge", "b" to "rousav 1", "c" to "rousav 2", "d" to "rousav"), tags)
        // One row of a provider needs no tag.
        assertEquals(emptyMap<String, String>(), com.chitram.app.player.ServerTag.tags(rows.take(1)))
    }

    // ---- Every VidBolt server (2026-11-21): the plain resolve gave `luna` for RRR
    // (one unlabelled 720p source) while `only=callisto` had the Telugu masters.

    private fun only(path: String) = Regex("[?&]only=([^&]+)").find(path)?.groupValues?.get(1)

    /** RRR as measured: plain -> luna, callisto -> two Telugu bridge masters, the rest null. */
    private fun serveRrrAllServers(embed: String = "", slow: Set<String> = emptySet(), status: Map<String, Int> = emptyMap()): MutableList<String> {
        val bridge = Fixtures.read("multimovies/rrr-bridge-telugu.m3u8")
        val te1 = "/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5820588283537016992_0_0_1080_h265_795%2Fmaster.m3u8"
        val te2 = "/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5355663801620775816_0_0_1080_h265_623%2Fmaster.m3u8"
        val asked = java.util.Collections.synchronizedList(mutableListOf<String>())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                if (path.startsWith("/api/resolve")) {
                    val s = only(path)
                    asked += s ?: "default"
                    status[s ?: "default"]?.let { return MockResponse().setResponseCode(it) }
                    if (s in slow) return MockResponse().setBody("""{"stream":null}""").setHeadersDelay(6, java.util.concurrent.TimeUnit.SECONDS) // > RESOLVE_STEP_MS; under MockWebServer's 5 s shutdown wait after the settle
                    return MockResponse().setBody(when (s) {
                        "callisto" -> """{"stream":{"server":"callisto","sources":[{"url":"$base$te1&Signature=A","kind":"hls","language":"Telugu"},{"url":"$base$te2&Signature=A","kind":"hls","language":"Telugu"},{"url":"$base/f/x.mp4","kind":"mp4","language":"Russian"}]}}"""
                        null, "luna" -> """{"stream":{"server":"luna","sources":[{"url":"$base/v/luna.m3u8","kind":"hls","language":null}]}}"""
                        else -> """{"stream":null}"""
                    })
                }
                if (path.startsWith("/movie/")) return MockResponse().setBody(embed)
                if (path == "/v/luna.m3u8") return MockResponse().setBody(master(generic()))
                if (path.startsWith("/?url=")) return MockResponse().setBody(bridge)
                return MockResponse().setResponseCode(404)
            }
        }
        return asked
    }

    @Test fun everyServerIsAskedAndCallistoAddsTheTeluguRows() = runBlocking {
        val asked = serveRrrAllServers()
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        assertEquals(listOf(emptyList(), listOf("Telugu"), listOf("Telugu")), rows.map(::labels))
        assertEquals(listOf("multimovies-5820588283537016992", "multimovies-5355663801620775816"), rows.drop(1).map { it.key })
        assertEquals(listOf("callisto", "default", "luna", "orion", "quantum", "quasar", "vega"), asked.sorted())
    }

    @Test fun embedPageServerListIsUsedAndCached() = runBlocking {
        val asked = serveRrrAllServers(embed = """<script>var C={"servers":[{"id":"callisto","name":"Callisto"},{"id":"nova","name":"Nova"}],"name":"RRR"}</script>""")
        MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        assertTrue(asked.toString(), "nova" in asked)
        asked.clear()
        val before = server.requestCount
        MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        // Cached list (callisto, nova) replaces the fallback list; luna is asked because the plain resolve named it.
        assertEquals(listOf("callisto", "default", "luna", "nova"), asked.sorted())
        assertTrue(server.requestCount - before < 10)
        assertEquals(listOf("orion", "luna"), MultiMoviesResolver.parseServerIds(""""servers":[{"id":"orion"},{"id":"bad id!"},{"id":"luna"}]"""))
        assertEquals(null, MultiMoviesResolver.parseServerIds("<html></html>"))
    }

    @Test fun aSlowServerDoesNotHoldTheResultPastTheSettleWindow() = runBlocking {
        serveRrrAllServers(slow = setOf("vega", "quantum"))
        val t0 = System.currentTimeMillis()
        val rows = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        val ms = System.currentTimeMillis() - t0
        assertEquals(3, rows.size)
        assertTrue("took ${ms}ms", ms < MultiMoviesResolver.SETTLE_MS + 1_500)
    }

    @Test fun http429PausesTheFanOutAndEveryErrorThrows() = runBlocking {
        val asked = serveRrrAllServers(status = mapOf("quasar" to 429))
        assertEquals(3, MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0).size)
        asked.clear()
        val second = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        assertEquals(listOf("default"), asked.toList())
        assertEquals(1, second.size)
        MultiMoviesResolver.resetServerState()
        serveRrrAllServers(status = (listOf("default") + MultiMoviesResolver.FALLBACK_SERVERS).associateWith { 500 })
        val failed = runCatching { MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0) }.exceptionOrNull()
        assertTrue(failed.toString(), failed is com.chitram.app.resolve.StepException)
    }

    // No per-title result cache on the device (only the server list and the 429
    // back-off are kept): a call where callisto was cut does not hide its Telugu
    // rows from the next call.
    @Test fun aCutServerIsAskedAgainOnTheNextResolve() = runBlocking {
        val bridge = Fixtures.read("multimovies/rrr-bridge-telugu.m3u8")
        val te = "/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F5820588283537016992_0_0_1080_h265_795%2Fmaster.m3u8"
        val callistoHits = java.util.concurrent.atomic.AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!
                return when {
                    path.startsWith("/api/resolve") && only(path) == "callisto" -> {
                        val r = MockResponse().setBody("""{"stream":{"server":"callisto","sources":[{"url":"$base$te","kind":"hls","language":"Telugu"}]}}""")
                        if (callistoHits.incrementAndGet() == 1) r.setHeadersDelay(6, java.util.concurrent.TimeUnit.SECONDS) else r
                    }
                    path.startsWith("/api/resolve") && only(path) == null ->
                        MockResponse().setBody("""{"stream":{"server":"luna","sources":[{"url":"$base/v/luna.m3u8","kind":"hls"}]}}""")
                    path.startsWith("/api/resolve") -> MockResponse().setBody("""{"stream":null}""")
                    path == "/v/luna.m3u8" -> MockResponse().setBody(master(generic()))
                    path.startsWith("/?url=") -> MockResponse().setBody(bridge)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        val first = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        assertEquals(listOf(emptyList<String>()), first.map(::labels))
        val again = MultiMoviesResolver(OkHttpClient(), origin = base).resolveAll("movie", 579974, 0, 0)
        assertEquals(2, callistoHits.get())
        assertEquals(listOf(emptyList(), listOf("Telugu")), again.map(::labels))
    }

    // ---- Per-server cooldown (owner ruling 2026-11-21) ---------------------------

    @Test fun threeUnheardAsksCoolAServerThenOneProbeDecides() = runBlocking {
        val resolver = MultiMoviesResolver(OkHttpClient(), origin = base)
        var asked = serveRrrAllServers(status = mapOf("quantum" to 500))
        repeat(3) { resolver.resolveAll("movie", 579974, 0, 0) }
        assertEquals(3, asked.count { it == "quantum" })
        assertTrue(MultiMoviesResolver.serverHealth("quantum").until > System.currentTimeMillis() + 59 * 60 * 1000L)
        asked.clear()
        assertEquals(3, resolver.resolveAll("movie", 579974, 0, 0).size)
        assertFalse("cooled server asked: $asked", "quantum" in asked)
        // Hour over, probe still fails: one ask, another hour.
        MultiMoviesResolver.endCooldown("quantum")
        asked.clear()
        resolver.resolveAll("movie", 579974, 0, 0)
        assertEquals(1, asked.count { it == "quantum" })
        assertEquals(4, MultiMoviesResolver.serverHealth("quantum").streak)
        asked.clear()
        resolver.resolveAll("movie", 579974, 0, 0)
        assertFalse("quantum" in asked)
        // Hour over, probe answers 2xx: streak cleared, asked every time again.
        MultiMoviesResolver.endCooldown("quantum")
        asked = serveRrrAllServers()
        resolver.resolveAll("movie", 579974, 0, 0)
        assertEquals(0, MultiMoviesResolver.serverHealth("quantum").streak)
        asked.clear()
        resolver.resolveAll("movie", 579974, 0, 0)
        assertTrue("quantum" in asked)
    }

    @Test fun callistoIsNeverCooled() = runBlocking {
        val asked = serveRrrAllServers(status = mapOf("callisto" to 500))
        val resolver = MultiMoviesResolver(OkHttpClient(), origin = base)
        repeat(5) { resolver.resolveAll("movie", 579974, 0, 0) }
        assertEquals(5, asked.count { it == "callisto" })
        assertEquals(0L, MultiMoviesResolver.serverHealth("callisto").until)
        assertEquals(5, MultiMoviesResolver.serverHealth("callisto").streak)
    }

    @Test fun a429NeitherAddsToNorClearsAServerStreak() = runBlocking {
        val resolver = MultiMoviesResolver(OkHttpClient(), origin = base)
        serveRrrAllServers(status = mapOf("vega" to 500))
        repeat(2) { resolver.resolveAll("movie", 579974, 0, 0) }
        assertEquals(2, MultiMoviesResolver.serverHealth("vega").streak)
        serveRrrAllServers(status = mapOf("vega" to 429))
        resolver.resolveAll("movie", 579974, 0, 0)
        assertEquals(2, MultiMoviesResolver.serverHealth("vega").streak)
        assertEquals(0L, MultiMoviesResolver.serverHealth("vega").until)
    }
}
