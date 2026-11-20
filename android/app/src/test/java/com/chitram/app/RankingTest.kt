package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Level
import com.chitram.app.data.Ranking
import com.chitram.app.data.RawStream
import com.chitram.app.data.StreamsResponse
import com.chitram.app.player.MediaCodecSupport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RankingTest {
    private val all = CodecSupport { _, _ -> true }
    private val noHevc = CodecSupport { v, c -> if (MediaCodecSupport.familyOf(v, c) == "hevc") false else null }

    private fun raw(p: String, q: String, langs: List<String> = emptyList(), sel: Boolean = false, hybrid: Boolean = false, container: String = "hls", codec: String? = null) =
        RawStream(url = "https://h/$p-$q", provider = p, quality = q, languages = langs, selectableAudio = sel, hybrid = hybrid, container = container, videoCodec = codec)

    private fun rank(vararg r: RawStream, codecs: CodecSupport = all, pin: String? = null) =
        Ranking.fromResponse(StreamsResponse(streams = r.toList()), "Telugu", codecs, pin).map { "${it.provider}-${it.quality}" }

    @Test fun tiersBeatResolution() {
        val out = rank(
            raw("A", "1080p", listOf("Hindi")),
            raw("B", "720p", listOf("Telugu")),
            raw("C", "480p", listOf("Telugu", "Hindi"), sel = true),
            raw("D", "1080p", hybrid = true),
            raw("E", "2160p", listOf("Tamil", "Hindi"), sel = true),
        )
        assertEquals(listOf("D-1080p", "C-480p", "B-720p", "E-2160p", "A-1080p"), out)
    }

    @Test fun progressiveLosesWithinTierThenHeight() {
        val out = rank(
            raw("M", "1080p", listOf("Telugu"), container = "mp4"),
            raw("H", "720p", listOf("Telugu")),
            raw("H2", "1080p", listOf("Telugu")),
        )
        // 1.2.1 (U2): same tier keeps the server order, no height re-sort.
        assertEquals(listOf("H-720p", "H2-1080p", "M-1080p"), out)
    }

    @Test fun unsupportedCodecRanksLastButStays() {
        val out = rank(raw("mapple", "1080p", listOf("Telugu"), hybrid = true, codec = "hevc"), raw("X", "360p"), codecs = noHevc)
        assertEquals(listOf("X-360p", "mapple-1080p"), out)
        // On a device that decodes HEVC (Fire TV 4K) it keeps its tier.
        assertEquals(listOf("mapple-1080p", "X-360p"), rank(raw("mapple", "1080p", listOf("Telugu"), hybrid = true, codec = "hevc"), raw("X", "360p")))
    }

    @Test fun heightFromLevelsThenQuality() {
        val s = Ranking.toSource(RawStream(url = "u", quality = "Auto", levels = listOf(Level(480), Level(1080))), 0, all)!!
        assertEquals(1080, Ranking.height(s))
        assertEquals(720, Ranking.height(Ranking.toSource(RawStream(url = "u", quality = "720p"), 0, all)!!))
        assertEquals(0, Ranking.height(Ranking.toSource(RawStream(url = "u", quality = "Auto"), 0, all)!!))
    }

    @Test fun hlsDecidedByContainerNotUrl() {
        assertTrue(Ranking.isHls(RawStream(url = "https://x/m3u8-proxy?url=a.m3u8", container = "hls")))
        assertFalse(Ranking.isHls(RawStream(url = "https://x/ts-proxy?url=a.mp4", container = "mp4")))
        assertTrue(Ranking.isHls(RawStream(url = "https://x/m3u8-proxy?url=https%3A%2F%2Fa")))
    }

    @Test fun pinNeverOutranksSelectableAudio() {
        val out = rank(
            raw("Castle", "720p", listOf("Telugu", "Hindi"), sel = true),
            raw("Castle", "480p", listOf("Telugu")),
            raw("Net", "720p", listOf("Telugu")),
            raw("Other", "1080p"),
            pin = "Net",
        )
        assertEquals(listOf("Castle-720p", "Net-720p", "Castle-480p", "Other-1080p"), out)
    }

    @Test fun realStreamsFixtureTeluguFirst() {
        val r = Api.json.decodeFromString(StreamsResponse.serializer(), Fixtures.read("streams.json"))
        val ranked = Ranking.fromResponse(r, "Telugu", noHevc)
        assertEquals(r.streams.size, ranked.size) // nothing dropped
        assertTrue(ranked.first().languages.contains("Telugu"))
        assertEquals("720p", ranked.first().quality)
        assertEquals("mapple", ranked.last().provider) // HEVC last when not decodable
        val withHevc = Ranking.fromResponse(r, "Telugu", all)
        assertTrue(withHevc.last().provider != "mapple" || withHevc.size == 1)
    }

    @Test fun labelsNumberRepeats() {
        val s = Ranking.fromResponse(StreamsResponse(streams = listOf(raw("A", "720p"), raw("A", "480p"), raw("B", "720p"))), "Telugu", all)
        assertEquals(listOf("A 1", "A 2", "B"), Ranking.labels(s).let { l -> s.indices.map { l[it] } }.sortedBy { it })
    }

    @Test fun audioFromOtherSources() {
        val s = Ranking.fromResponse(StreamsResponse(streams = listOf(
            raw("A", "720p", listOf("Telugu")), raw("B", "720p", listOf("Hindi")),
            raw("C", "480p", listOf("Hindi")), raw("D", "720p", listOf("Tamil", "Kannada"), sel = true),
        )), "Telugu", all)
        val cur = s.first { it.provider == "A" }
        val langs = Ranking.otherSourceLanguages(s, cur.id, setOf("Telugu")).map { it.first }
        assertEquals(listOf("Tamil", "Kannada", "Hindi"), langs)
    }

    // Regression: Kubera crashed with "Key src:CastleTV-0 was already used" when
    // the audio sheet opened. A selectable-audio source offers several languages,
    // so keying the menu row by src:<id> alone repeats and the LazyColumn throws.
    // audioItems() keys each cross-source language src:<id>:<lang>; assert unique.
    @Test fun audioMenuKeysUniquePerLanguage() {
        val s = Ranking.fromResponse(StreamsResponse(streams = listOf(
            raw("A", "720p", listOf("Telugu")),
            raw("CastleTV", "1080p", listOf("Telugu", "Hindi", "Tamil"), sel = true),
        )), "Telugu", all)
        val cur = s.first { it.provider == "A" }
        val keys = Ranking.otherSourceLanguages(s, cur.id, setOf("Telugu"))
            .map { (lang, src) -> "src:${src.id}:$lang" }
        assertEquals(keys.size, keys.toSet().size)  // no duplicate LazyColumn keys
        assertEquals(listOf("src:CastleTV-1:Hindi", "src:CastleTV-1:Tamil"), keys)
    }

    @Test fun codecFamily() {
        assertEquals("hevc", MediaCodecSupport.familyOf(null, "hvc1.1.6.L93.B0,mp4a.40.2"))
        assertEquals("avc", MediaCodecSupport.familyOf(null, "avc1.640028"))
        assertEquals(null, MediaCodecSupport.familyOf(null, null))
        assertEquals("hevc", MediaCodecSupport.familyOf("HEVC", null))
    }
}
