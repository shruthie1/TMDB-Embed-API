package com.chitram.app

import com.chitram.app.ui.common.DetailLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Details page for rotation and TV (owner 2026-11-24): phone landscape showed the
 * backdrop as a 43% strip and Play below the screen edge.
 */
class DetailRotationTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    @Test fun layoutModeFollowsTheWindowShape() {
        // CPH2447 at density 640: 360 x 804 dp portrait, 804 x 360 dp landscape.
        assertEquals(DetailLayout.Mode.TALL, DetailLayout.mode(360f, 804f))
        assertEquals(DetailLayout.Mode.WIDE, DetailLayout.mode(804f, 360f))
        // Fire TV 1080p at 320 dpi: 960 x 540 dp.
        assertEquals(DetailLayout.Mode.WIDE, DetailLayout.mode(960f, 540f))
        assertEquals(DetailLayout.Mode.TALL, DetailLayout.mode(400f, 400f))
    }

    @Test fun wideHeroFillsTheScreenAndPlayIsAboveTheFold() {
        // Right-side nav bar: no bottom inset, so the hero is the full screen height.
        assertEquals(360f, DetailLayout.wideHeroHeight(360f, 0f))
        assertEquals(336f, DetailLayout.wideHeroHeight(360f, 24f))
        // Status bar up to 48 dp: the hero content (poster, title, actions) still fits in 360 dp.
        assertTrue(DetailLayout.wideContentHeight(48f) <= DetailLayout.wideHeroHeight(360f, 0f))
        // A smaller landscape phone (320 dp tall) still fits with a 24 dp status bar.
        assertTrue(DetailLayout.wideContentHeight(24f) <= 320f)
    }

    @Test fun portraitArtIs16by9PlusOverlap() {
        assertEquals(242.5f, DetailLayout.tallArtHeight(360f), 0.01f)
    }

    @Test fun phoneDetailUsesBothHeroesAndKeepsInsets() {
        val s = src("ui/phone/PhoneApp.kt")
        val d = s.substringAfter("private fun PhoneDetail(").substringBefore("\n}\n")
        assertTrue(d.contains("DetailLayout.mode(maxWidth.value, maxHeight.value)"))
        assertTrue(d.contains("WideHero(t.backdrop, heroH"))
        assertTrue(d.contains("TallHero(t.backdrop"))
        assertTrue("list stops above the nav bar", d.contains("padding(bottom = navBottom)"))
        assertTrue("side insets for cutout and side nav bar", d.contains("WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)"))
        assertFalse("the old 45% landscape cap is gone", d.contains("0.45f"))
        // Rotation keeps the overview state (hoisted, saveable).
        assertTrue(d.contains("var overviewOpen by rememberSaveable(type, id)"))
        val wide = s.substringAfter("private fun WideHero(").substringBefore("\n}\n")
        assertTrue("backdrop fills the hero", wide.contains("Art(backdrop, Api.BACKDROP_PHONE, Modifier.fillMaxSize()"))
    }

    @Test fun oneActionRowWithRoundRefresh() {
        val s = src("ui/phone/PhoneApp.kt")
        val a = s.substringAfter("private fun DetailActions(").substringBefore("\n}\n")
        assertTrue(a.contains("OutlinedIconButton(onClick = refresh.onClick"))
        assertTrue(a.contains("contentDescription = refresh.desc"))
        // Tall: Start over, My List, Refresh in one Row after Play.
        val tall = a.substringAfter("} else Column(modifier) {")
        val iStart = tall.indexOf("startOver("); val iList = tall.indexOf("myList("); val iRef = tall.indexOf("refreshIcon()")
        assertTrue(iStart in 0 until iList && iList < iRef)
        val d = s.substringAfter("private fun PhoneDetail(").substringBefore("\n}\n")
        assertFalse("no separate Refresh sources text line", d.contains("TextButton(onClick = { vm.refreshSources() }"))
        // Rotation does not re-create the activity, so nothing re-fetches.
        val manifest = listOf(File("src/main/AndroidManifest.xml"), File("app/src/main/AndroidManifest.xml")).first { it.exists() }.readText()
        assertTrue(manifest.contains("orientation|screenSize"))
    }

    @Test fun tvBackdropFillsTheScreenAndRefreshIsARoundIcon() {
        val tv = src("ui/tv/TvApp.kt")
        val d = tv.substringAfter("private fun TvDetail(").substringBefore("\n}\n")
        assertTrue(d.contains("Art(t?.backdrop, Api.BACKDROP_TV, Modifier.fillMaxSize()"))
        assertFalse(d.contains("fillMaxHeight(0.92f)"))
        // D-pad order follows the row: Play, Start over, My List, Refresh.
        val iPlay = d.indexOf("TvButton(DetailFocus.label("); val iStart = d.indexOf("TvButton(\"Start over\""); val iList = d.indexOf("\"In My List\" else \"My List\""); val iRef = d.indexOf("TvButton(\"\", primary = false, icon = Icons.Filled.Refresh")
        assertTrue(iPlay in 0 until iStart && iStart < iList && iList < iRef)
        assertTrue("Play still takes the first focus", d.contains("playFocus.focusWhenAttached()"))
    }
}
