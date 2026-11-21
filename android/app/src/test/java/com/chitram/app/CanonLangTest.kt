package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.chitram.app.data.Ranking
import com.chitram.app.player.HybridPair
import com.chitram.app.player.PlayerVm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Task 7: one canonical audio-language compare, same rule as server canonicalLanguage and web audioLanguageKey. */
class CanonLangTest {
    @Test fun teluguSpellingsAreOneKey() {
        val key = Ranking.canonLang("te")
        assertEquals("telugu", key)
        for (v in listOf("tel", "Telugu", "TELUGU", "telugu", "tel-IN", "te-IN", "tel_IN", " Telugu ", "Telugu-IN")) {
            assertEquals(v, key, Ranking.canonLang(v))
        }
        assertEquals("Telugu", Ranking.languageLabel("TELUGU"))
        assertNotEquals(key, Ranking.canonLang("en"))
        assertFalse(Ranking.sameLanguage("Telugu", "English"))
        assertTrue(Ranking.sameLanguage("tel-IN", "te"))
    }

    @Test fun nullAndUntaggedAreNotALanguage() {
        assertNull(Ranking.canonLang(null))
        assertNull(Ranking.canonLang(""))
        assertNull(Ranking.canonLang("und"))
        assertFalse(Ranking.sameLanguage(null, null))
        assertFalse(Ranking.sameLanguage("und", "und"))
    }

    @Test fun onlyRegionOrScriptSubtagsStrip() {
        assertEquals("Hindi", Ranking.languageLabel("hi-IN"))
        assertEquals("Chinese", Ranking.languageLabel("zh-Hant"))
        assertEquals("Spanish", Ranking.languageLabel("es-419"))
        assertEquals("pt-BR", Ranking.languageLabel("pt-BR"))
        assertFalse(Ranking.sameLanguage("pt-BR", "Portuguese"))
        assertEquals("Telugu-Hindi", Ranking.languageLabel("Telugu-Hindi"))
        assertFalse(Ranking.sameLanguage("Telugu-Hindi", "Telugu"))
        assertEquals("eng-sub", Ranking.languageLabel("eng-sub"))
    }

    @Test fun trackNamesWithUnknownTag() {
        assertEquals("Telugu", Ranking.languageFromTrackName("Telugu 5.1"))
        assertEquals("Telugu", Ranking.languageFromTrackName("telugu dolby"))
        assertEquals("Telugu", Ranking.languageFromTrackName("TEL - Stereo"))
        assertEquals("Telugu", Ranking.languageFromTrackName("[2] Telugu (AAC)"))
        // Lower-case short words are never codes.
        assertEquals("per track", Ranking.languageFromTrackName("per track"))
        assertEquals("it de", Ranking.languageFromTrackName("it de"))
        assertNull(Ranking.languageFromTrackName("Audio"))
        assertNull(Ranking.languageFromTrackName("Track 2"))
        assertEquals("Telugu", Ranking.trackLanguage("und", "Telugu 5.1"))
        assertEquals("Hindi", Ranking.trackLanguage("hi", "Telugu"))
    }

    @Test fun codecWordsInTrackNamesAreNotLanguages() {
        assertEquals("Telugu", Ranking.languageFromTrackName("HE-AAC Telugu"))
        assertEquals("Telugu", Ranking.languageFromTrackName("5.1 CH Telugu"))
        assertEquals("Telugu", Ranking.languageFromTrackName("2CH Telugu"))
        assertEquals("HE-AAC Stereo", Ranking.languageFromTrackName("HE-AAC Stereo"))
        assertEquals("Telugu", Ranking.languageFromTrackName("TEL - Stereo"))
        assertEquals("DD 5.1", Ranking.languageFromTrackName("DD 5.1"))
    }

    @Test fun underscoreIsAHyphen() {
        assertEquals(Ranking.canonLang("pt-BR"), Ranking.canonLang("pt_BR"))
        assertTrue(Ranking.sameLanguage("pt_BR", "pt-BR"))
        assertTrue(Ranking.sameLanguage("tel_IN", "Telugu"))
    }

    @Test fun preferenceMatchesTagOrLabelButDisplayKeepsTag() {
        assertTrue(Ranking.trackMatches("hi", "Telugu", "Telugu"))
        assertTrue(Ranking.trackMatches("hi", "Telugu", "hi"))
        assertEquals("Hindi", Ranking.trackLanguage("hi", "Telugu"))
        assertFalse(Ranking.trackMatches("hi", "Audio", "Telugu"))
        assertTrue(PlayerVm.carries(listOf(group("a", audio("hi", "Telugu"))), "Telugu"))
        val tracks = Tracks(listOf(group("0:main", video()), group("1:a", audio("tam")), group("1:b", audio("hi", "Telugu"))))
        assertEquals("1:b", HybridPair.overrides(tracks, listOf("Telugu"))!!.second.mediaTrackGroup.id)
    }

    @Test fun nextAliveUsesTheSameKey() {
        fun row(id: String, langs: List<String>) = com.chitram.app.data.Source(id, "P", id, "https://x/$id.m3u8", false, "720p",
            emptyList(), langs, false, false, emptyList(), null, null, false)
        val pick = com.chitram.app.player.PlayPolicy.nextAlive(listOf(row("a", listOf("Hindi")), row("b", listOf("te"))), emptySet(), "Telugu", null)
        assertEquals("b", pick?.id)
    }

