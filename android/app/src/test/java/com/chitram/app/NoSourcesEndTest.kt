package com.chitram.app

import com.chitram.app.data.Source
import com.chitram.app.player.LoadingModel
import com.chitram.app.player.LoadingModel.Attempt
import com.chitram.app.player.LoadingModel.Phase
import com.chitram.app.player.LoadingModel.RowState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Owner 2026-11-24: "Finding sources… Telugu first · Ns" counted up forever when no
 * source existed. The search now ends: every path done with 0 rows, or 45 s.
 */
class NoSourcesEndTest {
    private fun vmSrc() = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
    private fun src(id: String) = Source(id, id, id, "https://x/$id.m3u8", false, "1080p", emptyList(), listOf("Telugu"), false, false, emptyList(), null, null, false)
    private fun input(now: Long, sources: List<Source>?, failed: Boolean, attempts: List<Attempt> = emptyList()) = LoadingModel.Input(
        now = now, playAt = 0, title = "Gopala Gopala", preferred = "Telugu", sources = sources, labels = emptyMap(),
        firstListSize = sources?.size ?: 0, attempts = attempts, checks = emptyList(), framed = false, failed = failed,
    )

    @Test fun allPathsEmptyEndsTheSearch() {
        // Every provider answered with nothing: end at once, no 45 s wait.
        assertTrue(LoadingModel.noSourceEnd(elapsedMs = 9_000, rows = 0, pathsActive = false))
        // A path still runs: keep finding until the cap.
        assertFalse(LoadingModel.noSourceEnd(elapsedMs = 44_999, rows = 0, pathsActive = true))
        assertTrue(LoadingModel.noSourceEnd(elapsedMs = 45_000, rows = 0, pathsActive = true))
        // Any row keeps the start going.
        assertFalse(LoadingModel.noSourceEnd(elapsedMs = 90_000, rows = 1, pathsActive = false))
    }

    @Test fun noSourcesCardHasTryAgainAndBackOnly() {
        val v = LoadingModel.view(input(45_000, emptyList(), failed = true))
        assertEquals(Phase.FAILED, v.phase)
        assertEquals("No sources found for Gopala Gopala", v.headline)
        assertTrue(v.showTryAgain)
        assertFalse(v.showPickSource)
        assertEquals(LoadingModel.Focus.REFRESH, LoadingModel.tvFocus(v))
        // Still searching before the end: the ticking line, no Try again yet.
        val finding = LoadingModel.view(input(20_000, null, failed = false))
        assertEquals(Phase.FINDING_SLOW, finding.phase)
    }

    @Test fun lateRowAfterTheCardWaitsForTryAgain() {
        // A late mapple Telugu row joined after the card: nothing tried, so still the no-sources card.
        val v = LoadingModel.view(input(50_000, listOf(src("mapple")), failed = true))
        assertEquals("No sources found for Gopala Gopala", v.headline)
        assertTrue(v.showTryAgain)
        val vm = vmSrc()
        val late = vm.substringAfter("private fun lateAfterEnd(").substringBefore("\n    }\n")
        assertFalse("never starts by itself", Regex("""\bplay\(""").containsMatchIn(late))
        for (fn in listOf("private suspend fun joinLate(", "private suspend fun joinVm(")) {
            val body = vm.substringAfter(fn).substringBefore("\n    }\n")
            assertFalse("$fn has no auto-start from the end card", body.contains("phase is Phase.Failed && "))
        }
    }

    @Test fun rowsThatAllFailedOfferPickASource() {
        val v = LoadingModel.view(input(60_000, listOf(src("a"), src("b")), failed = true,
            attempts = listOf(Attempt("a", 0, 1, RowState.FAILED, LoadingModel.Reason.NO_PICTURE), Attempt("b", 1, 2, RowState.FAILED, LoadingModel.Reason.NO_ANSWER))))
        assertEquals("Couldn't play any source", v.headline)
        assertTrue(v.showTryAgain && v.showPickSource)
    }

    @Test fun playerVmWiresTheCapAndTheLogLine() {
        val vm = vmSrc()
        assertTrue(vm.contains("\"[resolve] no sources \${r.type}/\${r.id} after \${System.currentTimeMillis() - playAt}ms\""))
        assertTrue(vm.contains("delay((playAt + LoadingModel.NO_SOURCE_CAP_MS - System.currentTimeMillis()).coerceAtLeast(0))"))
        assertTrue(vm.contains("LoadingModel.noSourceEnd(System.currentTimeMillis() - playAt, 0, pathsActive = lateJobs.any { it.isActive } || fullJob?.isActive == true)"))
        // Try again on the end card is a full re-resolve (no refresh cooldown).
        assertTrue(LoadingModel.retryPlan(failed = true).refresh)
        val screen = listOf(File("src/main/java/com/chitram/app/ui/common/PlayerScreen.kt"), File("app/src/main/java/com/chitram/app/ui/common/PlayerScreen.kt")).first { it.exists() }.readText()
        assertTrue(screen.contains("PillButton(LoadingModel.Copy.TRY_AGAIN, primary = true, icon = Glyphs.restart, modifier = Modifier.focusRequester(retryFocus), onClick = { vm.retry() })"))
    }
}
