package com.chitram.app

import com.chitram.app.resolve.UrlExpiry
import com.chitram.app.ui.common.PrewarmDwell
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** P13 details-page dwell and P11 `Expires=` (PENDING-WORK 2026-11-22). */
class PrewarmDwellTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var clock = 1_000L
    private val lines = mutableListOf<String>()
    /** The dwell's wait: ends only when the test opens it. */
    private var gate = CompletableDeferred<Unit>()
    private val waited = mutableListOf<Long>()
    private fun dwell() = PrewarmDwell(scope, context = Dispatchers.Unconfined, now = { clock },
        wait = { waited += it; gate.await() }, log = { lines += it })

    @After fun teardown() { scope.cancel() }

    @Test fun startsOnlyAfterTheDwell() {
        val d = dwell()
        var started = 0
        d.arm { started++ }
        assertEquals(listOf(1_500L), waited)
        assertEquals("nothing starts on open", 0, started)
        clock += 1_500
        gate.complete(Unit)
        assertEquals(1, started)
        assertEquals(listOf("prewarm: dwell 1500 start"), lines)
        assertFalse(d.armed)
    }

    @Test fun leavingFirstStartsNothingEvenWhenTheTimerEnds() {
        val d = dwell()
        var started = 0
        d.arm { started++ }
        clock += 400
        d.leave()
        gate.complete(Unit)
        assertEquals(0, started)
        assertEquals(listOf("prewarm: left before dwell"), lines)
    }

    @Test fun playOrTvPlayFocusStartsAtOnceAndOnlyOnce() {
        val d = dwell()
        var started = 0
        d.arm { started++ }
        clock += 200
        assertTrue(d.fire())
        assertEquals(1, started)
        assertEquals(listOf("prewarm: dwell 200 start"), lines)
        gate.complete(Unit)
        assertFalse("the timer finds nothing left", d.fire())
        d.leave()
        assertEquals(1, started)
        assertEquals(1, lines.size)
    }

    @Test fun aReopenRearmsAndOnlyTheLatestStartRuns() {
        val d = dwell()
        val started = mutableListOf<String>()
        d.arm { started += "first" }
        d.leave()
        gate = CompletableDeferred()
        d.arm { started += "reopen" }
        clock += 1_500
        gate.complete(Unit)
        assertEquals(listOf("reopen"), started)
        assertEquals(listOf("prewarm: left before dwell", "prewarm: dwell 1500 start"), lines)
    }

    @Test fun castleExpiresIsReadInAnyCase() {
        val now = 1_800_000_000_000L
        val at = now / 1000 + 3_600
        assertEquals(at * 1000, UrlExpiry.at("https://img1.hscow.com/a/index.m3u8?Expires=$at&Signature=x", now))
        assertEquals(at * 1000, UrlExpiry.at("https://x.test/a.m3u8?EXP=$at", now))
        assertEquals(at * 1000, UrlExpiry.at("https://x.test/a.m3u8?Expire=$at&E=1", now))
    }
}
