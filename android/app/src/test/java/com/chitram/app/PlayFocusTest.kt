package com.chitram.app

import com.chitram.app.ui.common.DetailFocus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Owner 2026-11-24: "focus on play and resume buttons on loading". On TV the
 * details page held no focus during the skeleton: Play was composed only once
 * the title landed, so the root fallback put focus on Back after 500 ms and
 * then Play took it when the record arrived (a visible jump).
 */
class PlayFocusTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    private fun tvDetail(): String {
        val s = src("ui/tv/TvApp.kt")
        val start = s.indexOf("private fun TvDetail(")
        return s.substring(start, s.indexOf("\n}\n", start))
    }

    @Test fun playPressDependsOnTheLoadState() {
        assertEquals(DetailFocus.Press.PLAY, DetailFocus.press(loaded = true, failed = false))
        // OK on the skeleton's Play is not a dead press: it starts once the title lands.
        assertEquals(DetailFocus.Press.QUEUE, DetailFocus.press(loaded = false, failed = false))
        // A failed load keeps the same focused button as "Try again".
        assertEquals(DetailFocus.Press.RETRY, DetailFocus.press(loaded = false, failed = true))
    }

    @Test fun labelDuringLoadingAndError() {
        assertEquals("Play", DetailFocus.label(loaded = false, failed = false, playLabel = "Play"))
        assertEquals("Try again", DetailFocus.label(loaded = false, failed = true, playLabel = "Play"))
        assertEquals("Resume S1 E3", DetailFocus.label(loaded = true, failed = false, playLabel = "Resume S1 E3"))
    }

    @Test fun focusOnLoadOnlyWhenPlayNeverHadIt() {
        // Play held focus through the skeleton: do not re-request (a viewer on Back stays there).
        assertFalse(DetailFocus.focusOnLoad(playFocusedBefore = 1))
        assertTrue(DetailFocus.focusOnLoad(playFocusedBefore = 0))
    }

    @Test fun tvPlayIsComposedBeforeTheTitleLands() {
        val d = tvDetail()
        val actions = d.indexOf("item(key = \"actions\")")
        val loadedOnly = d.indexOf("if (t == null) return@LazyColumn")
        assertTrue("actions item must exist", actions > 0)
        // The list stops at the loaded-only rows AFTER the actions row (Play), never before it.
        assertTrue("Play must be composed while loading", loadedOnly < 0 || actions < loadedOnly)
        assertEquals("one loaded-only cut in the list", 1, Regex("""return@LazyColumn""").findAll(d).count())
    }

    @Test fun tvPlayFocusIsRequestedOnEntryNotOnTitleArrival() {
        val d = tvDetail()
        assertFalse("focus must not wait for the title", Regex("""if \(t != null\) LaunchedEffect\(t\.tmdbId\) \{ playFocus\.focusWhenAttached""").containsMatchIn(d))
        assertTrue(Regex("""LaunchedEffect\(type, id\) \{[^}]*playFocus\.focusWhenAttached""").containsMatchIn(d))
    }
}
