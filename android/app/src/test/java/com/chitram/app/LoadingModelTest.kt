package com.chitram.app

import com.chitram.app.data.Source
import com.chitram.app.player.LoadingModel
import com.chitram.app.player.LoadingModel.Attempt
import com.chitram.app.player.LoadingModel.Check
import com.chitram.app.player.LoadingModel.Input
import com.chitram.app.player.LoadingModel.Phase
import com.chitram.app.player.LoadingModel.Reason
import com.chitram.app.player.LoadingModel.RowState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Loading-screen spec (scratchpad loading-ux/spec.md, section 8, APK case 1).
 * Strings are copy-identical with web/lib/player/loadingModel.js.
 */
class LoadingModelTest {
    private fun src(id: String, provider: String, langs: List<String> = listOf("Telugu"), q: String = "1080p", unsupported: Boolean = false) =
        Source(id, provider, provider, "https://h/$id", false, q, emptyList(), langs, false, false, emptyList(), null, null, unsupported)

    private val list = listOf(
        src("c1", "CastleTV"), src("c2", "CastleTV"), src("o1", "OneTouchTV", q = "720p"),
        src("n1", "NetMirror"), src("s1", "showsst", langs = listOf("Hindi"), q = "720p"),
    )
    private val labels = LoadingModel.labelRows(emptyMap(), list)

    private fun input(now: Long, listReady: Boolean = false, attempts: List<Attempt> = emptyList(), framed: Boolean = false, failed: Boolean = false, checks: List<Check> = emptyList(), switching: Boolean = false) =
        Input(
            now = now, playAt = 0, title = "Devara Part 1", preferred = "Telugu",
            sources = if (listReady) list else null, labels = labels, firstListSize = if (listReady) list.size else 0,
            attempts = attempts, checks = checks, framed = framed, failed = failed, switching = switching,
        )

    // ---- Timing rules (section 3) ------------------------------------------

    @Test fun noTryAgainAt8s() {
        val v = LoadingModel.view(input(8_000))
        assertFalse(v.showTryAgain)
        assertFalse(v.showChooser)
    }

    @Test fun tryAgainOnlyFrom30sWithNoList() {
        assertFalse(LoadingModel.view(input(29_999)).showTryAgain)
        assertTrue(LoadingModel.view(input(30_000)).showTryAgain)
    }

    @Test fun slowHintAt15s() {
        assertEquals(Phase.FINDING, LoadingModel.view(input(14_999)).phase)
        val v = LoadingModel.view(input(15_000))
        assertEquals(Phase.FINDING_SLOW, v.phase)
        assertEquals("Still finding sources…", v.headline)
        assertEquals("First play of a title can take up to a minute.", v.detail)
    }

    @Test fun chooserAt30sWithListAndNoFrame() {
        val a = listOf(Attempt("c1", 1_000))
        assertFalse(LoadingModel.view(input(29_999, listReady = true, attempts = a)).showChooser)
        val v = LoadingModel.view(input(30_000, listReady = true, attempts = a))
        assertTrue(v.showChooser)
        assertFalse(v.showTryAgain)
    }

    @Test fun neverTryAgainWhileSourcesLeft() {
        val a = listOf(Attempt("c1", 1_000, 21_000, RowState.FAILED, Reason.NO_PICTURE), Attempt("c2", 21_000))
        assertFalse(LoadingModel.view(input(200_000, listReady = true, attempts = a)).showTryAgain)
    }

    @Test fun everyRowFailedIsTheEndCard() {
        val v = LoadingModel.view(input(90_000, listReady = true, failed = true, attempts = list.map { Attempt(it.id, 0, 1, RowState.FAILED, Reason.NO_ANSWER) }))
        assertEquals(Phase.FAILED, v.phase)
        // End card (owner 2026-11-24): Try again + Pick a source when rows were tried.
        assertTrue(v.showTryAgain)
        assertTrue(v.showPickSource)
        assertEquals("Couldn't play any source", v.headline)
        assertEquals("We tried 5 sources. None of them played.", v.detail)
    }

    // ---- Copy per phase (section 4) ----------------------------------------

