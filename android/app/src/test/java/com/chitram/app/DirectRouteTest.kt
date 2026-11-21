package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Ranking
import com.chitram.app.data.StreamsResponse
import com.chitram.app.player.DirectRoute
import com.chitram.app.player.FailPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner rule 2026-11-21 (routing-matrix.md): proxy only when required. The API
 * keeps the proxied `url` and adds `directUrl` + `directHeaders` + `route` when
 * the server's provider config allows direct. The APK plays direct with the
 * row's headers; a failure before the first frame retries the SAME row once
 * via the proxied url before failover.
 */
class DirectRouteTest {
    private val proxy = "https://vm.example/m3u8-proxy?url=https%3A%2F%2Fimg1.hscow.com%2Fa.m3u8"
    private val direct = "https://img1.hscow.com/a.m3u8"
    private val codecs = CodecSupport { _, _ -> true }

    private fun parse(row: String) = Api.json.decodeFromString(StreamsResponse.serializer(),
        """{"success":true,"count":1,"streams":[$row]}""").streams.single()

    private val castle = """{"url":"$proxy","provider":"CastleTV","container":"hls","languages":["Telugu","Hindi"],
        "directUrl":"$direct","directHeaders":{"User-Agent":"UA","Referer":"https://r.example/","X-N":5},
        "route":{"web":"direct","apk":"direct"}}"""

    @Test fun parsesDirectFieldsAndKeepsProxiedUrlAndLanguages() {
        val s = Ranking.toSource(parse(castle), 0, codecs)!!
        assertEquals(proxy, s.url)
        assertEquals(direct, s.directUrl)
        assertEquals(mapOf("User-Agent" to "UA", "Referer" to "https://r.example/", "X-N" to "5"), s.directHeaders)
        assertEquals(listOf("Telugu", "Hindi"), s.languages)
        assertFalse(s.progressive)
    }

    @Test fun apkProxyRouteGivesNoDirectUrl() {
        val raw = parse("""{"url":"$proxy","provider":"vidrock","directUrl":"$direct","route":{"web":"proxy","apk":"proxy"}}""")
        assertNull(Ranking.toSource(raw, 0, codecs)!!.directUrl)
    }

    @Test fun oldServerWithoutRouteGivesNoDirectUrl() {
        assertNull(Ranking.toSource(parse("""{"url":"$proxy","provider":"CastleTV"}"""), 0, codecs)!!.directUrl)
    }

    @Test fun forPlayPicksDirectWithHeaders() {
        val s = Ranking.toSource(parse(castle), 0, codecs)!!
        val p = DirectRoute.forPlay(s, emptySet())
        assertEquals(direct, p.url)
        assertEquals("https://r.example/", p.directHeaders["Referer"])
        assertEquals(s.directHeaders, p.headers)
        assertEquals(proxy, p.proxyUrl)
        assertEquals(s.id, p.id)
        assertTrue(DirectRoute.isDirect(p))
    }

    @Test fun forPlayKeepsProxyAfterADirectFailure() {
        val s = Ranking.toSource(parse(castle), 0, codecs)!!
        val failed = setOf(DirectRoute.key(s))
        assertSame(s, DirectRoute.forPlay(s, failed))
    }

    @Test fun forPlayLeavesRowsWithoutDirectAndOnDeviceRowsAlone() {
        val s = Ranking.toSource(parse("""{"url":"$proxy","provider":"CastleTV"}"""), 0, codecs)!!
        assertSame(s, DirectRoute.forPlay(s, emptySet()))
        val dev = Ranking.toSource(parse(castle), 0, codecs)!!.copy(onDevice = "castle")
        assertSame(dev, DirectRoute.forPlay(dev, emptySet()))
    }

    @Test fun proxyOfRestoresTheProxiedRowWithoutHeaders() {
        val s = Ranking.toSource(parse(castle), 0, codecs)!!
        val back = DirectRoute.proxyOf(DirectRoute.forPlay(s, emptySet()))
        assertEquals(proxy, back.url)
        assertEquals(emptyMap<String, String>(), back.headers)
        assertNull(back.proxyUrl)
        assertFalse(DirectRoute.isDirect(back))
        assertEquals(DirectRoute.key(s), DirectRoute.key(back))
    }

    @Test fun fallBackOnlyForDirectBeforeTheFirstFrame() {
        val d = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        assertTrue(DirectRoute.shouldFallBack(d, framed = false))
        assertFalse(DirectRoute.shouldFallBack(d, framed = true))
        assertFalse(DirectRoute.shouldFallBack(DirectRoute.proxyOf(d), framed = false))
        assertFalse(DirectRoute.shouldFallBack(null, framed = false))
        assertEquals(10_000L, DirectRoute.FIRST_FRAME_MS)
    }

