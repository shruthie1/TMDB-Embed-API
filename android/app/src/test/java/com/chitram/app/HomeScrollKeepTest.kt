package com.chitram.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Phone Home lost its scroll position after the player. PhoneApp returned early
 * for Screen.Player before it remembered the Home list state, so that state left
 * the composition and Home came back at the top (hero + Continue watching).
 * TvApp already remembers it unconditionally. No Compose test harness here, so
 * this checks the order in the source.
 */
class HomeScrollKeepTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    @Test fun phoneHomeListStateIsRememberedBeforeThePlayerReturn() {
        val body = src("ui/phone/PhoneApp.kt").substringAfter("fun PhoneApp(nav: Nav)").substringBefore("\n}\n")
        val state = body.indexOf("val homeList = rememberLazyListState()")
        val playerReturn = body.indexOf("if (top is Screen.Player)")
        assertTrue("homeList must exist in PhoneApp", state >= 0)
        assertTrue("Player branch must exist in PhoneApp", playerReturn >= 0)
        assertTrue("homeList must be remembered before the Player early return", state < playerReturn)
    }
}
