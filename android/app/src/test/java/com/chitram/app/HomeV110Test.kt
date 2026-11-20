package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.BrowseFilters
import com.chitram.app.data.DiscoverResponse
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.data.PersonResponse
import com.chitram.app.data.Progress
import com.chitram.app.data.ProgressStore
import com.chitram.app.data.RecentSearchStore
import com.chitram.app.data.RowResponse
import com.chitram.app.data.SeasonResponse
import com.chitram.app.data.Title
import com.chitram.app.data.TitleFull
import com.chitram.app.ui.common.HomeRows
import com.chitram.app.ui.common.Row
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 1.1.0 parity: cast, person, seasons, recommendations, browse. Real fixtures from 2026-11-20. */
class HomeV110Test {
    private val json = Api.json

    @Test fun castCreditsAndFacts() {
        val m = json.decodeFromString(TitleFull.serializer(), Fixtures.read("title_movie.json"))
        assertEquals(12, m.credits.size)
        val first = m.credits.first()
        assertEquals(108215L, first.id)
        assertEquals("Allu Arjun", first.name)
        assertEquals("Pushpa Raj", first.character)
        assertEquals("/T0for90ZpP77Fbz1Tptjn8kqms.jpg", first.profile)
        assertEquals(listOf("Sukumar"), m.director)
        assertEquals(listOf("India"), m.country)
        val tv = json.decodeFromString(TitleFull.serializer(), Fixtures.read("title_tv.json"))
        assertEquals("Peter Dinklage", tv.credits.first().name)
        assertEquals("Winter is coming.", tv.tagline)
        assertTrue(tv.director.isEmpty())
    }

    @Test fun personPage() {
        val p = json.decodeFromString(PersonResponse.serializer(), Fixtures.read("person.json"))
        assertEquals("Allu Arjun", p.person!!.name)
        assertEquals("Acting", p.person!!.knownFor)
        assertEquals(12, p.titles.size)
        assertEquals(690957L, p.titles.first().tmdbId)
        assertTrue(p.titles.all { it.mediaType == "movie" || it.mediaType == "tv" })
        // A missing person parses to an empty response, which the page shows as not found.
        assertNull(json.decodeFromString(PersonResponse.serializer(), "{}").person)
    }

    @Test fun seasonEpisodesHaveStillsAndOverviews() {
        val s = json.decodeFromString(SeasonResponse.serializer(), Fixtures.read("season.json"))
        assertTrue(s.episodes.isNotEmpty())
        val withStill = s.episodes.count { it.still != null }
        val withOverview = s.episodes.count { !it.overview.isNullOrBlank() }
        assertTrue("stills $withStill", withStill > 0)
        assertTrue("overviews $withOverview", withOverview > 0)
    }

    @Test fun similarAndExtraRows() {
        val sim = json.decodeFromString(RowResponse.serializer(), Fixtures.read("similar.json"))
        assertEquals(18, sim.titles.size)
        assertEquals("Irumudi", sim.titles.first().title)
        val genre = json.decodeFromString(RowResponse.serializer(), Fixtures.read("row_genre_28.json"))
        assertEquals("genre-28", genre.kind)
        assertEquals(30, genre.titles.size)
        val up = json.decodeFromString(RowResponse.serializer(), Fixtures.read("row_upcoming.json"))
        assertEquals(18, up.titles.size)
    }

    @Test fun discoverPagingAndQuery() {
        val d = json.decodeFromString(DiscoverResponse.serializer(), Fixtures.read("discover.json"))
        assertEquals(27, d.totalPages)
        assertEquals(524, d.totalResults)
        assertEquals("RRR", d.titles.first().title)
        assertEquals("type=movie&lang=te&page=1", BrowseFilters(langs = listOf("te")).apiQuery(1))
        assertEquals("type=tv&genre=28,18&from=2010&to=2019&min=7&sort=vote_average.desc&page=3",
            BrowseFilters(type = "tv", genres = listOf(28, 18), decade = "2010-2019", minRating = 7, sort = "vote_average.desc").apiQuery(3))
        val f = BrowseFilters(langs = listOf("te", "ta"), genres = listOf(28))
        assertEquals(listOf("Telugu", "Tamil", "Action"), f.active().map { it.first })
        assertEquals(listOf("ta"), f.active()[0].second.langs)
    }

    @Test fun recsDedupeAndVisibility() {
        val base = HomeRows.plan(listOf("te", "hi"))
        val recs = listOf(Row("rec-a", "Because you watched A", rec = true), Row("rec-b", "B", rec = true), Row("rec-c", "C", rec = true))
        val kinds = HomeRows.withRecs(base, recs).map { it.kind }
        assertEquals(kinds.indexOf("trending") + 1, kinds.indexOf("rec-a"))
        assertEquals(kinds.indexOf("series-te") + 1, kinds.indexOf("rec-b"))
        assertEquals(kinds.indexOf("series-hi") + 1, kinds.indexOf("rec-c"))

        fun t(id: Long) = Title(id, "movie", "T$id")
        val raw = mapOf("top10" to listOf(t(1), t(2)), "recent" to listOf(t(2), t(3)), "trending" to listOf(t(3), t(4)))
        val rows = HomeRows.dedupe(base.filter { it.kind in raw.keys }, raw)
        assertEquals(listOf(1L, 2L), rows[0].titles.map { it.tmdbId }) // ranked keeps all
        assertEquals(listOf(3L), rows[1].titles.map { it.tmdbId })
        assertEquals(listOf(4L), rows[2].titles.map { it.tmdbId })
        // Thin rows hide; personal rows hide when empty; failed rows show Retry.
        assertFalse(rows[1].copy(loading = false).shown) // 1 title < thin 4
        assertFalse(Row("continue", "", loading = false).shown)
        assertTrue(Row("te", "", error = true).shown)
        assertFalse(Row("rec-x", "", error = true, rec = true).shown)
    }

    @Test fun heroPoolAndSeeds() {
        fun t(id: Long, bd: String?) = Title(id, "movie", "T$id", backdrop = bd)
        val pool = HomeRows.heroPool(listOf(t(1, null), t(2, "/a")), listOf(t(2, "/a"), t(3, "/b")), (4L..9L).map { t(it, "/x") })
        assertEquals(listOf(2L, 3L, 4L, 5L, 6L, 7L), pool.map { it.tmdbId })

        var now = 1L
        val s = ProgressStore(MemoryKeyValue()) { now++ }
        s.save(Progress("movie", 1, positionMs = 10_000, durationMs = 1_000_000, title = "Low")) // 1%: not a seed
        s.save(Progress("movie", 2, positionMs = 400_000, durationMs = 1_000_000, title = "Mid"))
        s.save(Progress("tv", 3, 1, 1, 990_000, 1_000_000, title = "Show"))
        s.save(Progress("tv", 3, 1, 2, 500_000, 1_000_000, title = "Show"))
        assertEquals(listOf(3L, 2L), s.seeds(3).map { it.tmdbId })
    }

    @Test fun recentSearches() {
        val r = RecentSearchStore(MemoryKeyValue())
        r.add("peddi"); r.add("x"); r.add("Pushpa"); r.add("PEDDI")
        assertEquals(listOf("PEDDI", "Pushpa"), r.all())
        (1..10).forEach { r.add("q$it") }
        assertEquals(RecentSearchStore.MAX, r.all().size)
        r.remove("q10"); assertEquals("q9", r.all().first())
        r.clear(); assertTrue(r.all().isEmpty())
        assertNotNull(r)
    }
}
