package com.chitram.app

import com.chitram.app.resolve.MappleConfig
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.ResolveConfig
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 1.2.7: mapple Telugu-first front choice. Kubera (1171101): the Hindi-only
 * "mapple" front answered fast and won after betterWaitMs (2500ms) before the
 * Telugu front s12 (9th of 13, 3 in parallel) answered. Its MPEG-TS segments
 * then crashed media3. The language-less hit must wait for slower fronts.
 */
class V127Test {
    private data class Hit(val front: String, val telugu: Boolean)

    /** Each front answers after its delay; null = not on that front. */
    private suspend fun race(cfg: MappleConfig, answers: Map<String, Pair<Long, Hit?>>, order: List<String> = cfg.fronts): Hit? =
        MappleResolver.raceFronts<Hit>(order, cfg.frontParallelism, cfg.betterWaitMs, cfg.betterWaitMaxMs, wanted = { it.telugu }) { front ->
            val (ms, hit) = answers[front] ?: (50L to null)
            delay(ms)
            hit
        }

    @Test fun teluguFrontAt3000msBeatsHindiFrontAt100ms() = runBlocking {
        val cfg = MappleConfig()
        assertEquals(2500L, cfg.betterWaitMs)
        val r = race(cfg, mapOf(
            "mapple" to (100L to Hit("mapple", telugu = false)),
            "s12" to (3000L to Hit("s12", telugu = true)),
        ), order = listOf("mapple", "s12"))
        assertEquals(Hit("s12", true), r)
    }

    @Test fun kuberaDefaultOrderReachesS12() = runBlocking {
        // Default 13 fronts, 3 at a time. Slow empty fronts push s12 (9th) past 2500ms.
        val cfg = MappleConfig()
        val answers = cfg.fronts.associateWith { (800L to null as Hit?) }.toMutableMap()
        answers["mapple"] = 100L to Hit("mapple", telugu = false)
        answers["s12"] = 1500L to Hit("s12", telugu = true)
        val t0 = System.currentTimeMillis()
        val r = race(cfg, answers)
        assertEquals(Hit("s12", true), r)
        assertTrue("took ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < cfg.betterWaitMaxMs)
    }

    @Test fun teluguHitWinsAtOnce() = runBlocking {
        val cfg = MappleConfig()
        val t0 = System.currentTimeMillis()
        val r = race(cfg, mapOf(
            "s25" to (100L to Hit("s25", telugu = true)),
            "mapple" to (5000L to null),
        ), order = listOf("s25", "mapple"))
        assertEquals(Hit("s25", true), r)
        assertTrue("took ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 1000)
    }

    @Test fun noTeluguAnywhereStillPlaysWhenAllFrontsSettle() = runBlocking {
        val cfg = MappleConfig()
        val t0 = System.currentTimeMillis()
        val r = race(cfg, mapOf("mapple" to (100L to Hit("mapple", telugu = false)), "s12" to (300L to null)),
            order = listOf("mapple", "s12"))
        assertEquals(Hit("mapple", false), r)
        assertTrue("took ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 1500)
    }

    @Test fun languageLessHitIsCappedByBetterWaitMax() = runBlocking {
        val cfg = MappleConfig(betterWaitMs = 200, betterWaitMaxMs = 600)
        val t0 = System.currentTimeMillis()
        val r = race(cfg, mapOf("mapple" to (50L to Hit("mapple", telugu = false)), "s12" to (5000L to Hit("s12", true))),
            order = listOf("mapple", "s12"))
        val took = System.currentTimeMillis() - t0
        assertEquals(Hit("mapple", false), r)
        assertTrue("took ${took}ms", took in 600..2000)
    }

    @Test fun betterWaitMsIsAFloorWhenMaxIsSmaller() = runBlocking {
        val cfg = MappleConfig(betterWaitMs = 800, betterWaitMaxMs = 100)
        val r = race(cfg, mapOf("mapple" to (50L to Hit("mapple", telugu = false)), "s12" to (500L to Hit("s12", true))),
            order = listOf("mapple", "s12"))
        assertEquals(Hit("s12", true), r)
    }

    @Test fun nothingAnywhereIsNull() = runBlocking {
        assertNull(race(MappleConfig(), emptyMap(), order = listOf("s25", "mapple")))
    }

    @Test fun onlyAPreferredLanguageFrontIsRemembered() {
        assertEquals("s12", MappleResolver.nextStoredFront(null, "s12", hitWanted = true))
        assertEquals("s12", MappleResolver.nextStoredFront("mapple", "s12", hitWanted = true))
        assertNull(MappleResolver.nextStoredFront(null, "mapple", hitWanted = false))
        assertEquals("s12", MappleResolver.nextStoredFront("s12", "mapple", hitWanted = false))
    }

    @Test fun betterWaitMaxMsParsesAndClamps() {
        assertEquals(12_000L, MappleConfig().betterWaitMaxMs)
        assertEquals(30_000L, ResolveConfig.parse("""{"mapple":{"betterWaitMaxMs":99999999}}""").mapple.betterWaitMaxMs)
        assertEquals(4000L, ResolveConfig.parse("""{"mapple":{"betterWaitMaxMs":4000}}""").mapple.betterWaitMaxMs)
        assertEquals(12_000L, ResolveConfig.parse("""{"mapple":{"betterWaitMaxMs":"bad"}}""").mapple.betterWaitMaxMs)
    }
}
