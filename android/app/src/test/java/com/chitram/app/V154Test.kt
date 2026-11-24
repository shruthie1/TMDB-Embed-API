package com.chitram.app

import com.chitram.app.player.DirectRoute
import com.chitram.app.player.PlayPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 1.2.54 NetMirror switch. Measured 2026-11-24 through the VM proxy: the NetMirror
 * Netflix mp4 (bcdnxw, H.264) has a 7,323,216-byte moov at the front of a
 * 1,186,031,444-byte file. ExoPlayer knows no duration and buffers nothing until
 * all of it is in, so on a slow link the 8 s "no response" cut (and the 10 s
 * direct cut) killed a download that was still flowing.
 */
class V154Test {
    private val gap = PlayPolicy.SWITCH_FLOW_GAP_MS

    @Test fun bytesStillFlowingAt8sAreNotDead() {
        assertEquals(PlayPolicy.Switch.WAIT, PlayPolicy.switchVerdict(8_000, alive = false, frames = false, flowing = true))
        assertEquals(PlayPolicy.Switch.WAIT, PlayPolicy.switchVerdict(30_000, alive = false, frames = false, flowing = true))
        assertEquals(PlayPolicy.Switch.DEAD, PlayPolicy.switchVerdict(PlayPolicy.SWITCH_FLOWING_MAX_MS, alive = false, frames = false, flowing = true))
    }

    @Test fun bytesStoppedKeepsTheOldCuts() {
        assertEquals(PlayPolicy.Switch.DEAD, PlayPolicy.switchVerdict(8_000, alive = false, frames = false, flowing = false))
        assertEquals(PlayPolicy.Switch.DEAD, PlayPolicy.switchVerdict(20_000, alive = true, frames = false, flowing = false))
    }

    @Test fun flowingIsMeasuredFromThisPlaysBytes() {
        assertEquals(true, PlayPolicy.bytesFlowing(lastBytesAt = 10_000, playStartedAt = 1_000, now = 10_000 + gap - 1))
        assertEquals(false, PlayPolicy.bytesFlowing(lastBytesAt = 10_000, playStartedAt = 1_000, now = 10_000 + gap))
        assertEquals("bytes from before this play never count", false, PlayPolicy.bytesFlowing(lastBytesAt = 500, playStartedAt = 1_000, now = 1_200))
        assertEquals(false, PlayPolicy.bytesFlowing(lastBytesAt = 0, playStartedAt = 0, now = 100))
    }

    @Test fun aDirectProgressiveRowStillDownloadingIsNotSentToTheProxyAt10s() {
        assertNull(DirectRoute.stallReason(10_000, framed = false, segmentLoaded = false, idleMs = 200, progressive = true))
        assertNull(DirectRoute.stallReason(30_000, framed = false, segmentLoaded = false, idleMs = 200, progressive = true))
        assertEquals("no-first-frame-10s", DirectRoute.stallReason(10_000, framed = false, segmentLoaded = false, idleMs = gap, progressive = true))
        assertEquals("no-first-frame-45s", DirectRoute.stallReason(PlayPolicy.SWITCH_FLOWING_MAX_MS, framed = false, segmentLoaded = false, idleMs = 200, progressive = true))
        // HLS keeps its measured 10 s cut.
        assertEquals("no-first-frame-10s", DirectRoute.stallReason(10_000, framed = false, segmentLoaded = false, idleMs = 200))
    }
}