    @Test fun netmirrorUnchangedRetryComparesTheProxiedIdentity() {
        val nm = Ranking.toSource(parse("""{"url":"https://vm.example/ts-proxy?url=a","provider":"NetMirror","container":"mp4",
            "directUrl":"https://bcdn.example/a.mp4","directHeaders":{"Referer":"https://r/"},"route":{"web":"proxy","apk":"direct"}}"""), 0, codecs)!!
        val playing = DirectRoute.forPlay(nm, emptySet())
        assertTrue(FailPolicy.unchangedNetmirrorRetry(playing, nm))
    }

    @Test fun logLineIsGreppable() {
        val d = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        assertEquals("[route] apk direct provider=CastleTV host=img1.hscow.com reason=config-direct",
            DirectRoute.logLine("direct", d, "reason=config-direct"))
    }

    // Review I4: "before the first frame" is a per-play flag, not object identity.
    // recordAudio replaces `current` with a copy on every tracks change.
    @Test fun aTracksChangeCopyKeepsTheTenSecondTimerArmed() {
        val d = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        val copy = d.copy(languages = listOf("Telugu"), audioLanguages = listOf("Telugu"), selectableAudio = false)
        assertTrue(DirectRoute.timerShouldFallBack(playing = copy, started = d, framedThisPlay = false))
    }

    @Test fun noFallBackAfterTheFirstFrameEvenOnACopy() {
        val d = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        val copy = d.copy(languages = listOf("Telugu"))
        assertFalse(DirectRoute.timerShouldFallBack(playing = copy, started = d, framedThisPlay = true))
        assertFalse(DirectRoute.shouldFallBack(copy, framed = true))
        assertTrue(DirectRoute.shouldFallBack(copy, framed = false))
    }

    @Test fun timerIgnoresARowThatIsNoLongerPlaying() {
        val d = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        val other = d.copy(id = "other-1")
        assertFalse(DirectRoute.timerShouldFallBack(playing = other, started = d, framedThisPlay = false))
        assertFalse(DirectRoute.timerShouldFallBack(playing = DirectRoute.proxyOf(d), started = d, framedThisPlay = false))
        assertFalse(DirectRoute.timerShouldFallBack(playing = null, started = d, framedThisPlay = false))
    }

    // Re-review m-B: on-device merge, the DONOR's request failed before the
    // first frame. That is the donor's fault: pairFailed (next donor) runs, and
    // the picture keeps its direct route.
    @Test fun aDonorRequestFailureIsBlamedOnTheDonorNotThePictureRoute() {
        val picture = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        val donor = Ranking.toSource(parse("""{"url":"https://vm.example/m3u8-proxy?url=https%3A%2F%2Fother.cdn%2Fte.m3u8","provider":"NetMirror","container":"hls","languages":["Telugu"]}"""), 1, codecs)!!
        assertTrue(DirectRoute.isDirect(picture))
        assertTrue(DirectRoute.donorAtFault("https://vm.example/ts-proxy?url=x&seg=1", picture, donor))
        assertFalse("the picture's own CDN failed", DirectRoute.donorAtFault("https://img1.hscow.com/a/1.ts", picture, donor))
        assertFalse("unknown request: keep the old order", DirectRoute.donorAtFault(null, picture, donor))
        assertFalse("no donor", DirectRoute.donorAtFault("https://vm.example/x", picture, null))
    }

    @Test fun sameHostForPictureAndDonorIsNotBlamedOnTheDonor() {
        val picture = Ranking.toSource(parse(castle), 0, codecs)!! // proxied form, vm.example
        val donor = Ranking.toSource(parse("""{"url":"https://vm.example/m3u8-proxy?url=b","provider":"NetMirror","container":"hls"}"""), 1, codecs)!!
        assertFalse(DirectRoute.donorAtFault("https://vm.example/ts-proxy?url=b", picture, donor))
    }

    // m-C: the donor plays from its pairAudio url, never its directUrl, so a
    // failure on the donor's direct host is not the donor's request.
    @Test fun aDonorsDirectHostIsNotTheDonorsRequest() {
        val picture = DirectRoute.forPlay(Ranking.toSource(parse(castle), 0, codecs)!!, emptySet())
        val donor = Ranking.toSource(parse("""{"url":"https://vm.example/m3u8-proxy?url=d","provider":"NetMirror","container":"hls",
            "directUrl":"https://donor.cdn/te.m3u8","route":{"web":"proxy","apk":"direct"}}"""), 1, codecs)!!
        assertEquals("https://donor.cdn/te.m3u8", donor.directUrl)
        assertFalse(DirectRoute.donorAtFault("https://donor.cdn/te/1.ts", picture, donor))
        assertTrue(DirectRoute.donorAtFault("https://vm.example/ts-proxy?url=d", picture, donor))
    }
}