    @Test fun headlinesPerPhase() {
        val finding = LoadingModel.view(input(4_000))
        assertEquals("Finding sources…", finding.headline)
        assertEquals("Telugu first", finding.detail)
        assertEquals("Telugu first · 7s", LoadingModel.view(input(7_000)).detail)

        val found = LoadingModel.view(input(9_000, listReady = true))
        assertEquals(Phase.FOUND, found.phase)
        assertEquals("Found 5 sources", found.headline)
        assertEquals("4 in Telugu", found.detail)

        val starting = LoadingModel.view(input(9_000, listReady = true, attempts = listOf(Attempt("c2", 9_000))))
        assertEquals(Phase.STARTING, starting.phase)
        assertEquals("Starting CastleTV 2", starting.headline)
        assertEquals("Telugu · 1080p", starting.detail)

        val adv = LoadingModel.view(input(34_000, listReady = true, attempts = listOf(
            Attempt("c1", 9_000, 29_000, RowState.FAILED, Reason.NO_PICTURE), Attempt("c2", 29_000),
        )))
        assertEquals(Phase.ADVANCING, adv.phase)
        assertEquals("CastleTV 1 didn't start. Trying CastleTV 2.", adv.headline)
        assertEquals("Telugu · 1080p · 2 of 5 tried", adv.detail)
        assertEquals("Started 34s ago · 2 of 5 tried", adv.footer)

        val skip = LoadingModel.view(input(12_000, listReady = true, attempts = listOf(
            Attempt("c1", 9_000, 10_000, RowState.SKIPPED, Reason.UNSUPPORTED), Attempt("o1", 10_000),
        )))
        assertEquals(Phase.ADVANCING_SKIP, skip.phase)
        assertEquals("CastleTV 1 won't play on this device. Trying OneTouchTV.", skip.headline)
    }

    @Test fun moreFoundAfterTheList() {
        val v = LoadingModel.view(input(12_000, listReady = true, attempts = listOf(
            Attempt("c1", 9_000, 10_000, RowState.FAILED, Reason.NO_ANSWER), Attempt("c2", 10_000),
        )).copy(firstListSize = 3))
        assertEquals("Telugu · 1080p · 2 of 3 tried · 2 more found", v.detail)
    }

    @Test fun triedCountNeverGoesDown() {
        var prev = 0
        val tried = ArrayList<Attempt>()
        for ((i, id) in listOf("s1", "n1", "o1").withIndex()) {
            tried.forEachIndexed { j, a -> tried[j] = a.copy(endedAt = a.endedAt ?: (i * 1_000L), state = RowState.FAILED, reason = Reason.NO_ANSWER) }
            tried += Attempt(id, i * 1_000L)
            val k = Regex("""(\d+) of \d+ tried""").find(LoadingModel.view(input(40_000, listReady = true, attempts = tried)).footer)!!.groupValues[1].toInt()
            assertTrue("k went from $prev to $k", k > prev)
            prev = k
        }
    }

    // ---- Rows ----------------------------------------------------------------

    @Test fun searchPhaseShowsTheThreeCheckRows() {
        val v = LoadingModel.view(input(7_000, checks = listOf(
            Check(LoadingModel.CHECK_SERVER, "Chitram server", 0),
            Check(LoadingModel.CHECK_MAPPLE, "Mapple (on phone)", 0, 4_000, found = 1),
            Check(LoadingModel.CHECK_VAPLAYER, "VaPlayer (on phone)", 0, 6_000, found = 0),
        )))
        assertEquals(listOf("Checking… 7s", "1 link · 4.0s", "nothing found · 6.0s"), v.rows.map { it.status })
        assertTrue(v.rows.none { it.clickable })
        assertEquals("Started 7s ago", v.footer)
    }

    @Test fun rowsInTryOrderWithStates() {
        val v = LoadingModel.view(input(34_000, listReady = true, attempts = listOf(
            Attempt("c1", 9_000, 29_000, RowState.FAILED, Reason.NO_PICTURE), Attempt("c2", 28_000),
        )))
        assertEquals(listOf("c1", "c2", "o1", "n1", "s1"), v.rows.map { it.id })
        assertEquals("CastleTV 1 · Telugu · 1080p", v.rows[0].title)
        assertEquals("Failed: no picture in 20s · 20s", v.rows[0].status)
        assertEquals("Starting… 6s", v.rows[1].status)
        assertEquals("Waiting", v.rows[2].status)
        assertEquals("showsst · Hindi · 720p", v.rows[4].title)
        assertEquals(listOf(true, false, true, true, true), v.rows.map { it.clickable })
        assertEquals("CastleTV 1, Telugu, 1080p, failed: no picture in 20 seconds · 20 seconds", v.rows[0].description)
    }

    @Test fun playingRowAndUnsupportedRow() {
        val withBad = list + src("x1", "vidrock", q = "2160p", unsupported = true)
        val v = LoadingModel.view(input(12_000, listReady = true, attempts = listOf(Attempt("c1", 9_000, 12_100, RowState.PLAYING))).copy(
            sources = withBad, labels = LoadingModel.labelRows(emptyMap(), withBad),
        ))
        assertEquals("Playing · 3.1s to start", v.rows.first { it.id == "c1" }.status)
        val bad = v.rows.first { it.id == "x1" }
        assertEquals("Skipped: won't play on this device", bad.status)
        assertFalse(bad.clickable)
    }

