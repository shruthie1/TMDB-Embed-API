package com.chitram.app

import com.chitram.app.player.LoadingModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Task 9 source guards (mirror of web switchCopyGuard.test.jsx): PlayerVm needs
 * an Application and a player, so its switch wiring is checked as source text.
 */
class SwitchCopyGuardTest {
    private fun file(rel: String) = listOf(File(rel), File("app/$rel")).first { it.exists() }
    private val vm by lazy { file("src/main/java/com/chitram/app/player/PlayerVm.kt").readText() }
    private val ui by lazy { file("src/main/java/com/chitram/app/ui/common/PlayerScreen.kt").readText() }

    private fun body(name: String): String {
        val start = vm.indexOf("fun $name(")
        assertTrue("missing fun $name", start >= 0)
        val next = vm.indexOf("\n    fun ", start + 1).let { if (it < 0) vm.length else it }
        val nextPrivate = vm.indexOf("\n    private fun ", start + 1).let { if (it < 0) vm.length else it }
        return vm.substring(start, minOf(next, nextPrivate))
    }

    @Test fun noSlowNoticeInPlayerCode() {
        val code = (vm + ui).lines().filterNot { it.trimStart().startsWith("//") || it.trimStart().startsWith("*") }
        assertTrue(code.none { Regex("\"[^\"]*\\bis slow\\b[^\"]*\"").containsMatchIn(it) })
    }

    @Test fun loadingViewGetsSwitchingFlag() {
        assertTrue(body("loadingView").contains("switching = switching"))
    }

    @Test fun viewerPicksBeginAnAskedSwitch() {
        // Server menu / Details row, language pick, and pair pick each mark the switch.
        assertEquals(3, Regex("beginAskedSwitch\\(\\)").findAll(body("choose")).count())
        val begin = body("beginAskedSwitch")
        assertTrue(begin.contains("RowState.LEFT"))
        assertTrue(begin.contains("switching = true"))
    }

    @Test fun automaticFailoverNeverSetsSwitching() {
        assertFalse(body("failover").contains("switching = true"))
        assertFalse(body("checkStall").contains("switching = true"))
        assertFalse(body("checkFrozen").contains("switching = true"))
        assertEquals(1, Regex("switching = true").findAll(vm).count())
    }

    @Test fun switchingClearsOnFrameFailureAndNewStart() {
        assertTrue(body("endAttempt").contains("RowState.PLAYING || state == LoadingModel.RowState.FAILED) switching = false"))
        assertTrue(body("resetStart").contains("switching = false"))
    }

    @Test fun failNoticeUsesAttemptsTakenBeforePlay() {
        // The decision is LoadingModel.failNotice (tested in LoadingModelTest); here only the call order.
        for (name in listOf("failover", "toDevice")) {
            val b = body(name).lines().filterNot { it.trimStart().startsWith("//") }.joinToString("\n")
            val snap = b.indexOf("val before = attempts")
            assertTrue("$name snapshots attempts", snap >= 0)
            assertTrue("$name snapshots before endAttempt", snap < b.indexOf("endAttempt("))
            assertTrue("$name snapshots before play", snap < Regex("\\bplay\\(").find(b)!!.range.first)
            assertFalse("$name has no live-attempt notice", b.contains("LoadingModel.advanceNotice("))
        }
        assertEquals(3, Regex("LoadingModel\\.failNotice\\(before, ").findAll(vm).count())
    }

    @Test fun noLanguageFallbackBeforeFirstFrame() {
        // Fallback only when the current source has framed; null before the first frame.
        val line = body("choose").lines().single { it.contains("languageFallback = ") && it.contains("Triple(") }
        assertTrue(line.contains("languageFallback = if (framed) current?.let { Triple("))
        assertTrue(line.trimEnd().endsWith("} else null"))
    }

    @Test fun loadingRowGlyphCoversLeft() {
        assertTrue(ui.contains("LoadingModel.RowState.LEFT ->"))
    }

    // Final-review I2 (2026-11-21): a language pick that lands on a server without
    // that language says so; it neither "didn't start" nor "stopped".
    @Test fun audioMissingSaysNoLanguage() {
        assertTrue(vm.contains("failover(\"\$wanted audio missing\", player.currentPosition.coerceAtLeast(0), missingLang = wanted)"))
        assertTrue(body("failover").contains("missingLang = missingLang)"))
        assertEquals("CastleTV 1 has no Telugu audio. Trying NetMirror.", LoadingModel.Copy.noLanguage("CastleTV 1", "Telugu", "NetMirror"))
        val playing = listOf(LoadingModel.Attempt("a", 0, 5, LoadingModel.RowState.PLAYING))
        assertEquals("A has no Telugu audio. Trying B.", LoadingModel.failNotice(playing, "a", "A", "B", skip = false, missingLang = "Telugu"))
        assertEquals("A has no Telugu audio. Trying B.", LoadingModel.failNotice(emptyList(), "a", "A", "B", skip = false, missingLang = "Telugu"))
        assertEquals("That server has no Telugu audio. Trying the next server.", LoadingModel.advanceNotice(null, null, false, missingLang = "Telugu"))
        assertEquals("A stopped. Trying B.", LoadingModel.failNotice(playing, "a", "A", "B", skip = false))
    }

