package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.RowResponse
import com.chitram.app.data.SearchResponse
import com.chitram.app.data.SeasonResponse
import com.chitram.app.data.StreamsResponse
import com.chitram.app.data.TitleFull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parses real responses saved from https://chtrm2.vercel.app on 2026-11-20. */
class ApiParsingTest {
    private val json = Api.json

    @Test fun rows() {
        for (f in listOf("top10.json", "row_te.json", "row_series_te.json", "trending.json")) {
            val r = json.decodeFromString(RowResponse.serializer(), Fixtures.read(f))
            assertTrue("$f has titles", r.titles.isNotEmpty())
            assertTrue(r.titles.all { it.tmdbId > 0 && it.title.isNotEmpty() })
        }
        val top = json.decodeFromString(RowResponse.serializer(), Fixtures.read("top10.json"))
        assertEquals("top10", top.kind)
        assertEquals(1376856L, top.titles.first().tmdbId)
    }

    @Test fun search() {
        val r = json.decodeFromString(SearchResponse.serializer(), Fixtures.read("search.json"))
        assertEquals(770906L, r.titles.first().tmdbId)
        assertEquals("te", r.titles.first().originalLang)
    }

    @Test fun titleMovieAndTv() {
        val m = json.decodeFromString(TitleFull.serializer(), Fixtures.read("title_movie.json"))
        assertEquals(690957L, m.tmdbId)
        assertEquals(179, m.runtimeMin)
        assertTrue(m.poster!!.startsWith("https://"))
        val t = json.decodeFromString(TitleFull.serializer(), Fixtures.read("title_tv.json"))
        assertEquals("tv", t.mediaType)
        assertEquals(null, t.runtimeMin)
        assertEquals(8, t.seasonList.size)
        assertEquals(10, t.seasonList.first().episodes)
    }

    @Test fun season() {
        val s = json.decodeFromString(SeasonResponse.serializer(), Fixtures.read("season.json"))
        assertEquals(1, s.season)
        assertEquals("Winter Is Coming", s.episodes.first().title)
    }

    @Test fun streams() {
        val s = json.decodeFromString(StreamsResponse.serializer(), Fixtures.read("streams.json"))
        assertEquals(s.count, s.streams.size)
        val mapple = s.streams.first { it.provider == "mapple" }
        assertEquals("hevc", mapple.videoCodec)
        assertEquals(720, mapple.levels.first().height)
        assertNotNull(s.streams.first { it.subtitles.isNotEmpty() }.subtitles.first().lang)
        assertTrue(s.providerTimings.containsKey("castletv"))
    }

    /** Live 2026-11-20 /api/streams/movie/1057265 (Peddi): failed on the phone. */
    @Test fun streamsPeddi() {
        val s = json.decodeFromString(StreamsResponse.serializer(), Fixtures.read("streams_peddi.json"))
        assertEquals(3, s.streams.size)
    }

    /** Live response seen on the phone emulator: a timed-out provider reports null. */
    @Test fun streamsNullTiming() {
        val body = Fixtures.read("streams_peddi.json").replace("\"onetouchtv\": 0", "\"onetouchtv\": null")
            .replace("\"onetouchtv\":0", "\"onetouchtv\":null")
        require(body.contains("\"onetouchtv\":null") || body.contains("\"onetouchtv\": null"))
        val s = json.decodeFromString(StreamsResponse.serializer(), body)
        assertEquals(null, s.providerTimings["onetouchtv"])
        assertEquals(3, s.streams.size)
    }

    @Test fun imageSizes() {
        assertEquals("https://image.tmdb.org/t/p/w342/a.jpg", Api.image("/a.jpg", "w342"))
        assertEquals("https://x/y", Api.image("https://x/y", "w342"))
        assertEquals(null, Api.image(null, "w342"))
    }
}