    // ---- Labels and notices ------------------------------------------------

    @Test fun labelsStayPutWhenRowsJoinOrLeave() {
        val first = LoadingModel.labelRows(emptyMap(), listOf(src("a", "showsst"), src("b", "CastleTV")))
        assertEquals("showsst", first["a"])
        val more = LoadingModel.labelRows(first, listOf(src("c", "showsst"), src("a", "showsst"), src("b", "CastleTV")))
        assertEquals("showsst", more["a"])
        assertEquals("showsst 2", more["c"])
        // a dead row removed from the menus keeps its label
        val less = LoadingModel.labelRows(more, listOf(src("c", "showsst")))
        assertEquals("showsst", less["a"])
        assertNotEquals(less["a"], less["c"])
    }

    @Test fun advanceNoticeNamesTwoServers() {
        assertEquals("CastleTV 1 didn't start. Trying CastleTV 2.", LoadingModel.advanceNotice("CastleTV 1", "CastleTV 2", skip = false))
        assertEquals("showsst won't play on this device. Trying NetMirror.", LoadingModel.advanceNotice("showsst", "NetMirror", skip = true))
    }

    // ---- Task 9: honest switch copy (web Copy, byte for byte) -----------------

    @Test fun copyMatchesWebByteForByte() {
        assertEquals("Switching server\u2026", LoadingModel.Copy.SWITCHING_SERVER)
        assertEquals("Finding sources\u2026", LoadingModel.Copy.FINDING)
        assertEquals("Still finding sources\u2026", LoadingModel.Copy.FINDING_SLOW)
        assertEquals("First play of a title can take up to a minute.", LoadingModel.Copy.FINDING_SLOW_DETAIL)
        assertEquals("Left", LoadingModel.Copy.ROW_LEFT)
        assertEquals("A didn't start. Trying B.", LoadingModel.Copy.didntStart("A", "B"))
        assertEquals("A stopped. Trying B.", LoadingModel.Copy.stopped("A", "B"))
        assertEquals("A won't play on this device. Trying B.", LoadingModel.Copy.wontPlay("A", "B"))
    }

    @Test fun switchingWinsOverSlowHint() {
        val v = LoadingModel.view(input(20_000, switching = true))
        assertEquals(Phase.SWITCHING, v.phase)
        assertEquals("Switching server…", v.headline)
        assertEquals("", v.detail)
        assertFalse(v.showTryAgain)
    }

    @Test fun slowOnlyWithNoSwitch() {
        assertEquals("Still finding sources…", LoadingModel.view(input(15_000)).headline)
        assertEquals("Finding sources…", LoadingModel.view(input(14_999)).headline)
        assertNotEquals("Still finding sources…", LoadingModel.view(input(15_000, switching = true)).headline)
    }

    @Test fun switchingWinsOverAdvanceNotice() {
        val a = listOf(Attempt("c1", 9_000, 29_000, RowState.FAILED, Reason.NO_PICTURE), Attempt("c2", 29_000))
        val v = LoadingModel.view(input(34_000, listReady = true, attempts = a, switching = true))
        assertEquals(Phase.SWITCHING, v.phase)
        assertEquals("Switching server…", v.headline)
        assertEquals("Telugu · 1080p · 2 of 5 tried", v.detail)
    }

    @Test fun leftRowIsNeutralAndPickable() {
        val a = listOf(Attempt("c1", 9_000, 12_000, RowState.LEFT), Attempt("o1", 12_000))
        val v = LoadingModel.view(input(14_000, listReady = true, attempts = a))
        // The row left by a viewer pick is no failure: the new row is just starting.
        assertEquals(Phase.STARTING, v.phase)
        assertEquals("Starting OneTouchTV", v.headline)
        assertEquals("Started 14s ago · 1 of 5 tried", v.footer)
        val left = v.rows.first { it.id == "c1" }
        assertEquals(RowState.LEFT, left.state)
        assertEquals("Left", left.status)
        assertTrue(left.clickable)
        assertTrue(v.rows.none { "slow" in it.status })
    }

    @Test fun leftRowsAreNotCountedOnTheEndCard() {
        val a = listOf(Attempt("c1", 9_000, 12_000, RowState.LEFT), Attempt("o1", 12_000, 30_000, RowState.FAILED, Reason.NO_PICTURE))
        val v = LoadingModel.view(input(31_000, listReady = true, attempts = a, failed = true, switching = true))
        assertEquals(Phase.FAILED, v.phase)
        assertEquals("We tried 1 sources. None of them played.", v.detail)
    }

