package com.chitram.app

import com.chitram.app.ui.common.menuAnchored
import com.chitram.app.ui.common.tvAnchoredMenu
import com.chitram.app.ui.tv.TvWeb
import com.chitram.app.ui.tv.nextSlot
import com.chitram.app.ui.tv.pickBelow
import com.chitram.app.ui.tv.railStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The APK TV layout follows the web TV layout (web/app css, web/lib/dpad.js). */
class TvWebLayoutTest {
    private fun dp(cssPx: Float) = cssPx * TvWeb.CSS_PX_DP

    @Test fun webSizesResolveAt1920AndHalveToDp() {
        assertEquals(38.48f, dp(TvWeb.RAIL_W), 0.01f)      // --rail-w 76.96px
        assertEquals(143.48f, dp(TvWeb.RAIL_OPEN_W), 0.01f) // --rail-open-w 286.96px
        assertEquals(28.8f, dp(TvWeb.RAIL_ICON), 0.01f)     // --rail-icon 57.6px
        assertEquals(15.36f, dp(TvWeb.GUTTER), 0.01f)       // --tv-gap 30.72px
        assertEquals(109.44f, dp(TvWeb.CARD_W), 0.01f)      // --tv-card-w 218.88px
        assertEquals(164.16f, dp(TvWeb.POSTER_H), 0.01f)    // 2/3 poster
        assertEquals(378f, dp(TvWeb.HERO_H), 0.01f)         // 70vh of 1080
        assertEquals(1.07f, TvWeb.CARD_SCALE)
        assertEquals(200, TvWeb.CARD_MS)
        assertEquals(1.09f, TvWeb.CONTROL_SCALE)
        assertEquals(180, TvWeb.CONTROL_MS)
    }

    @Test fun downPicksTheCardWithTheMostOverlapThenTheNearestCentre() {
        val row = listOf("a" to (0f to 100f), "b" to (110f to 210f), "c" to (220f to 320f))
        assertEquals("b", pickBelow(130f, 230f, row))      // 80 overlap with b, 10 with c
        assertEquals("a", pickBelow(-5f, 95f, row))
        // No overlap anywhere: nearest centre.
        assertEquals("c", pickBelow(400f, 500f, row))
        assertNull(pickBelow(0f, 10f, emptyList<Pair<String, Pair<Float, Float>>>()))
    }

    @Test fun verticalMovesSkipLoadingRowsAndStopAtThePageEdges() {
        val focusable = listOf(true, false, true, true)
        assertEquals(2, nextSlot(0, 1, focusable))
        assertEquals(0, nextSlot(2, -1, focusable))
        assertNull(nextSlot(0, -1, focusable))           // top: stays, never into the rail
        assertNull(nextSlot(3, 1, focusable))            // bottom: stays
    }

    @Test fun railUpDownStayInsideWithoutWrapping() {
        assertEquals(0, railStep(0, -1, 5))
        assertEquals(4, railStep(4, 1, 5))
        assertEquals(2, railStep(1, 1, 5))
    }

    @Test fun tvSheetsOpenAboveTheirButtonLikePhoneLandscape() {
        assertTrue(menuAnchored(true, true, 960f, 540f))
        assertTrue(menuAnchored(true, false, 844f, 390f))
        assertFalse(menuAnchored(true, false, 390f, 844f))  // portrait keeps the bottom sheet
        assertFalse(menuAnchored(false, true, 960f, 540f))  // no button known: edge panel
        val m = tvAnchoredMenu(960f, 540f)
        assertEquals(249.6f, m.minWidth, 0.01f)
        assertEquals(356.4f, m.maxHeight, 0.01f)
        assertEquals(48f, m.margin, 0.01f)
        assertTrue(m.maxWidth >= m.minWidth && m.maxWidth + 2 * m.margin <= 960f)
        val small = tvAnchoredMenu(320f, 180f)
        assertTrue(small.minWidth <= small.maxWidth && small.maxWidth + 2 * small.margin <= 320f)
        assertTrue(small.maxHeight + 2 * small.margin <= 180f)
    }
}
