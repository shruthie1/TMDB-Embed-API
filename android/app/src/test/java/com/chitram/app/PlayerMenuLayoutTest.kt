package com.chitram.app

import com.chitram.app.data.VideoFit
import com.chitram.app.ui.common.MenuTap
import com.chitram.app.ui.common.fitItems
import com.chitram.app.ui.common.fitSize
import com.chitram.app.ui.common.menuTap
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
    @Test fun tvFitRowsCheckCurrentAndApplyInPlace() {
        val rows = fitItems(VideoFit.Fit)
        assertEquals(listOf("Fit", "Fill", "Fit width", "Stretch"), rows.map { it.label })
        assertEquals(listOf("fit:Fit"), rows.filter { it.selected }.map { it.key })
        assertTrue(rows.all { it.group == "Picture" })
        assertEquals(MenuTap.Fit, menuTap(rows[2])) // pick: apply, sheet stays open
        assertEquals(MenuTap.Close, menuTap(rows[0])) // re-pick current: close (A2)
    }
    @Test fun fitSizeMatchesMedia3ResizeModes() {
        val scope = 2.39f // CinemaScope on a 16:9 960x540 TV
        assertEquals(960f to 960f / scope, fitSize(VideoFit.Fit, 960f, 540f, scope)) // letterbox, nothing cropped
        assertEquals(540f * scope to 540f, fitSize(VideoFit.Fill, 960f, 540f, scope)) // crops the sides
        assertEquals(960f to 960f / scope, fitSize(VideoFit.FitWidth, 960f, 540f, scope))
        assertEquals(960f to 540f, fitSize(VideoFit.Stretch, 960f, 540f, scope))
        val tall = 4f / 3f
        assertEquals(540f * tall to 540f, fitSize(VideoFit.Fit, 960f, 540f, tall)) // pillarbox
        assertEquals(960f to 720f, fitSize(VideoFit.FitWidth, 960f, 540f, tall)) // crops top and bottom
        assertEquals(960f to 720f, fitSize(VideoFit.Fill, 960f, 540f, tall))
    }
}
