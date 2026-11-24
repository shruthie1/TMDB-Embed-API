package com.chitram.app

import com.chitram.app.player.PlayPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 1.2.55 (phone 1.2.54, movie/1359490, 2026-11-24): every ShowsSt segment on
 * p16-sg.tiktokcdn.com is a 70 B 1x1 PNG. The player fetched them forever,
 * direct then via /ts-proxy, and never failed over. Three tiny media loads in
 * a row before the first frame fail the row.
 */
class BadSegmentsTest {
    @Test fun threeTinySegmentsFailTheRow() {
        val b = PlayPolicy.BadSegments()
        assertNull(b.onMedia(70, text = false))
        assertNull(b.onMedia(70, text = false))
        assertEquals("3x70B", b.onMedia(70, text = false))
    }

    @Test fun aRealSegmentResetsTheRun() {
        val b = PlayPolicy.BadSegments()
        b.onMedia(70, text = false); b.onMedia(70, text = false)
        assertNull(b.onMedia(1_400_000, text = false))
        assertNull(b.onMedia(70, text = false))
        assertNull(b.onMedia(70, text = false))
        assertEquals("3x70B", b.onMedia(70, text = false))
    }

    @Test fun captionsAndUnknownSizesDoNotCount() {
        val b = PlayPolicy.BadSegments()
        repeat(5) { assertNull(b.onMedia(300, text = true)) }
        repeat(5) { assertNull(b.onMedia(-1, text = false)) }
        assertNull(b.onMedia(70, text = false))
    }

    @Test fun reportsTheLargestTinySizeAndFiresOnce() {
        val b = PlayPolicy.BadSegments()
        b.onMedia(70, text = false); b.onMedia(512, text = false)
        assertEquals("3x512B", b.onMedia(0, text = false))
        assertNull(b.onMedia(70, text = false))
        b.reset()
        b.onMedia(70, text = false); b.onMedia(70, text = false)
        assertEquals("3x70B", b.onMedia(70, text = false))
    }

    @Test fun aKilobyteIsMedia() {
        val b = PlayPolicy.BadSegments()
        repeat(5) { assertNull(b.onMedia(PlayPolicy.BAD_SEGMENT_BYTES, text = false)) }
    }
}
