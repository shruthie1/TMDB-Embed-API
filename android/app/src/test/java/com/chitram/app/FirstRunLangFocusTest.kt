package com.chitram.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Owner: the first-run language picker opens with Telugu chosen, so focus must
 * land on Done (one OK accepts), not on the Telugu chip. The Languages screen
 * (firstRun = false) shares TvLangs and keeps focus on the first chip.
 * No Compose test harness here, so this checks the source.
 */
class FirstRunLangFocusTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    @Test fun tvFirstRunFocusesDoneAndLanguagesScreenKeepsFirstChip() {
        val body = src("ui/tv/TvApp.kt").substringAfter("private fun TvLangs(firstRun: Boolean").substringBefore("\n}\n")
        assertTrue("TvLangs must exist", body.isNotEmpty())
        assertTrue("first run must open with Telugu chosen", body.contains("if (firstRun) add(\"te\")"))
        assertTrue("initial focus must be Done on first run, first chip otherwise",
            body.contains("(if (firstRun) done else first).focusWhenAttached()"))
        assertTrue("Done button must carry the done requester",
            Regex("""TvButton\(if \(chosen\.isEmpty\(\)\) "Done"[^\n]*modifier = Modifier\.focusRequester\(done\)""").containsMatchIn(body))
        assertTrue("first chip keeps its requester for the Languages screen",
            body.contains("if (i == 0) Modifier.focusRequester(first)"))
    }
}
