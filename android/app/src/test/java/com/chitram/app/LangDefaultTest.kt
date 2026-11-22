package com.chitram.app

import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.MemoryKeyValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Owner 2026-11-22: no first-run language popup on phone or TV. A new install
 * saves every language, Telugu first, and opens Home. Saved prefs stay as they
 * are. The Languages tab is the only place to change them. Replaces
 * FirstRunLangFocusTest (the first-run picker and its Done focus are gone).
 */
class LangDefaultTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    @Test fun firstRunSeedsEveryLanguageTeluguFirst() {
        val p = LanguagePrefs(MemoryKeyValue())
        assertFalse(p.hasPrefs())
        p.seedDefault()
        assertTrue(p.hasPrefs())
        assertEquals(listOf("te", "ta", "hi", "ml", "kn"), p.langs())
        assertEquals("Telugu", p.preferredAudio())
        assertEquals("langs=te,ta,hi,ml,kn", p.query())
    }

    @Test fun savedPrefsAreKept() {
        val kv = MemoryKeyValue()
        LanguagePrefs(kv).save(listOf("ta"))
        val p = LanguagePrefs(kv)
        p.seedDefault()
        assertEquals(listOf("ta"), p.langs())
        val skipped = MemoryKeyValue()
        LanguagePrefs(skipped).save(emptyList()) // an old "Skip" stays a skip (every language)
        LanguagePrefs(skipped).seedDefault()
        assertEquals(emptyList<String>(), LanguagePrefs(skipped).langs())
    }

    @Test fun noFirstRunPickerOnPhoneOrTv() {
        val main = src("MainActivity.kt")
        assertTrue("MainActivity seeds the default", main.contains("app.prefs.seedDefault()"))
        assertTrue("MainActivity always opens Home", main.contains("Nav(Screen.Home)"))
        assertFalse(main.contains("Screen.Langs("))
        assertTrue(src("ui/common/Common.kt").contains("data object Langs : Screen"))
        for (f in listOf("ui/phone/PhoneApp.kt", "ui/tv/TvApp.kt")) {
            val s = src(f)
            assertFalse("$f has no first-run path", s.contains("firstRun"))
            assertFalse("$f has no Skip", s.contains("\"Skip\""))
        }
        // The Languages screen keeps focus on the first chip on TV.
        val tv = src("ui/tv/TvApp.kt").substringAfter("private fun TvLangs(").substringBefore("\n}\n")
        assertTrue(tv.contains("LaunchedEffect(Unit) { first.focusWhenAttached() }"))
        assertTrue(tv.contains("addAll(prefs.langs())"))
    }
}
