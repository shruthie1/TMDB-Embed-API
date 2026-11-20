package com.chitram.app

import com.chitram.app.ui.common.playerMenuLayout
import org.junit.Assert.*
import org.junit.Test

class PlayerMenuLayoutTest {
    @Test fun phonePlaybackGetsInsetRoundedPanelRatherThanOldFullHeightDrawer() {
        val p = playerMenuLayout(844f, 390f, false)
        assertFalse(p.bottomSheet)
        assertTrue(p.inset > 0)
        assertTrue(p.width < 844f / 2)
        assertTrue(p.height < 390f)
        assertTrue(p.width + 2 * p.inset <= 844f)
        assertTrue(p.height + 2 * p.inset <= 390f)
    }
    @Test fun portraitUsesBottomSheetAndRotationGetsLandscapePanel() {
        val p = playerMenuLayout(390f, 844f, false)
        assertTrue(p.bottomSheet)
        assertEquals(390f, p.width)
        assertTrue(p.height < 844f)
        val next = playerMenuLayout(844f, 390f, false)
        assertFalse(next.bottomSheet)
        assertTrue(next.inset > 0)
    }
    @Test fun tvRetainsEdgePanelAndSmallWindowsNeverOverflow() {
        val tv = playerMenuLayout(960f, 540f, true)
        assertFalse(tv.bottomSheet)
        assertEquals(540f, tv.height)
        assertEquals(0f, tv.inset)
        for ((w,h) in listOf(320f to 180f, 200f to 320f, 160f to 90f)) {
            val p = playerMenuLayout(w,h,false)
            assertTrue(p.width > 0 && p.height > 0)
            assertTrue(p.width + p.inset*2 <= w)
            assertTrue(p.height + p.inset*2 <= h)
        }
    }
}
