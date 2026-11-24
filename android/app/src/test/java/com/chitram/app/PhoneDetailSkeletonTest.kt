package com.chitram.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Phone detail showed a centred spinner on a blank page while the title loaded.
 * Now it shows the loaded layout's skeleton with the tapped card's title, poster
 * and backdrop. No Compose test harness here, so this checks the source.
 */
class PhoneDetailSkeletonTest {
    private fun src(rel: String) =
        listOf(File("src/main/java/com/chitram/app/$rel"), File("app/src/main/java/com/chitram/app/$rel")).first { it.exists() }.readText()

    @Test fun detailLoadsIntoASkeletonWithTheCardData() {
        val s = src("ui/phone/PhoneApp.kt")
        val detail = s.substringAfter("private fun PhoneDetail(").substringBefore("\n}\n")
        assertFalse("no spinner on the detail page", detail.contains("CircularProgressIndicator"))
        assertTrue(detail.contains("DetailSkeleton(cardTitle, cardBackdrop, rowPoster, vm.error, wide, heroH, padS, padE)"))
        assertTrue("open() passes the card's title and backdrop",
            s.contains("push(Screen.Detail(t.mediaType, t.tmdbId, t.poster, t.title.takeIf { it.isNotBlank() }, t.backdrop))"))
        assertTrue(s.contains("is Screen.Detail -> PhoneDetail(nav, top.type, top.id, top.poster, top.title, top.backdrop)"))
        val sk = s.substringAfter("private fun DetailSkeleton(").substringBefore("\n}\n")
        for (part in listOf("TallHero(backdrop", "WideHero(backdrop", "Art(poster", "Text(title", "height(48.dp)", "Try again")) assertTrue("skeleton has $part", sk.contains(part))
        for (hero in listOf("private fun TallHero(", "private fun WideHero(")) assertTrue("$hero draws the backdrop", s.substringAfter(hero).substringBefore("\n}\n").contains("Art(backdrop"))
        assertTrue(src("ui/common/Common.kt").contains("val title: String? = null, val backdrop: String? = null) : Screen"))
    }
}