    private fun group(id: String, vararg f: Format, selected: Int = -1) = Tracks.Group(
        TrackGroup(id, *f), f.size > 1, IntArray(f.size) { C.FORMAT_HANDLED }, BooleanArray(f.size) { it == selected },
    )
    private fun video() = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setHeight(720).setWidth(1280).build()
    private fun audio(lang: String?, label: String? = null) =
        Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).setLabel(label).build()

    @Test fun hybridOverridesMatchEverySpelling() {
        for (want in listOf(listOf("te"), listOf("tel"), listOf("Telugu"), listOf("TELUGU"), listOf("tel-IN"))) {
            val tracks = Tracks(listOf(group("0:main", video()), group("1:hin", audio("hin")), group("1:tel", audio("tel-IN"))))
            assertEquals(want.toString(), "1:tel", HybridPair.overrides(tracks, want)!!.second.mediaTrackGroup.id)
        }
        // und tag, language only in the label.
        val named = Tracks(listOf(group("0:main", video()), group("1:a", audio("hin")), group("1:b", audio("und", "Telugu 5.1"))))
        assertEquals("1:b", HybridPair.overrides(named, listOf("Telugu"))!!.second.mediaTrackGroup.id)
        // Step 2 Task 6 ruling: no any-track fallback. No Telugu track means no pick (a failed try).
        val none = Tracks(listOf(group("0:main", video()), group("1:a", audio("hin")), group("1:b", audio("tam"))))
        assertNull(HybridPair.overrides(none, listOf("Telugu")))
    }

    @Test fun playerCarriesAndLoadingUseTheSameKey() {
        assertTrue(PlayerVm.carries(listOf(group("a", audio("tel"))), "TELUGU"))
        assertTrue(PlayerVm.carries(listOf(group("a", audio("und", "TEL - Stereo"))), "te"))
        assertFalse(PlayerVm.carries(listOf(group("a", audio("hin"))), "Telugu"))
        assertTrue(PlayerVm.isoFor("Bengali").contains("bn"))
        assertTrue(Ranking.sameLanguage("Bengali", "bn"))
        assertTrue(Ranking.sameLanguage("ben", "Bengali"))
        assertEquals("Telugu", PlayerVm.langName("tel"))
    }

    // Final-review I1 (2026-11-21): providers copy an und rendition's NAME into
    // `language` ("Telugu 5.1"). Same rule as server streamSchema and web languageSources.
    @Test fun unresolvedTagIsReadAsTrackName() {
        assertEquals("Telugu", Ranking.trackLanguage("Telugu 5.1", null))
        assertEquals("Hindi", Ranking.trackLanguage("Hindi AAC 2.0", null))
        assertEquals("Telugu", Ranking.trackLanguage("TEL", "Main"))
        assertEquals("Telugu", Ranking.trackLanguage("Commentary", "Telugu 5.1"))
        assertEquals("Telugu", Ranking.trackLanguage("und", "Telugu 5.1"))
        assertTrue(Ranking.trackMatches("Telugu 5.1", null, "te"))
    }

    @Test fun codecOnlyLabelIsNeverALanguage() {
        assertNull(Ranking.trackNameLanguage("AAC 5.1"))
        assertNull(Ranking.trackNameLanguage("HE-AAC 5.1"))
        assertNull(Ranking.languageCode(Ranking.trackLanguage("AAC 5.1", null)))
        assertEquals("AAC 5.1", Ranking.trackLanguage("AAC 5.1", null))
    }

    @Test fun trackNameLanguageIsOneLanguageOrNull() {
        assertEquals("Telugu", Ranking.trackNameLanguage("Telugu 5.1"))
        assertEquals("Hindi", Ranking.trackNameLanguage("Hindi AAC 2.0"))
        assertEquals("Telugu", Ranking.trackNameLanguage("TEL"))
        assertNull(Ranking.trackNameLanguage("Telugu / Hindi"))
        assertNull(Ranking.trackNameLanguage("per it"))
        assertEquals("Telugu", Ranking.trackNameLanguage("Telugu Stereo"))
    }

    @Test fun labelWithAnyOtherWordIsLeftAsGiven() {
        assertNull(Ranking.trackNameLanguage("Portuguese (Brazil)"))
        assertNull(Ranking.trackNameLanguage("Spanish LAT"))
        assertNull(Ranking.trackNameLanguage("Telugu Commentary"))
    }

    @Test fun vidrockRowIsTelugu() {
        val raw = com.chitram.app.data.RawStream(url = "https://x/m.m3u8", provider = "Vidrock", container = "hls",
            selectableAudio = true, languages = listOf("Telugu 5.1", "Hindi"),
            audio = listOf(com.chitram.app.data.RawAudio(language = "Telugu 5.1", name = "Telugu 5.1"),
                com.chitram.app.data.RawAudio(language = "Hindi", name = "Hindi")))
        val s = Ranking.toSource(raw, 0, com.chitram.app.data.CodecSupport { _, _ -> true })!!
        assertEquals(listOf("Telugu", "Hindi"), s.audioLanguages)
        val legacy = Ranking.toSource(raw.copy(audio = null, selectableAudio = false), 0, com.chitram.app.data.CodecSupport { _, _ -> true })!!
        assertEquals(listOf("Telugu", "Hindi"), legacy.languages)
    }

    @Test fun parityCodes() {
        assertEquals("Telugu", Ranking.languageLabel("te_IN"))
        assertNull(Ranking.languageLabel("mul"))
        assertNull(Ranking.languageLabel("zxx"))
        assertEquals("tel-hin", Ranking.languageLabel("tel-hin"))
    }
}
