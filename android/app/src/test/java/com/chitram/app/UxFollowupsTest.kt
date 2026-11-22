package com.chitram.app

import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Progress
import com.chitram.app.data.SeasonInfo
import com.chitram.app.ui.common.DetailVm
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 2026-11-22 UX pass follow-ups: details-page on-device prewarm, Languages save
 * order, TV Search/Browse Try again, phone Person skeleton. No Compose test
 * harness here, so the UI parts check the source.
 */
class UxFollowupsTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    private fun fn(s: String, name: String) = s.substringAfter("fun $name(").substringBefore("\n    }\n")

    @Test fun detailLoadPrewarmsOnDeviceOnceOffTheMainThreadAndNeverCallsTheVm() {
        val vms = src("ui/common/Vms.kt")
        val detail = vms.substringAfter("class DetailVm").substringBefore("class PersonVm")
        val load = fn(detail, "load")
        // Same title again only refreshes local state: the prewarm is after the key guard.
        assertTrue(load.indexOf("if (key == k) { refreshLocal(); return }") < load.indexOf("prewarm("))
        assertEquals("one movie call and one show call in load()", 2, Regex("""\bprewarm\(""").findAll(load).count())
        assertTrue(load.contains("if (t.mediaType != \"tv\") prewarm(t, 0, 0)"))
        assertTrue(load.contains("prewarm(t, ps, pe)"))
        val helper = fn(detail, "prewarm")
        // P13: the start waits for the dwell; the dwell timer (and so the start) runs off the main thread.
        assertTrue("after the dwell", helper.contains("dwell.arm {"))
        assertTrue("off the main thread", vms.substringAfter("class PrewarmDwell").substringBefore("class DetailVm").contains("context: kotlin.coroutines.CoroutineContext = Dispatchers.IO"))
        assertTrue("failure is silent, on-device only", helper.contains("runCatching { g.onDevice.prewarm("))
        assertFalse("no VM prefetch left", vms.contains("prefetchStreams"))
        assertFalse("no VM prefetch left", src("data/Api.kt").contains("prefetch", ignoreCase = true))
    }

    @Test fun showPrefetchTargetsTheEpisodePlayOpens() {
        val seasons = listOf(SeasonInfo(0, "Specials", 3), SeasonInfo(1, "S1", 10), SeasonInfo(2, "S2", 8))
        assertEquals(1 to 1, DetailVm.prefetchEpisode(null, seasons))
        assertEquals(1 to 1, DetailVm.prefetchEpisode(null, emptyList()))
        assertEquals(2 to 1, DetailVm.prefetchEpisode(null, listOf(SeasonInfo(2, "S2", 8))))
        val next = Progress("tv", 7L, season = 2, episode = 4, positionMs = 0, durationMs = 0)
        assertEquals(2 to 4, DetailVm.prefetchEpisode(next, seasons))
    }

    @Test fun languagesSaveInSupportedOrderNotTapOrder() {
        val p = LanguagePrefs(MemoryKeyValue())
        p.saveChosen(listOf("kn", "hi", "te"))
        assertEquals(listOf("te", "hi", "kn"), p.langs())
        assertEquals("langs=te,hi,kn", p.query())
        p.saveChosen(listOf("ml", "ta", "hi", "kn", "te")) // re-added Telugu last
        assertEquals(listOf("te", "ta", "hi", "ml", "kn"), p.langs())
        p.saveChosen(listOf("HI", "xx", "ta", "ta"))
        assertEquals(listOf("ta", "hi"), p.langs())
        p.saveChosen(emptyList())
        assertTrue(p.hasPrefs())
        assertEquals(emptyList<String>(), p.langs())
        for (f in listOf("ui/phone/PhoneApp.kt", "ui/tv/TvApp.kt")) {
            val s = src(f)
            assertTrue("$f saves canonical order", s.contains("prefs.saveChosen(chosen)"))
            assertFalse("$f no tap-order save", s.contains("prefs.save(chosen"))
        }
    }

    @Test fun tvSearchAndBrowseErrorsHaveAFocusableTryAgain() {
        val tv = src("ui/tv/TvApp.kt")
        val browse = tv.substringAfter("private fun TvBrowse(").substringBefore("\n}\n")
        assertTrue(browse.contains("TvChip(\"Try again\", modifier = Modifier.focusRequester(retry)) { vm.retry() }"))
        assertTrue(browse.contains("if (vm.titles.isEmpty()) LaunchedEffect(err) { retry.focusWhenAttached() }"))
        val search = tv.substringAfter("private fun TvSearch(").substringBefore("\n}\n")
        assertTrue(search.contains("TvChip(\"Try again\", modifier = Modifier.focusRequester(retry)) { vm.retry() }"))
        assertTrue("focused when the error shows", search.contains("LaunchedEffect(err) { if (toResults || !fieldFocused) retry.focusWhenAttached() }"))
        assertTrue("D-pad Down from the field reaches it", search.contains("if (vm.error != null) { kb?.hide(); runCatching { retry.requestFocus() } }"))
    }

    @Test fun phonePersonLoadsIntoASkeleton() {
        val s = src("ui/phone/PhoneApp.kt")
        val person = s.substringAfter("private fun PhonePerson(").substringBefore("\n}\n")
        assertFalse("no spinner on the person page", person.contains("CircularProgressIndicator"))
        assertTrue(person.contains("if (d == null) items(12, key = { \"sk\$it\" }) { CardSkeleton(104.dp) }"))
    }
}
