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
        )
        assertEquals(listOf("https://h/subs/en.vtt", "https://h/subs/te.srt"), PlayPolicy.sideloadable(subs).map { it.url })
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

    // ---- Fix 2d: 3 s connect timeout for direct hosts --------------------------

    @Test fun directHostsUseAThreeSecondConnectTimeout() {
        assertEquals(3_000, MultiMoviesResolver(OkHttpClient()).http.connectTimeoutMillis)
        assertEquals(3_000, StreamInterceptor.playerClient(OkHttpClient(), emptyMap(), null).connectTimeoutMillis)
    }

    // ---- Fix 2e: a row judged dead is never reported ok ------------------------

    @Test fun deadVerdictDoesNotMarkTheRowLanded() {
        val vm = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        assertFalse("DEAD must not set landed (checkRuntime would report ok)", Regex("""landed\s*=\s*true\s*//\s*judged""").containsMatchIn(vm))
        val runtime = vm.substringAfter("private fun checkRuntime()").substringBefore("report(s, ok = true")
        assertTrue("checkRuntime must skip a judged row", runtime.contains("judged"))
    }
}
