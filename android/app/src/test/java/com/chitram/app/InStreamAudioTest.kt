package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.DataReader
import androidx.media3.common.Format
import androidx.media3.common.util.ParsableByteArray
import androidx.media3.common.util.TimestampAdjuster
import androidx.media3.extractor.DefaultExtractorInput
import androidx.media3.extractor.ExtractorOutput
import androidx.media3.extractor.PositionHolder
import androidx.media3.extractor.SeekMap
import androidx.media3.extractor.TrackOutput
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.extractor.ts.TsExtractor
import androidx.media3.extractor.ts.TsPayloadReader
import com.chitram.app.data.Source
import com.chitram.app.player.AudioChoice
import com.chitram.app.data.Ranking
import com.chitram.app.resolve.TsAudio
import com.chitram.app.resolve.TsAudioSwap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Vidrock/CastleTV single-variant rows mux five AAC tracks in one TS
 * (Jailer 937020: PMT tags hin/tam/tel/mal/kan, server fixture copied from
 * test/fixtures). Runs media3's own TsExtractor on the fixture to prove what
 * the player sees, then the in-stream pick on top of it.
 */
class InStreamAudioTest {
    private fun bytes(name: String) = javaClass.classLoader!!.getResource("fixtures/$name")!!.readBytes()

    /** Audio languages (PMT order of creation) the extractor builds a track for in [mode]. */
    private fun audioTracks(b: ByteArray, mode: Int): List<String?> {
        val made = ArrayList<String?>()
        val base = DefaultTsPayloadReaderFactory()
        val factory = object : TsPayloadReader.Factory {
            override fun createInitialPayloadReaders() = base.createInitialPayloadReaders()
            override fun createPayloadReader(streamType: Int, esInfo: TsPayloadReader.EsInfo): TsPayloadReader? {
                val inner = base.createPayloadReader(streamType, esInfo) ?: return null
                if (streamType != 0x0f) return inner
                // Record the language only when the extractor really wires this reader to an output.
                return object : TsPayloadReader by inner {
                    override fun init(t: TimestampAdjuster, o: ExtractorOutput, id: TsPayloadReader.TrackIdGenerator) {
                        made += esInfo.language
                        inner.init(t, o, id)
                    }
                }
            }
        }
        val ex = TsExtractor(mode, TimestampAdjuster(0), factory)
        ex.init(Output())
        var at = 0
        val reader = object : DataReader {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (at >= b.size) return C.RESULT_END_OF_INPUT
                val n = minOf(length, b.size - at)
                System.arraycopy(b, at, buffer, offset, n); at += n
                return n
            }
        }
        val input = DefaultExtractorInput(reader, 0, b.size.toLong())
        val pos = PositionHolder()
        while (ex.read(input, pos) == androidx.media3.extractor.Extractor.RESULT_CONTINUE) Unit
        return made
    }

    private class Output : ExtractorOutput {
        override fun track(id: Int, type: Int): TrackOutput = object : TrackOutput {
            override fun format(format: Format) {}
            override fun sampleData(input: DataReader, length: Int, allowEndOfInput: Boolean, sampleDataPart: Int): Int {
                val skip = ByteArray(length); return input.read(skip, 0, length)
            }
            override fun sampleData(data: ParsableByteArray, length: Int, sampleDataPart: Int) { data.skipBytes(length) }
            override fun sampleMetadata(timeUs: Long, flags: Int, size: Int, offset: Int, cryptoData: TrackOutput.CryptoData?) {}
        }
        override fun endTracks() {}
        override fun seekMap(seekMap: SeekMap) {}
    }

    @Test fun extractorSeesFiveTaggedAacTracksInOneTs() {
        val b = bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        assertEquals(listOf("hin", "tam", "tel", "mal", "kan"), audioTracks(b, TsExtractor.MODE_SINGLE_PMT))
    }

    /** HLS runs TsExtractor in MODE_HLS: one track per stream type, so the player can never select Telugu by itself. */
    @Test fun hlsModeKeepsOnlyTheFirstAacTrack() {
        val b = bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        assertEquals(listOf("hin"), audioTracks(b, TsExtractor.MODE_HLS))
    }

    /** The in-stream pick: TsAudio swaps Telugu into the first AAC slot, so MODE_HLS exposes Telugu, tagged tel. */
    @Test fun swapMakesHlsModeExposeTelugu() {
        val b = bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        assertEquals(listOf("hin", "tam", "tel", "mal", "kan"), TsAudio.probe(b)!!.map { it.lang })
        assertTrue(TsAudio.apply(b, "tel"))
        assertEquals(listOf("tel"), audioTracks(b, TsExtractor.MODE_HLS))
        assertEquals(listOf("tel", "tam", "hin", "mal", "kan"), TsAudio.probe(b)!!.map { it.lang })
    }

    @Test fun untaggedFileOffersNoLanguage() {
        val b = bytes("vidrock-pmt-und.ts")
        assertTrue(TsAudio.probe(b)!!.all { it.lang == null })
        assertFalse(TsAudio.apply(b, "tel"))
        assertEquals(emptyList<String>(), TsAudioSwap.fileLanguages(TsAudio.probe(b)!!))
    }

    private fun row(provider: String, langs: List<String>, selectable: Boolean = false, progressive: Boolean = false, languageSource: String? = null) = Source(
        id = "$provider-0", provider = provider, label = provider, url = "https://h/x.m3u8", progressive = progressive, quality = "1080p",
        levels = emptyList(), languages = langs, selectableAudio = selectable, hybrid = false, subtitles = emptyList(),
        videoCodec = null, codecString = null, unsupported = false, languageSource = languageSource)

    private val five = listOf("Hindi", "Tamil", "Telugu", "Malayalam", "Kannada")

    @Test fun muxedRowOffersEveryFileLanguage() {
        val vid = row("vidrock", five)
        assertTrue(TsAudioSwap.wanted(vid))
        assertEquals(five, AudioChoice.languages(vid))
        assertEquals(listOf(vid), AudioChoice.candidates(listOf(vid), "Telugu"))
        assertEquals(five, Ranking.otherSourceLanguages(listOf(vid), null, emptySet()).map { it.first })
        assertEquals(vid to "Telugu", AudioChoice.source("src:vidrock-0:Telugu", listOf(vid)))
    }

    @Test fun singleLanguageAndProgressiveRowsAreNotMuxed() {
        assertFalse(TsAudioSwap.wanted(row("vidrock", listOf("Hindi"))))
        assertFalse(TsAudioSwap.wanted(row("x", five, progressive = true)))
        assertFalse(TsAudioSwap.wanted(row("x", five, selectable = true)))
        assertEquals(listOf("Hindi"), AudioChoice.languages(row("x", five, progressive = true)))
    }

    @Test fun muxedRowRanksInTheTeluguTier() {
        val hindi = row("other", listOf("Hindi"))
        val vid = row("vidrock", five)
        assertEquals(listOf(vid, hindi), Ranking.rank(listOf(hindi, vid), "Telugu"))
    }

    @Test fun swapNotesThePickOnceAndTheFileLanguages() {
        val b = bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        val picked = ArrayList<String>()
        val swap = TsAudioSwap("Telugu") { picked += it }
        swap.onSegment(b)
        swap.onSegment(bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts"))
        assertEquals(listOf("Telugu"), picked)
        assertEquals(five, swap.languages)
        assertEquals(listOf("tel"), audioTracks(b, TsExtractor.MODE_HLS))
    }

    @Test fun languageMissingFromFileIsNeverPicked() {
        val picked = ArrayList<String>()
        val swap = TsAudioSwap("English") { picked += it }
        val b = bytes("vidrock-pmt-hin-tam-tel-mal-kan.ts")
        swap.onSegment(b)
        assertEquals(emptyList<String>(), picked)
        assertEquals(listOf("hin"), audioTracks(b, TsExtractor.MODE_HLS))
    }

    /** Unknown beats wrong: a non-selectable row of another provider may carry catalog languages. */
    @Test fun otherProvidersKeepTheirFirstLanguageUnlessTheServerSaysPmt() {
        val ott = row("OneTouchTV", five)
        assertFalse(TsAudioSwap.wanted(ott))
        assertEquals(listOf("Hindi"), AudioChoice.languages(ott))
        assertTrue(TsAudioSwap.wanted(row("newhost", five, languageSource = "ts-pmt")))
    }

    @Test fun audioSheetOffersTheFileLanguagesInThisStream() {
        val vid = row("vidrock", five)
        val other = row("gd", listOf("Telugu"), selectable = true)
        val menu = com.chitram.app.player.PlayerVm.audioMenu(emptyList(), listOf(vid, other), vid, null, "Telugu")
        val inStream = menu.filter { it.group == com.chitram.app.player.PlayerVm.IN_STREAM }
        assertEquals(listOf("cur", "src:vidrock-0:Hindi", "src:vidrock-0:Tamil", "src:vidrock-0:Malayalam", "src:vidrock-0:Kannada"), inStream.map { it.key })
        assertTrue(inStream.first().selected)
        assertTrue(com.chitram.app.player.PlayerVm.muxedCarries(vid, "Tamil"))
        assertFalse(com.chitram.app.player.PlayerVm.muxedCarries(vid, "English"))
        assertFalse(com.chitram.app.player.PlayerVm.muxedCarries(other, "Telugu"))
    }
}
