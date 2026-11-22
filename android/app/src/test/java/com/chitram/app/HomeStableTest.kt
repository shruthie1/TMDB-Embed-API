package com.chitram.app

import com.chitram.app.data.Title
import com.chitram.app.ui.common.HomeRows
import com.chitram.app.ui.common.Row
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Phone Home drifted after the player (header y 855 -> 783 -> 658). Back on Home,
 * refreshLocal rebuilds Continue watching and dedupe moves its titles out of the
 * rows below. A row left under its thin limit was hidden, and rows changed height
 * between skeleton, loaded and error. Now a row shown loaded stays shown for the
 * session, and every row state is one card tall. Same VM on TV.
 */
class HomeStableTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    private fun t(n: Int) = Title(n.toLong(), "movie", "T$n", poster = "/p$n.jpg", backdrop = "/b$n.jpg")

    @Test fun rowLosingATitleToContinueWatchingStaysShown() {
        val kept = HashSet<String>()
        val genre = (1..6).map { t(it) }
        val plan = listOf(Row("continue", "Continue watching", loading = false), Row("genre-28", "Action", thin = 6, loading = false))
        val before = HomeRows.keepShown(HomeRows.dedupe(plan, mapOf("genre-28" to genre)), kept)
        assertTrue(before.single { it.kind == "genre-28" }.shown)
        // Back from the player: title 3 is now in Continue watching.
        val after = HomeRows.keepShown(HomeRows.dedupe(
            listOf(plan[0].copy(titles = listOf(t(3))), plan[1]), mapOf("genre-28" to genre)), kept)
        val g = after.single { it.kind == "genre-28" }
        assertEquals(5, g.titles.size)
        assertTrue("a row shown once must not collapse under the viewer", g.shown)
        // Without the keep, the same rebuild hid it (the drift).
        assertFalse(HomeRows.dedupe(listOf(plan[0].copy(titles = listOf(t(3))), plan[1]), mapOf("genre-28" to genre)).single { it.kind == "genre-28" }.shown)
    }

    @Test fun loadingRowsAreNotKeptAndEmptiedPersonalRowsStillHide() {
        val kept = HashSet<String>()
        HomeRows.keepShown(listOf(Row("trending", "Trending", thin = 4)), kept) // loading skeleton
        assertFalse("a skeleton is not a loaded row", "trending" in kept)
        val thin = HomeRows.keepShown(listOf(Row("trending", "Trending", listOf(t(1)), thin = 4, loading = false)), kept)
        assertFalse("a thin row on first load still hides (web parity)", thin.single().shown)
        HomeRows.keepShown(listOf(Row("list", "My list", listOf(t(1)), loading = false)), kept)
        val cleared = HomeRows.keepShown(listOf(Row("list", "My list", loading = false)), kept)
        assertFalse(cleared.single().shown)
    }

    @Test fun vmKeepsRowsAndResetsOnLanguageChange() {
        val vm = src("ui/common/Vms.kt").substringAfter("class HomeVm").substringBefore("class DetailVm")
        assertTrue(vm.contains("rows = HomeRows.keepShown(HomeRows.dedupe(planned, raw), kept)"))
        assertTrue(vm.contains("recs = emptyList(); kept.clear()"))
    }

    @Test fun rowStatesAreOneCardTallOnPhoneAndTv() {
        val phone = src("ui/phone/PhoneApp.kt")
        val row = phone.substringAfter("private fun PhoneRow(").substringBefore("\n}\n")
        assertTrue("phone error row reserves a card", row.contains("CardSkeleton(CARD_W, Modifier.alpha(0f))"))
        assertTrue("phone empty kept row reserves a card", row.contains("item(key = \"reserve\")"))
        val sk = phone.substringAfter("private fun CardSkeleton(").substringBefore("\n}\n")
        assertTrue("phone skeleton lines are text lines like PosterCard", sk.contains("Text(\" \", fontSize = 12.sp") && sk.contains("Text(\" \", fontSize = 11.sp"))
        val tv = src("ui/tv/TvApp.kt")
        val tvRow = tv.substringAfter("private fun TvRow(").substringBefore("\n}\n")
        assertTrue(tvRow.contains("CardSkeleton(Modifier.alpha(0f))"))
        assertTrue(tvRow.contains("item(key = \"reserve\")"))
        val tvSk = tv.substringAfter("private fun CardSkeleton(").substringBefore("\n}\n")
        assertTrue(tvSk.contains("lineHeight = (TvWeb.CARD_TITLE * 1.25f).pxSp") && tvSk.contains("lineHeight = (TvWeb.CARD_META * 1.35f).pxSp"))
        assertTrue("an empty kept TV row is not a focus stop",
            tv.contains("visible.map { !it.loading && (it.error || it.titles.isNotEmpty()) }"))
    }
}