    @Test fun noLanguageCopyIsByteEqualWithWeb() {
        val web = file("../../web/lib/player/loadingModel.js").readText()
        assertTrue(web.contains("noLanguage: (from, lang, to) => `\${from} has no \${lang} audio. Trying \${to}.`"))
        assertEquals("F has no L audio. Trying T.", LoadingModel.Copy.noLanguage("F", "L", "T"))
    }

    // Step 2 Task 2 (2026-11-21): add-audio lines and caps, byte-equal with web.
    // Each web template literal is filled with the same args and compared to the
    // Kotlin output, so a one-byte drift on either side fails here.
    private fun fill(tpl: String, vars: Map<String, String>) =
        vars.entries.fold(tpl) { acc, (k, v) -> acc.replace("\${$k}", v) }

    private fun webTemplate(web: String, head: String): String {
        val start = web.indexOf(head)
        assertTrue("web missing $head", start >= 0)
        val open = web.indexOf('`', start)
        val close = web.indexOf('`', open + 1)
        return web.substring(open + 1, close)
    }

    @Test fun addAudioCopyIsByteEqualWithWeb() {
        val web = file("../../web/lib/player/loadingModel.js").readText()
        assertEquals("Add audio from another server", LoadingModel.Copy.ADD_AUDIO_GROUP)
        assertEquals("Add Telugu audio from another server", LoadingModel.Copy.addAudio("Telugu"))
        assertEquals("Checking CastleTV for Telugu audio (1 of 3)…", LoadingModel.Copy.checkingAudio("Telugu", "CastleTV", 1, 3))
        assertEquals("Telugu audio added from CastleTV.", LoadingModel.Copy.audioAdded("Telugu", "CastleTV"))
        assertEquals("No server has working Telugu audio. Playback is unchanged.", LoadingModel.Copy.noWorkingAudio("Telugu"))

        assertTrue(web.contains("ADD_AUDIO_GROUP: 'Add audio from another server',"))
        assertTrue(web.contains("addAudio: (lang) => `Add \${lang} audio from another server`,"))
        assertTrue(web.contains("checkingAudio: (lang, server, n, total) => `Checking \${server} for \${lang} audio (\${n} of \${total})…`,"))
        assertTrue(web.contains("audioAdded: (lang, server) => `\${lang} audio added from \${server}.`,"))
        assertTrue(web.contains("noWorkingAudio: (lang) => `No server has working \${lang} audio. Playback is unchanged.`,"))

        val v = mapOf("lang" to "L", "server" to "S", "n" to "2", "total" to "3")
        assertEquals(fill(webTemplate(web, "addAudio:"), v), LoadingModel.Copy.addAudio("L"))
        assertEquals(fill(webTemplate(web, "checkingAudio:"), v), LoadingModel.Copy.checkingAudio("L", "S", 2, 3))
        assertEquals(fill(webTemplate(web, "audioAdded:"), v), LoadingModel.Copy.audioAdded("L", "S"))
        assertEquals(fill(webTemplate(web, "noWorkingAudio:"), v), LoadingModel.Copy.noWorkingAudio("L"))
        val group = Regex("ADD_AUDIO_GROUP: '([^']*)'").find(web)!!.groupValues[1]
        assertEquals(group, LoadingModel.Copy.ADD_AUDIO_GROUP)
    }

    @Test fun addAudioCapsMatchWeb() {
        val web = file("../../web/lib/player/loadingModel.js").readText()
        assertEquals(3, LoadingModel.ADD_AUDIO_MAX_TRIES)
        assertEquals(15_000L, LoadingModel.ADD_AUDIO_TRY_MS)
        assertEquals(30_000L, LoadingModel.ADD_AUDIO_TOTAL_MS)
        assertTrue(web.contains("export const ADD_AUDIO_MAX_TRIES = 3;"))
        assertTrue(web.contains("export const ADD_AUDIO_TRY_MS = 15000;"))
        assertTrue(web.contains("export const ADD_AUDIO_TOTAL_MS = 30000;"))
    }
}
