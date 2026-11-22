package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.PlayerPrefs
import com.chitram.app.player.SubsPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Owner 2026-11-22: subtitles OFF in any player is remembered client-wide.
 * No later title, episode, provider switch or refresh turns them on by itself.
 * Only an explicit pick turns them on again, and that is remembered too.
 * Every start (new title, next episode, switch, refresh, resume, cast return)
 * goes through PlayerVm.play(), which asks SubsPolicy.start once per start.
 */
class SubsOffTest {
    private fun prefs() = PlayerPrefs(MemoryKeyValue())

    @Test fun `fresh client keeps current behaviour - text off, nothing flagged, no log`() {
        val p = prefs()
        assertNull(p.subsOn)
        val s = SubsPolicy.start(p.subsOn, tracks = 3)
        assertTrue(s.textDisabled)
        assertNull(s.defaultIndex)
        assertFalse(s.blockedByViewer)
    }

    @Test fun `off on title A - title B starts with no subtitles`() {
        val p = prefs()
        SubsPolicy.picked(p, on = true)   // viewer had them on during title A
        SubsPolicy.picked(p, on = false)  // then turned them off
        val b = SubsPolicy.start(p.subsOn, tracks = 2)
        assertTrue(b.textDisabled)
        assertNull(b.defaultIndex)
        assertTrue(b.blockedByViewer)
    }

    @Test fun `off - next episode and provider switch and refresh all start with no subtitles`() {
        val p = prefs()
        SubsPolicy.picked(p, on = false)
        // Each of these is a new play() with a fresh track list.
        repeat(3) { n ->
            val s = SubsPolicy.start(p.subsOn, tracks = n + 1)
            assertTrue(s.textDisabled)
            assertNull(s.defaultIndex)
        }
    }

    @Test fun `off survives an app restart - stored in the kv, not per title`() {
        val kv = MemoryKeyValue()
        SubsPolicy.picked(PlayerPrefs(kv), on = false)
        assertEquals(false, PlayerPrefs(kv).subsOn)
        assertTrue(kv.map.keys.none { it.contains("/") || it.contains("tt") })
    }

    @Test fun `on explicitly - next title auto-picks the first track`() {
        val p = prefs()
        SubsPolicy.picked(p, on = false)
        SubsPolicy.picked(p, on = true)
        val s = SubsPolicy.start(p.subsOn, tracks = 2)
        assertFalse(s.textDisabled)
        assertEquals(0, s.defaultIndex)
        assertFalse(s.blockedByViewer)
    }

    @Test fun `on with no tracks flags nothing`() {
        assertNull(SubsPolicy.start(true, tracks = 0).defaultIndex)
    }

    @Test fun `log line has the owner's prefix`() {
        assertEquals("[subs] off by viewer, skipped auto RRR", SubsPolicy.logLine("RRR"))
    }

    @Test fun `PlayerVm routes start and both menu picks through SubsPolicy`() {
        val src = File("src/main/java/com/chitram/app/player/PlayerVm.kt").readText()
        assertTrue(src.contains("SubsPolicy.start("))
        assertEquals(2, Regex("SubsPolicy\\.picked\\(").findAll(src).count())
        // No other path may re-enable text on its own.
        assertEquals(1, Regex("setTrackTypeDisabled\\(C\\.TRACK_TYPE_TEXT, false\\)").findAll(src).count())
    }
}
