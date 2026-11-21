package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import com.chitram.app.data.TitleFull
import com.chitram.app.player.PlayPolicy
import com.chitram.app.player.ServerTag
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Owner 2026-11-21: sharper TMDB art, title logos, and review R2-M1/M3/M6. */
class ImagesAndMinorsTest {

    // ---- Image sizes --------------------------------------------------------

    @Test fun phoneSizesAreW500PostersAndW1280Backdrops() {
        assertEquals("https://image.tmdb.org/t/p/w500/p.jpg", Api.image("/p.jpg", Api.POSTER_PHONE))
        assertEquals("https://image.tmdb.org/t/p/w1280/b.jpg", Api.image("/b.jpg", Api.BACKDROP_PHONE))
        assertEquals("https://image.tmdb.org/t/p/w500/l.png", Api.image("/l.png", Api.LOGO))
    }

    @Test fun tvKeepsW342CardsAndUsesOriginalHero() {
        assertEquals("https://image.tmdb.org/t/p/w342/p.jpg", Api.image("/p.jpg", Api.POSTER_TV))
        assertEquals("https://image.tmdb.org/t/p/original/b.jpg", Api.image("/b.jpg", Api.BACKDROP_TV))
    }

    @Test fun originalDecodesNoLargerThanTheScreen() {
        // Fire TV 1080p: a 3640x2048 original is bounded to 1920x1080.
        assertEquals(1920 to 1080, Api.decodeBound(Api.BACKDROP_TV, 1920, 1080))
        assertEquals(3840 to 2160, Api.decodeBound("original", 3840, 2160))
        // Sized TMDB urls keep Coil's own view-size decode.
        assertNull(Api.decodeBound(Api.BACKDROP_PHONE, 1080, 2400))
        assertNull(Api.decodeBound(Api.POSTER_PHONE, 1080, 2400))
        // No screen size known: no bound rather than a 0x0 decode.
        assertNull(Api.decodeBound("original", 0, 0))
    }

    @Test fun titleFullCarriesTheLogoAndStaysCompatibleWithout() {
        val withLogo = Api.json.decodeFromString(TitleFull.serializer(), """{"tmdbId":579974,"title":"RRR","logo":"/hb.png"}""")
        assertEquals("/hb.png", withLogo.logo)
        val old = Api.json.decodeFromString(TitleFull.serializer(), """{"tmdbId":579974,"title":"RRR"}""")
        assertNull(old.logo)
    }

    // ---- R2-M1: Bengali, not "Bangla" -------------------------------------------

    @Test fun bengaliReadsBengaliNotBangla() {
        assertEquals("Bengali", Ranking.knownLanguageName("bn"))
        assertEquals("Bengali", Ranking.knownLanguageName("ben"))
        assertEquals("Bengali", Ranking.knownLanguageName("Bengali"))
        assertEquals("Bengali", Ranking.knownLanguageName("Bangla"))
        assertEquals("Bengali", Ranking.languageLabel("bn"))
        assertTrue(Ranking.sameLanguage("Bengali", "bn"))
        // Others unchanged.
        assertEquals("Telugu", Ranking.knownLanguageName("te"))
        assertEquals("Marathi", Ranking.knownLanguageName("mr"))
    }

    // ---- R2-M3: host tag length ------------------------------------------------------

    @Test fun hostTagKeepsHakunaymatataWhole() {
        assertEquals("hakunaymatata", ServerTag.host("https://cdn.hakunaymatata.com/v/1/index.m3u8"))
        assertEquals("nextgencloudfabric", ServerTag.host("https://nextgencloudfabric.com/x.m3u8"))
        // Inside the VM proxy the upstream host is the tag.
        assertEquals("hakunaymatata", ServerTag.host("https://vm/m3u8-proxy?url=https%3A%2F%2Fcdn.hakunaymatata.com%2Fv.m3u8"))
        assertEquals(ServerTag.MAX, ServerTag.host("https://${"a".repeat(30)}.com/x")!!.length)
    }

    // ---- R2-M6: a header-less VM row playing direct gets its short connect ----------

    private fun row(id: String, url: String) =
        Source(id, "multimovies", "multimovies", url, false, "1080p", emptyList(), listOf("Telugu"), false, false, emptyList(), null, null, false)

    @Test fun headerlessDirectRowDoesNotUseTheBaseClient() {
        val direct = row("d", "https://img.rousav.tech/m/index.m3u8").copy(proxyUrl = "https://vm/m3u8-proxy?url=x")
        assertTrue(direct.headers.isEmpty())
        assertFalse(PlayPolicy.usesBaseClient(direct, tsSwap = false))
        // The kept rule: 3 s only for a VM row playing direct (it has the proxy to fall back to).
        assertEquals(Api.DIRECT_CONNECT_TIMEOUT_MS, PlayPolicy.connectTimeoutMs(direct))
    }

    @Test fun proxiedVmRowStillUsesTheBaseClient() {
        val proxied = row("p", "https://vm/m3u8-proxy?url=x")
        assertTrue(PlayPolicy.usesBaseClient(proxied, tsSwap = false))
        assertFalse(PlayPolicy.usesBaseClient(proxied, tsSwap = true))
        assertFalse(PlayPolicy.usesBaseClient(proxied.copy(headers = mapOf("Referer" to "https://x/")), tsSwap = false))
        val device = proxied.copy(onDevice = "mapple")
        assertFalse(PlayPolicy.usesBaseClient(device, tsSwap = false))
        assertEquals(Api.DEVICE_CONNECT_TIMEOUT_MS, PlayPolicy.connectTimeoutMs(device))
    }
}
