package com.chitram.app

import com.chitram.app.player.netmirrorCheck
import com.chitram.app.player.streamCount
import com.chitram.app.resolve.StepException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 1.2.14: server sheet copy. "1 streams" read wrong, and "Check for more
 * streams" on NetMirror merged 0 rows silently, so a tap looked dead.
 */
class V129Test {
    @Test fun `one stream is singular`() {
        assertEquals("1 stream", streamCount(1))
        assertEquals("2 streams", streamCount(2))
        assertEquals("0 streams", streamCount(0))
    }

    @Test fun `netmirror check with no rows says so`() = runBlocking {
        val (rows, note) = netmirrorCheck { emptyList<String>() }
        assertTrue(rows.isEmpty())
        assertEquals("No NetMirror streams for this title", note)
    }

    @Test fun `netmirror check with rows reports the count`() = runBlocking {
        val (rows, note) = netmirrorCheck { listOf("a", "b") }
        assertEquals(2, rows.size)
        assertEquals("2 added", note)
    }

    @Test fun `netmirror step failure says unavailable`() = runBlocking {
        val (rows, note) = netmirrorCheck<String> { throw StepException("netmirror", 0, "login") }
        assertTrue(rows.isEmpty())
        assertEquals("NetMirror unavailable", note)
    }
}
