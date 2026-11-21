package com.chitram.app

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.chitram.app.data.Source
import com.chitram.app.player.MenuItem
import com.chitram.app.player.PlayerVm
import com.chitram.app.ui.common.MenuTap
import com.chitram.app.ui.common.menuTap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 1.2.13: player sheets. Dead taps: a lang: row that resolved to the playing
 * source did nothing (unlabelled tracks), a re-tap on the selected row closed
 * silently through no branch, and unsupported subtitle tracks were listed.
 */
class V128Test {
    private fun src(id: String, provider: String, vararg langs: String, selectable: Boolean = false) = Source(
        id = id, provider = provider, label = "", url = "https://cdn.example/$id.m3u8", progressive = false, quality = "1080p",
        levels = emptyList(), languages = langs.toList(), selectableAudio = selectable, hybrid = false, subtitles = emptyList(),
        videoCodec = null, codecString = null, unsupported = false,
    )

    private fun group(id: String, vararg f: Format, supported: Boolean = true, selected: Int = -1) = Tracks.Group(
        TrackGroup(id, *f), false, IntArray(f.size) { if (supported) C.FORMAT_HANDLED else C.FORMAT_UNSUPPORTED_SUBTYPE }, BooleanArray(f.size) { it == selected },
    )
    private fun audio(lang: String?, label: String? = null) = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(lang).setLabel(label).build()
    private fun text(lang: String) = Format.Builder().setSampleMimeType(MimeTypes.TEXT_VTT).setLanguage(lang).build()

    // Castle row metadata says Telugu + Hindi, but its HLS tracks carry no language.
    private val castle = src("castletv-0", "CastleTV", "Telugu", "Hindi", selectable = true)
    private val vaHindi = src("vaplayer-0", "VaPlayer", "Hindi")
    private val mapTamil = src("mapple-0", "Mapple", "Tamil")

    @Test fun unlabelledCurrentSourceIsNotOfferedAsALanguageRow() {
        val unlabelled = listOf(group("a", audio(null, "Audio"), selected = 0))
        val items = PlayerVm.audioMenu(unlabelled, listOf(castle, mapTamil), castle, unnamed = "Telugu", curLang = "Telugu")
        // Telugu is the in-stream track; Hindi only resolves to the playing source, so no dead row.
        assertEquals(listOf("trk:0:0", "lang:Tamil"), items.map { it.key })
        assertEquals("In this stream", items[0].group)
        assertEquals("Other servers", items[1].group)
    }

    @Test fun languageOnAnotherServerIsStillOffered() {
        val unlabelled = listOf(group("a", audio(null), selected = 0))
        val items = PlayerVm.audioMenu(unlabelled, listOf(castle, vaHindi), castle, unnamed = "Telugu", curLang = "Telugu")
        val hindi = items.single { it.key == "lang:Hindi" }
        assertEquals("1 stream", hindi.detail)
    }

    @Test fun tracksNotKnownYetKeepTheCurrentSourceAsACandidate() {
        val items = PlayerVm.audioMenu(emptyList(), listOf(castle), castle, unnamed = "Telugu", curLang = "Telugu")
        assertEquals(listOf("cur", "lang:Hindi"), items.map { it.key })
        assertTrue(items[0].selected)
    }

    @Test fun teluguTrackKeepsItsLabelAndOrder() {
        val labelled = listOf(group("te", audio("te"), selected = 0), group("hi", audio("hi")))
        val items = PlayerVm.audioMenu(labelled, listOf(castle, mapTamil), castle, unnamed = "Telugu", curLang = "Telugu")
        assertEquals(listOf("Telugu", "Hindi", "Tamil"), items.map { it.label })
        assertTrue(items[0].selected)
    }

    @Test fun languagePickSkipsThePlayingSourceWhenItCannotPlayIt() {
        val pool = listOf(castle, vaHindi)
        assertEquals(vaHindi, PlayerVm.nextForLanguage(pool, pool, castle.id, currentCarries = false))
        assertEquals(castle, PlayerVm.nextForLanguage(pool, pool, castle.id, currentCarries = true))
        // Only the playing source: nothing to switch to, the caller shows a notice.
        assertNull(PlayerVm.nextForLanguage(listOf(castle), listOf(castle), castle.id, currentCarries = false))
        // tried filtered the other server out: fall back to the full list.
        assertEquals(vaHindi, PlayerVm.nextForLanguage(listOf(castle), pool, castle.id, currentCarries = false))
    }

    @Test fun carriesReadsLanguageAndLabel() {
        assertTrue(PlayerVm.carries(emptyList(), "Hindi"))
        assertFalse(PlayerVm.carries(listOf(group("a", audio(null, "Audio"))), "Hindi"))
        assertTrue(PlayerVm.carries(listOf(group("a", audio("hi"))), "Hindi"))
        assertTrue(PlayerVm.carries(listOf(group("a", audio(null, "Telugu"))), "Telugu"))
        assertFalse(PlayerVm.carries(listOf(group("a", audio("hi"), supported = false)), "Hindi"))
    }

    @Test fun subtitleListSkipsUnsupportedTracks() {
        val groups = listOf(group("en", text("en"), selected = 0), group("ass", text("te"), supported = false))
        val items = PlayerVm.subtitleMenu(groups, disabled = false)
        assertEquals(listOf("sub:off", "sub:0:0"), items.map { it.key })
        assertTrue(items[1].selected)
        assertFalse(items[0].selected)
    }

    @Test fun reTappingASelectedRowOnlyCloses() {
        assertEquals(MenuTap.Close, menuTap(MenuItem("cur", "Telugu", selected = true)))
        assertEquals(MenuTap.Close, menuTap(MenuItem("q:auto", "Auto", selected = true)))
        assertEquals(MenuTap.Close, menuTap(MenuItem("src:castletv-0", "Castle", selected = true)))
        assertEquals(MenuTap.Choose, menuTap(MenuItem("lang:Hindi", "Hindi")))
        // A selected provider group still drills in; dim rows stay tappable.
        assertEquals(MenuTap.Drill, menuTap(MenuItem("group:CastleTV", "CastleTV", selected = true)))
        assertEquals(MenuTap.Choose, menuTap(MenuItem("src:x", "X", dim = true)))
        assertEquals(MenuTap.Check, menuTap(MenuItem("check:netmirror", "Check")))
        assertEquals(MenuTap.Choose, menuTap(null))
    }
}
