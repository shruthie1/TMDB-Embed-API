package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.LastProviderStore
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Ranking
import com.chitram.app.data.RawStream
import com.chitram.app.data.StreamsResponse
import com.chitram.app.player.LoadingModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A8: 1.2.1 resumed Mirayi (1222479) and showed "CastleTV · Hindi". The row
 * had Telugu (VM lists Hindi first). Resume must prefer the viewer's language
 * unless the viewer picked that source by hand.
 */
class V122Test {
    private val all = CodecSupport { _, _ -> true }
    private fun raw(p: String, q: String, langs: List<String> = emptyList(), sel: Boolean = false) =
        RawStream(url = "https://h/$p-$q", provider = p, quality = q, languages = langs, selectableAudio = sel, container = "hls")

    private fun rank(vararg r: RawStream, pin: String?, manual: Boolean) =
        Ranking.fromResponse(StreamsResponse(streams = r.toList()), "Telugu", all, pin, manual = manual).map { "${it.provider}-${it.quality}" }

    @Test fun autoPinNeverLiftsAnotherLanguageOverTelugu() {
        val out = rank(
            raw("OneTouchTV", "720p", listOf("Telugu")),
            raw("CastleTV", "1080p", listOf("Hindi")),
            pin = "CastleTV", manual = false,
        )
        assertEquals(listOf("OneTouchTV-720p", "CastleTV-1080p"), out)
    }

    @Test fun autoPinStillLeadsInsideTelugu() {
        val out = rank(
            raw("OneTouchTV", "720p", listOf("Telugu")),
            raw("CastleTV", "1080p", listOf("Telugu")),
            pin = "CastleTV", manual = false,
        )
        assertEquals(listOf("CastleTV-1080p", "OneTouchTV-720p"), out)
    }

    @Test fun manualPinWins() {
        val out = rank(
            raw("OneTouchTV", "720p", listOf("Telugu")),
            raw("CastleTV", "1080p", listOf("Hindi")),
            pin = "CastleTV", manual = true,
        )
        assertEquals(listOf("CastleTV-1080p", "OneTouchTV-720p"), out)
    }

    @Test fun pinStoreKeepsTheManualFlag() {
        val s = LastProviderStore(MemoryKeyValue())
        s.put("movie", 1222479, "CastleTV", manual = true)
        assertEquals(LastProviderStore.Pin("CastleTV", true), s.get("movie", 1222479))
        s.put("movie", 1222479, "OneTouchTV", manual = false)
        assertEquals(LastProviderStore.Pin("OneTouchTV", false), s.get("movie", 1222479))
    }

    @Test fun pinStoreReadsTheOldPlainValueAsAuto() {
        val kv = MemoryKeyValue()
        kv.put("lastProvider:movie:1222479", "CastleTV")
        assertEquals(LastProviderStore.Pin("CastleTV", false), LastProviderStore(kv).get("movie", 1222479))
    }

    /** The Mirayi row from the one /api/streams/movie/1222479 call on 2026-11-20. */
    @Test fun mirayiRowLabelsTelugu() {
        val r = Api.json.decodeFromString(StreamsResponse.serializer(), Fixtures.read("streams-1222479.json"))
        val ranked = Ranking.fromResponse(r, "Telugu", all, "CastleTV", manual = false)
        val top = ranked.first()
        assertEquals("CastleTV", top.provider)
        assertTrue(top.selectableAudio)
        assertEquals("Hindi", top.languages.first())
        // Before the tracks load the pill showed languages.first() = Hindi; it must show what will play.
        assertEquals("Telugu", LoadingModel.langOf(top, "Telugu"))
        assertFalse(ranked.take(3).any { "Telugu" !in it.languages })
    }
}
