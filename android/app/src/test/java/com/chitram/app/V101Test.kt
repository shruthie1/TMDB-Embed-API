package com.chitram.app

import androidx.media3.common.MediaMetadata
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.Progress
import com.chitram.app.data.ProgressStore
import com.chitram.app.player.PlayRequest
import com.chitram.app.player.PlayerVm
import com.chitram.app.ui.common.HomeRows
import com.chitram.app.ui.common.SearchFocus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Logic added in 1.0.1: Continue overview, TV Search focus, now-playing metadata. */
class V101Test {
    @Test fun progressKeepsOverview() {
        val store = ProgressStore(MemoryKeyValue()) { 1000L }
        store.save(Progress("movie", 7, positionMs = 60_000, durationMs = 7_200_000, title = "Peddi", overview = "A village sports drama."))
        assertEquals("A village sports drama.", store.continueWatching().single().overview)
        // Entries saved before 1.0.1 decode without the field.
        assertNull(Progress("movie", 1, positionMs = 1, durationMs = 2).overview)
    }

    @Test fun continueTitlesOverview() {
        val cw = listOf(
            Progress("movie", 1, positionMs = 1, durationMs = 9, title = "A", overview = "saved"),
            Progress("tv", 2, season = 1, episode = 3, positionMs = 1, durationMs = 9, title = "B"),
            Progress("movie", 3, positionMs = 1, durationMs = 9, title = "C"),
        )
        val known = mapOf("movie:1" to "catalogue", "tv:2" to "from row")
        val t = HomeRows.continueTitles(cw) { known[it] }
        assertEquals(listOf("saved", "from row", null), t.map { it.overview }) // saved wins, then known
        assertEquals(listOf("movie:1", "tv:2", "movie:3"), t.map { it.key })
    }

    @Test fun searchFocusWaitsForThisQuery() {
        // IME action pressed: focus moves only when results for this query are in.
        assertTrue(SearchFocus.ready(pending = true, query = "peddi ", resultsFor = "peddi", loading = false, count = 4))
        assertFalse(SearchFocus.ready(pending = true, query = "peddi", resultsFor = "pedd", loading = false, count = 4)) // stale
        assertFalse(SearchFocus.ready(pending = true, query = "peddi", resultsFor = "peddi", loading = true, count = 4))
        assertFalse(SearchFocus.ready(pending = true, query = "zzzz", resultsFor = "zzzz", loading = false, count = 0))
        assertFalse(SearchFocus.ready(pending = false, query = "peddi", resultsFor = "peddi", loading = false, count = 4))
    }

    @Test fun nowPlayingMetadata() {
        val ep = PlayerVm.metadata(PlayRequest("tv", 5, "Show", 2, 4, epTitle = "Pilot", overview = "o"))
        assertEquals("Show", ep.title.toString())
        assertEquals("S2 E4 · Pilot", ep.subtitle.toString())
        assertEquals("o", ep.description.toString())
        assertEquals(MediaMetadata.MEDIA_TYPE_TV_SHOW, ep.mediaType)
        val movie = PlayerVm.metadata(PlayRequest("movie", 6, "Peddi"))
        assertEquals("Peddi", movie.title.toString())
        assertNull(movie.subtitle)
        assertEquals(MediaMetadata.MEDIA_TYPE_MOVIE, movie.mediaType)
        assertEquals(MediaMetadata.EMPTY, PlayerVm.metadata(null))
    }
}
