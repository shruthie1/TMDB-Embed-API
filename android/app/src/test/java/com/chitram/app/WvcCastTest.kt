package com.chitram.app

import android.content.ActivityNotFoundException
import com.chitram.app.data.Source
import com.chitram.app.player.PlayRequest
import com.chitram.app.player.WvcCast
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 1.2.0: Cast to TV hands the playing stream to Web Video Caster. */
class WvcCastTest {
    private fun src(url: String, progressive: Boolean = false, onDevice: String? = null, headers: Map<String, String> = emptyMap(), token: String? = null) =
        Source(
            id = url, provider = onDevice ?: "castle", label = "", url = url, progressive = progressive, quality = "1080p",
            levels = emptyList(), languages = listOf("Telugu"), selectableAudio = false, hybrid = false, subtitles = emptyList(),
            videoCodec = null, codecString = null, unsupported = false, onDevice = onDevice, headers = headers, segmentToken = token,
        )

    private val movie = PlayRequest("movie", 784572, "Krack", poster = "/p.jpg")

    @Test fun backendHlsRow() {
        val s = WvcCast.spec(src("https://vm.example/m3u8-proxy?url=x.m3u8"), movie)
        assertEquals("https://vm.example/m3u8-proxy?url=x.m3u8", s.url)
        assertEquals("application/x-mpegURL", s.mime)
        assertEquals("Krack", s.title)
        assertEquals("https://image.tmdb.org/t/p/w500/p.jpg", s.poster)
        // The VM already proxies backend rows: no headers, no hint.
        assertTrue(s.headers.isEmpty())
        assertNull(s.hint)
    }

    @Test fun progressiveRowIsMp4() {
        assertEquals("video/mp4", WvcCast.spec(src("https://cdn.example/a.mp4", progressive = true), movie).mime)
    }

    @Test fun episodeTitle() {
        val ep = PlayRequest("tv", 1, "Show", season = 2, episode = 5)
        assertEquals("Show S2 E5", WvcCast.spec(src("https://x/a.m3u8"), ep).title)
        assertNull(WvcCast.spec(src("https://x/a.m3u8"), ep).poster)
    }

    @Test fun onDeviceRowCarriesHeadersAndHint() {
        val h = mapOf("User-Agent" to "UA", "Referer" to "https://mapple.uk/", "Origin" to "https://mapple.uk", "Cookie" to "x")
        val s = WvcCast.spec(src("https://cdn.example/master.m3u8", onDevice = "mapple", headers = h), movie)
        assertEquals("https://cdn.example/master.m3u8", s.url)
        // Only the three headers the stream needs, nothing else from the resolver.
        assertEquals(mapOf("User-Agent" to "UA", "Referer" to "https://mapple.uk/", "Origin" to "https://mapple.uk"), s.headers)
        assertEquals(WvcCast.ROUTE_HINT, s.hint)
    }

    @Test fun constantsMatchWvcDocs() {
        // https://www.webvideocaster.com/integrations (Android Intents section).
        assertEquals("com.instantbits.cast.webvideo", WvcCast.PACKAGE)
        assertEquals("android.media.intent.extra.HTTP_HEADERS", WvcCast.EXTRA_HEADERS)
    }

    @Test fun launchesWvcWhenInstalled() {
        val tried = mutableListOf<WvcCast.Launch>()
        val spec = WvcCast.spec(src("https://x/a.m3u8"), movie)
        val out = WvcCast.launch(spec) { tried += it }
        assertEquals(listOf<WvcCast.Launch>(WvcCast.Launch.Wvc(spec)), tried)
        assertEquals(WvcCast.Launch.Wvc(spec), out)
    }

    @Test fun fallsBackToPlayStoreWhenMissing() {
        val tried = mutableListOf<WvcCast.Launch>()
        val out = WvcCast.launch(WvcCast.spec(src("https://x/a.m3u8"), movie)) {
            tried += it
            if (it is WvcCast.Launch.Wvc) throw ActivityNotFoundException()
        }
        assertEquals(WvcCast.Launch.Store("market://details?id=com.instantbits.cast.webvideo"), out)
        assertEquals(2, tried.size)
    }

    @Test fun fallsBackToStoreWebsiteWithoutPlayStore() {
        val out = WvcCast.launch(WvcCast.spec(src("https://x/a.m3u8"), movie)) {
            if (it is WvcCast.Launch.Wvc || (it as WvcCast.Launch.Store).uri.startsWith("market:")) throw ActivityNotFoundException()
        }
        assertEquals(WvcCast.Launch.Store("https://play.google.com/store/apps/details?id=com.instantbits.cast.webvideo"), out)
    }
}