    @Test fun eachTryingLine() {
        assertEquals("CastleTV 1 didn't start. Trying CastleTV 2.", LoadingModel.advanceNotice("CastleTV 1", "CastleTV 2", skip = false))
        assertEquals("CastleTV 1 stopped. Trying CastleTV 2.", LoadingModel.advanceNotice("CastleTV 1", "CastleTV 2", skip = false, stopped = true))
        assertEquals("CastleTV 1 won't play on this device. Trying CastleTV 2.", LoadingModel.advanceNotice("CastleTV 1", "CastleTV 2", skip = true, stopped = true))
        assertEquals("That server didn't start. Trying the next server.", LoadingModel.advanceNotice(null, "", skip = false))
        assertEquals("That server stopped. Trying OneTouchTV.", LoadingModel.advanceNotice("", "OneTouchTV", skip = false, stopped = true))
    }

    @Test fun failNoticeStoppedWhenTheFailedRowHadFramed() {
        // c1 framed, then died mid-film; play(c2) already appended c2's attempt.
        val a = listOf(Attempt("c1", 1_000, 4_000, RowState.PLAYING), Attempt("c2", 90_000))
        assertEquals("CastleTV 1 stopped. Trying CastleTV 2.", LoadingModel.failNotice(a, "c1", "CastleTV 1", "CastleTV 2", skip = false))
        // Same list without the new row: same answer.
        assertEquals("CastleTV 1 stopped. Trying CastleTV 2.", LoadingModel.failNotice(a.take(1), "c1", "CastleTV 1", "CastleTV 2", skip = false))
    }

    @Test fun failNoticeDidntStartWhenTheFailedRowNeverFramed() {
        val a = listOf(Attempt("c1", 1_000, 21_000, RowState.FAILED, Reason.NO_PICTURE), Attempt("c2", 21_000))
        assertEquals("CastleTV 1 didn't start. Trying CastleTV 2.", LoadingModel.failNotice(a, "c1", "CastleTV 1", "CastleTV 2", skip = false))
        // An earlier framed attempt of the same row does not count: its latest attempt failed to start.
        val again = listOf(Attempt("c1", 0, 1_000, RowState.PLAYING), Attempt("o1", 5_000, 6_000, RowState.PLAYING),
            Attempt("c1", 7_000, 27_000, RowState.FAILED, Reason.NO_PICTURE), Attempt("c2", 27_000))
        assertEquals("CastleTV 1 didn't start. Trying CastleTV 2.", LoadingModel.failNotice(again, "c1", "CastleTV 1", "CastleTV 2", skip = false))
        assertEquals("That server didn't start. Trying CastleTV 2.", LoadingModel.failNotice(a, null, null, "CastleTV 2", skip = false))
        val framed = listOf(Attempt("c1", 1_000, 4_000, RowState.PLAYING), Attempt("c2", 90_000))
        assertEquals("CastleTV 1 won't play on this device. Trying CastleTV 2.", LoadingModel.failNotice(framed, "c1", "CastleTV 1", "CastleTV 2", skip = true))
    }

    @Test fun noLineSaysSlow() {
        val lines = listOf(LoadingModel.Copy.SWITCHING_SERVER, LoadingModel.Copy.FINDING, LoadingModel.Copy.FINDING_SLOW,
            LoadingModel.Copy.FINDING_SLOW_DETAIL, LoadingModel.Copy.didntStart("a", "b"), LoadingModel.Copy.stopped("a", "b"),
            LoadingModel.Copy.wontPlay("a", "b"))
        assertTrue(lines.none { " slow" in it.lowercase() || it.lowercase().startsWith("slow") })
        val adv = LoadingModel.view(input(34_000, listReady = true, attempts = listOf(
            Attempt("c1", 9_000, 29_000, RowState.FAILED, Reason.NO_ANSWER), Attempt("c2", 29_000))))
        assertFalse("slow" in adv.headline.lowercase())
    }

    @Test fun reasonsFromErrors() {
        assertEquals(Reason.EXPIRED, LoadingModel.reasonFor(403, decoder = false))
        assertEquals(Reason.EXPIRED, LoadingModel.reasonFor(410, decoder = false))
        assertEquals(Reason.NOT_FOUND, LoadingModel.reasonFor(404, decoder = false))
        assertEquals(Reason.SERVER, LoadingModel.reasonFor(502, decoder = false))
        assertEquals(Reason.UNSUPPORTED, LoadingModel.reasonFor(null, decoder = true))
        assertEquals(Reason.STOPPED, LoadingModel.reasonFor(null, decoder = false))
    }

    // ---- Try again during the search does not cancel device resolves ---------

    @Test fun retryDuringSearchKeepsDeviceResolves() {
        val search = LoadingModel.retryPlan(failed = false)
        assertFalse(search.refresh)
        assertTrue(search.keepDevice)
        val end = LoadingModel.retryPlan(failed = true)
        assertTrue(end.refresh)
        assertFalse(end.keepDevice)
    }
}
