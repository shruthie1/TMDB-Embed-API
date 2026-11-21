package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.RawAudio
import com.chitram.app.data.RawStream
import com.chitram.app.data.Ranking
import com.chitram.app.data.StreamsResponse
import com.chitram.app.player.AudioChoice
import com.chitram.app.player.PlayerVm
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Task 8: a plain language pick switches (in-stream track or another server) and
 * never pairs. Same menu code on phone and Fire TV (PlayerScreen isTv flag only).
 */
class AudioPickSwitchTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false; isLenient = true }
    private val codecs = CodecSupport { _, _ -> true }

    private fun row(provider: String, languages: List<String> = emptyList(), audio: List<RawAudio>? = null, selectable: Boolean = false, i: Int = 0) =
        Ranking.toSource(RawStream(url = "https://fixture/$provider.m3u8", provider = provider, languages = languages, audio = audio, selectableAudio = selectable), i, codecs)!!

    private fun group(id: String, vararg f: Format, selected: Int = -1) = Tracks.Group(
        TrackGroup(id, *f), false, IntArray(f.size) { C.FORMAT_HANDLED }, BooleanArray(f.size) { it == selected },
    )
    private fun audio(lang: String?, label: String? = null) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).setLabel(label).build()

    // ---- Index ---------------------------------------------------------------

    @Test fun teAndTeluguOnTwoServersGiveOneBucket() {
        val a = row("a", audio = listOf(RawAudio(language = "te")))
        val b = row("b", audio = listOf(RawAudio(language = "Telugu")))
        val index = AudioChoice.index(listOf(a, b))
        assertEquals(listOf("Telugu"), index.keys.toList())
        assertEquals(listOf("a-0", "b-0"), index.getValue("Telugu").map { it.id })
    }

    @Test fun emptyAudioWithHindiLanguagesIsWholeStreamHindi() {
        val s = row("v", languages = listOf("Hindi"), audio = emptyList())
        assertFalse(s.selectableAudio)
        assertEquals(listOf("Hindi"), AudioChoice.languages(s))
        assertEquals(listOf("Hindi"), AudioChoice.index(listOf(s)).keys.toList())
    }

    @Test fun undTrackNamedTelugu51IsTelugu() {
        val s = row("c", audio = listOf(RawAudio(language = null, languageCode = "und", name = "Telugu 5.1"), RawAudio(language = "Hindi")), selectable = true)
        assertEquals(listOf("Telugu", "Hindi"), AudioChoice.languages(s))
        // A name that is not a language never becomes one.
        val odd = row("d", audio = listOf(RawAudio(language = "und", name = "Commentary")))
        assertEquals(emptyList<String>(), AudioChoice.languages(odd))
    }

    @Test fun emptyInputGivesEmptyIndex() {
        assertTrue(AudioChoice.index(emptyList()).isEmpty())
        assertTrue(AudioChoice.candidates(emptyList(), "Telugu").isEmpty())
    }

    @Test fun rawAudioParsesWithAndWithoutNewFields() {
        val old = json.decodeFromString(RawAudio.serializer(), """{"language":"Telugu"}""")
        assertEquals(RawAudio(language = "Telugu"), old)
        val full = json.decodeFromString(RawAudio.serializer(),
            """{"language":"Telugu","languageCode":"tel","name":"Telugu 5.1","uri":"https://x/a.m3u8","channels":6,"codec":"ec-3","default":true}""")
        assertEquals("tel", full.languageCode)
        assertEquals("Telugu 5.1", full.name)
        assertEquals("https://x/a.m3u8", full.uri)
        assertEquals(6.0, full.channels!!, 0.0)
        assertEquals("ec-3", full.codec)
        assertTrue(full.isDefault)
        val nulls = json.decodeFromString(RawAudio.serializer(), """{"language":null,"languageCode":null,"name":null,"uri":null,"channels":null,"codec":null,"default":false}""")
        assertEquals(RawAudio(), nulls)
        val resp = json.decodeFromString(StreamsResponse.serializer(),
            """{"success":true,"streams":[{"url":"https://x/m.m3u8","provider":"P","selectableAudio":true,"audio":[{"language":"Telugu","channels":5.1,"default":true},{"language":"Hindi"}]}]}""")
        assertEquals(listOf("Telugu", "Hindi"), Ranking.toSource(resp.streams[0], 0, codecs)!!.audioLanguages)
    }

    // ---- Pick decision (a/b/c) -------------------------------------------------

    private val castle = row("CastleTV", audio = listOf(RawAudio(language = "Telugu"), RawAudio(language = "Hindi")), selectable = true)
    private val tamil = row("Mapple", audio = listOf(RawAudio(language = "Tamil")))

    @Test fun inStreamLanguageIsATrackSwitchNotAServerRow() {
        // (a) Hindi is a track in the playing stream: pick = trk override, no lang: or pair: row.
        val tracks = listOf(group("te", audio("te"), selected = 0), group("hi", audio("hi")))
        val items = PlayerVm.audioMenu(tracks, listOf(castle, tamil), castle, unnamed = "Telugu", curLang = "Telugu")
        assertEquals("trk:1:0", items.single { it.label == "Hindi" }.key)
        assertTrue(items.none { it.key == "lang:Hindi" || it.key == "lang:Telugu" })
        assertTrue(items.none { it.key.startsWith("pair") })
    }

    @Test fun undTrackLabelledTeluguIsTheInStreamTeluguRow() {
        // (a) via label: und 'Telugu 5.1' names Telugu, so Telugu on another server is not offered again.
        val other = row("VaPlayer", audio = listOf(RawAudio(language = "Telugu")))
        val tracks = listOf(group("x", audio("und", "Telugu 5.1"), selected = 0))
        val items = PlayerVm.audioMenu(tracks, listOf(castle, other), castle, unnamed = "Hindi", curLang = "Hindi")
        assertEquals(listOf("Telugu"), items.filter { it.group == PlayerVm.IN_STREAM }.map { it.label })
        assertTrue(items.none { it.key == "lang:Telugu" })
    }

    @Test fun languageOnAnotherServerIsAServerSwitch() {
        // (b) Tamil is only on Mapple: one lang: row, and the pick targets Mapple (play without pairAudio).
        val tracks = listOf(group("te", audio("te"), selected = 0), group("hi", audio("hi")))
        val sources = listOf(castle, tamil)
        val items = PlayerVm.audioMenu(tracks, sources, castle, unnamed = "Telugu", curLang = "Telugu")
        val pick = items.single { it.label == "Tamil" }
        assertEquals("lang:Tamil", pick.key)
        assertEquals(PlayerVm.OTHER_SERVERS, pick.group)
        val pool = AudioChoice.candidates(sources, "Tamil")
        assertEquals(tamil, PlayerVm.nextForLanguage(pool, pool, castle.id, PlayerVm.carries(tracks, "Tamil")))
        assertFalse(PlayerVm.carries(tracks, "Tamil"))
    }

    @Test fun languageNoServerCarriesIsNotOffered() {
        // (c) Kannada is on no server: no plain row, no pair row.
        val tracks = listOf(group("te", audio("te"), selected = 0))
        val items = PlayerVm.audioMenu(tracks, listOf(castle, tamil), castle, unnamed = "Telugu", curLang = "Telugu")
        assertTrue(items.none { Ranking.sameLanguage(it.label, "Kannada") })
        assertTrue(items.none { it.key.startsWith("pair") })
        assertTrue(AudioChoice.candidates(listOf(castle, tamil), "Kannada").isEmpty())
        assertNull(PlayerVm.nextForLanguage(emptyList(), emptyList(), castle.id, currentCarries = false))
    }

    @Test fun everyMenuKeyIsASwitchKey() {
        // No surface emits the pair command from a plain pick (phone and TV share audioMenu).
        val tracks = listOf(group("te", audio("te"), selected = 0))
        val sources = listOf(castle, tamil, row("VaPlayer", languages = listOf("Hindi"), audio = emptyList()))
        for (items in listOf(PlayerVm.audioMenu(tracks, sources, castle, "Telugu", "Telugu"), PlayerVm.audioMenu(emptyList(), sources, castle, "Telugu", "Telugu")))
            assertTrue(items.map { it.key }.toString(), items.all { it.key.startsWith("trk:") || it.key.startsWith("lang:") || it.key == "cur" })
    }

    @Test fun serverRowLanguagesComeFromTheIndex() {
        // Server menu detail lists AudioChoice.languages(source) on every row.
        assertEquals(listOf("Telugu", "Hindi"), AudioChoice.languages(castle))
        assertEquals(listOf("Tamil"), AudioChoice.languages(tamil))
    }
}
