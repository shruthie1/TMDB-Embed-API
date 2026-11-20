package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Ranking
import com.chitram.app.data.StreamsResponse
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

/** The HTTP DTO, source adapter and audio menu must agree on what can actually play. */
class NetmirrorAudioMetadataTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val codecs = CodecSupport { _, _ -> null }
    private fun rows(body: String) = json.decodeFromString<StreamsResponse>(body).streams

    @Test fun catalogLanguageDoesNotBecomeAnAudioTrack() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://cdn.test/master.m3u8","container":"hls","languages":["Telugu","Hindi"],"catalogLanguages":["Telugu","Hindi","Tamil"],"audio":[{"language":"Hindi"}],"selectableAudio":true}]}""").single()
        val source = Ranking.toSource(raw, 0, codecs)!!
        val menu = Ranking.otherSourceLanguages(listOf(source), null, emptySet())
        assertEquals(listOf("Hindi"), menu.map { it.first })
        assertEquals("phantom Telugu must not outrank a real language", 3, Ranking.tier(source, "Telugu"))
    }

    @Test fun explicitlyEmptyRenditionsCannotOfferCatalogLanguages() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://cdn.test/master.m3u8","languages":["Telugu","Hindi"],"audio":[],"selectableAudio":true}]}""").single()
        val source = Ranking.toSource(raw, 0, codecs)!!
        assertTrue(Ranking.otherSourceLanguages(listOf(source), null, emptySet()).isEmpty())
        assertFalse(source.selectableAudio)
    }

    @Test fun netmirrorIdentityDoesNotDependOnResultArrayIndex() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://proxy.test/m3u8-proxy?url=nf.m3u8","quality":"Auto"},{"provider":"NetMirror","url":"https://proxy.test/m3u8-proxy?url=pv.m3u8","quality":"Auto"}]}""")
        val nf = Ranking.toSource(raw[0], 9, codecs)!!
        val pv = Ranking.toSource(raw[1], 9, codecs)!!
        assertEquals(nf.id, Ranking.toSource(raw[0], 0, codecs)!!.id)
        assertNotEquals(nf.id, pv.id)
        assertFalse("audio menu ids use ':' as separators", nf.id.contains(':'))
    }
    @Test fun realRenditionsAreKeptWhileCatalogAvailabilityStaysReadOnly() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://cdn.test/multi.m3u8","languages":["Tamil"],"catalogLanguages":["Telugu","Hindi","Tamil"],"audio":[{"language":"Hindi","codec":"aac"},{"language":"Telugu","channels":2},{"language":"Hindi"}],"selectableAudio":true}]}""").single()
        val source = Ranking.toSource(raw, 0, codecs)!!
        assertEquals(listOf("Hindi", "Telugu"), source.audioLanguages)
        assertEquals(listOf("Hindi", "Telugu"), source.languages)
        assertEquals(listOf("Telugu", "Hindi", "Tamil"), source.catalogLanguages)
        assertEquals(listOf("Hindi", "Telugu"), Ranking.otherSourceLanguages(listOf(source), null, emptySet()).map { it.first })
        assertEquals(listOf("Telugu"), Ranking.otherSourceLanguages(listOf(source), null, setOf("Hindi")).map { it.first })
        assertTrue(Ranking.otherSourceLanguages(listOf(source), source.id, emptySet()).isEmpty())
    }

    @Test fun knownSingleLanguageFileRemainsAWholeSourceChoice() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://cdn.test/one.m3u8","languages":["Telugu"],"catalogLanguages":["Telugu","Hindi"],"audio":[],"selectableAudio":false}]}""").single()
        val source = Ranking.toSource(raw, 0, codecs)!!
        assertEquals(emptyList<String>(), source.audioLanguages)
        assertFalse(source.selectableAudio)
        assertEquals(listOf("Telugu"), Ranking.otherSourceLanguages(listOf(source), null, emptySet()).map { it.first })
        assertEquals(2, Ranking.tier(source, "Telugu"))
    }

    @Test fun absentAudioMetadataRetainsLegacyOtherProviderBehavior() {
        val raw = rows("""{"streams":[{"provider":"CastleTV","url":"https://cdn.test/legacy.m3u8","languages":["Hindi","Telugu"],"selectableAudio":true}]}""").single()
        val source = Ranking.toSource(raw, 4, codecs)!!
        assertNull(source.audioLanguages)
        assertEquals("CastleTV-4", source.id)
        assertEquals(listOf("Hindi", "Telugu"), Ranking.otherSourceLanguages(listOf(source), null, emptySet()).map { it.first })
    }

    @Test fun netmirrorQualitiesHaveDistinctIdsAndRepeatedRepliesMergeOnce() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://cdn.test/file.mp4?signature=one","quality":"720p","languages":["Telugu"]}]}""").single()
        val first = Ranking.toSource(raw, 0, codecs)!!
        val second = Ranking.toSource(raw.copy(quality = "1080p"), 0, codecs)!!
        assertNotEquals(first.id, second.id)
        val aggregate = listOf(first, second)
        val supplemental = Ranking.toSource(raw, 11, codecs)!!
        val merged = Ranking.merge(aggregate, listOf(supplemental), "Telugu", null)
        assertEquals(2, merged.size)
        assertEquals(2, merged.map { it.id }.distinct().size)
    }

    @Test fun providerSpecificPartialAnswerKeepsRowsAndRequestsCompletion() {
        val response = json.decodeFromString<StreamsResponse>("""{"success":true,"providerError":"netmirror-budget","streams":[{"provider":"NetMirror","url":"https://cdn.test/known.m3u8","languages":["Telugu"]}]}""")
        assertTrue(response.wantsFull)
        assertEquals(1, Ranking.fromResponse(response, "Telugu", codecs).size)
        assertFalse(response.copy(providerError = null).wantsFull)
    }

    @Test fun isoCodesDoNotDuplicateCurrentHumanLanguageNames() {
        val raw = rows("""{"streams":[{"provider":"MultiMovies","url":"https://cdn.test/legacy.m3u8","languages":["Ces","Fil","Hun","Ita","Pol"],"selectableAudio":true}]}""").single()
        val source = Ranking.toSource(raw, 0, codecs)!!
        assertEquals(listOf("Czech", "Filipino", "Hungarian", "Italian", "Polish"), source.languages)
        val choices = Ranking.otherSourceLanguages(listOf(source), null, setOf("Czech", "Filipino"))
        assertEquals(listOf("Hungarian", "Italian", "Polish"), choices.map { it.first })
        // Manually constructed/on-device Source rows take the same menu path.
        val older = source.copy(languages = listOf("Ces", "Fil", "Ita"))
        assertEquals(listOf("Italian"), Ranking.otherSourceLanguages(listOf(older), null, setOf("Czech", "Filipino")).map { it.first })
    }

    @Test fun actualAudioCodesNormalizeWithoutInventingUnknownLanguages() {
        val raw = rows("""{"streams":[{"provider":"NetMirror","url":"https://cdn.test/real.m3u8","audio":[{"language":"ces"},{"language":"cs"},{"language":"fil"},{"language":"und"},{"language":"mul"},{"language":"zxx"}],"catalogLanguages":["Ces","Czech","Fil","Portuguese (Brazil)"],"selectableAudio":true}]}""").single()
        val source = Ranking.toSource(raw, 0, codecs)!!
        assertEquals(listOf("Czech", "Filipino"), source.audioLanguages)
        assertEquals(listOf("Czech", "Filipino"), source.languages)
        assertEquals(listOf("Czech", "Filipino", "Portuguese (Brazil)"), source.catalogLanguages)
        assertEquals(1, Ranking.tier(source, "ces"))
        assertTrue(Ranking.otherSourceLanguages(listOf(source), null, setOf("cs", "Filipino")).isEmpty())
        assertEquals("Portuguese", Ranking.languageLabel("pt-BR"))
        assertEquals("Portuguese (Brazil)", Ranking.languageLabel("Portuguese (Brazil)"))
        assertNull(Ranking.languageLabel("und"))
        assertNull(Ranking.languageLabel("mul"))
    }

}
