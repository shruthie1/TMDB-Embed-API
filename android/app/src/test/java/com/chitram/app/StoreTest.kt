package com.chitram.app

import com.chitram.app.data.LanguagePrefs
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.MyListStore
import com.chitram.app.data.PlayerPrefs
import com.chitram.app.data.VideoFit
import com.chitram.app.data.Progress
import com.chitram.app.data.ProgressStore
import com.chitram.app.data.SeasonInfo
import com.chitram.app.data.Title
import com.chitram.app.ui.common.HomeRows
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreTest {
    @Test fun playerFitCyclesAndPersists() {
        val kv = MemoryKeyValue()
        val p = PlayerPrefs(kv)
        assertEquals(null, p.fit) // nothing chosen yet
        assertEquals(VideoFit.Fill, p.fitFor(isTv = false)) // phone: fill the 20:9 panel
        assertEquals(VideoFit.Fit, p.fitFor(isTv = true)) // TV: whole picture
        assertEquals(VideoFit.Fill, VideoFit.Fit.next())
        assertEquals(VideoFit.Stretch, VideoFit.Fill.next())
        assertEquals(VideoFit.Fit, VideoFit.Stretch.next())
        p.fit = VideoFit.Fill
        assertEquals(VideoFit.Fill, PlayerPrefs(kv).fit) // survives a new session
        p.fit = VideoFit.Fit
        assertEquals(VideoFit.Fit, PlayerPrefs(kv).fitFor(isTv = false)) // a choice beats the phone default
        kv.put(PlayerPrefs.FIT, "bogus")
        assertEquals(VideoFit.Fill, PlayerPrefs(kv).fitFor(isTv = false))
    }

    @Test fun languagePrefs() {
        val p = LanguagePrefs(MemoryKeyValue())
        assertFalse(p.hasPrefs())
        assertEquals("Telugu", p.preferredAudio())
        assertEquals(listOf("te", "ta", "hi", "ml", "kn"), p.effective())
        p.save(emptyList()) // Skip
        assertTrue(p.hasPrefs())
        assertEquals(5, p.effective().size)
        p.save(listOf("HI", "xx", "hi", "ta"))
        assertEquals(listOf("hi", "ta"), p.langs())
        assertEquals("Hindi", p.preferredAudio())
        p.save(listOf("hi", "te"))
        assertEquals("Telugu", p.preferredAudio()) // Telugu stays first when chosen
        assertEquals("langs=hi,te", p.query())
    }

    @Test fun homeRowOrder() {
        // Same order as web/lib/homeRows.js: no choice means all five languages.
        val all = HomeRows.plan(emptyList()).map { it.kind }
        assertEquals(listOf("continue", "top10", "recent", "trending", "te", "series-te", "ta", "series-ta"), all.take(8))
        assertEquals(listOf("genre-28", "genre-53", "genre-35", "genre-10749", "genre-10751", "list", "upcoming"), all.takeLast(7))
        assertEquals(21, all.size) // 4 fixed + 5 languages x 2 + 5 genres + 2
        assertEquals(listOf("continue", "top10", "recent", "trending", "hi", "series-hi", "genre-28", "genre-53", "genre-35", "genre-10749", "genre-10751", "list", "upcoming"),
            HomeRows.plan(listOf("hi")).map { it.kind })
        val rows = HomeRows.plan(listOf("ta", "te"))
        assertEquals("Latest Tamil movies", rows.first { it.kind == "ta" }.label)
        assertEquals(listOf("ta", "te"), rows.first { it.kind == "recent" }.seeAll!!.langs)
    }

    @Test fun resumeAndFinished() {
        var t = 1000L
        val s = ProgressStore(MemoryKeyValue()) { t++ }
        s.save(Progress("movie", 1, positionMs = 600_000, durationMs = 7_200_000, title = "A"))
        assertEquals(600_000, s.resumeMs("movie", 1))
        assertEquals(listOf(1L), s.continueWatching().map { it.tmdbId })
        s.save(Progress("movie", 1, positionMs = 7_180_000, durationMs = 7_200_000, title = "A"))
        assertTrue(s.get("movie", 1)!!.finished)
        assertEquals(0, s.resumeMs("movie", 1))
        assertTrue(s.continueWatching().isEmpty())
        s.save(Progress("movie", 2, positionMs = 10, durationMs = 0))
        assertNull(s.get("movie", 2)) // no duration, not saved
    }

    @Test fun nextUpCrossesSeasons() {
        var t = 1L
        val s = ProgressStore(MemoryKeyValue()) { t++ }
        val seasons = listOf(SeasonInfo(1, episodes = 2), SeasonInfo(2, episodes = 3))
        s.save(Progress("tv", 9, 1, 1, 100_000, 3_000_000, title = "Show"))
        assertEquals(1 to 1, s.nextUp(9, seasons)!!.let { it.season to it.episode })
        s.save(Progress("tv", 9, 1, 2, 3_000_000, 3_000_000, title = "Show"))
        val n = s.nextUp(9, seasons)!!
        assertEquals(2 to 1, n.season to n.episode)
        assertEquals(0, n.positionMs)
        s.save(Progress("tv", 9, 2, 3, 3_000_000, 3_000_000, title = "Show"))
        assertNull(s.nextUp(9, seasons)) // series ended
        assertEquals(listOf(9L), s.continueWatching().map { it.tmdbId }) // unknown counts: offers E4
    }

    @Test fun myListToggle() {
        val l = MyListStore(MemoryKeyValue())
        val a = Title(1, "movie", "A")
        assertTrue(l.toggle(a))
        assertTrue(l.contains(a))
        assertFalse(l.toggle(a))
        assertTrue(l.all().isEmpty())
    }
}
