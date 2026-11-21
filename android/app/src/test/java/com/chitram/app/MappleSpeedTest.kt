package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.resolve.FrontBook
import com.chitram.app.resolve.MappleConfig
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.Pow
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * mapple on-device speed (2026-11-21). Fire TV baseline, movie/1261763:
 * pow 4450ms, 8 fronts failed before s7 (Telugu), 12s wait behind s27, 19139ms total.
 */
class MappleSpeedTest {

    // ---- PoW ----------------------------------------------------------------

    /** Live challenge from mapple.fun /api/media-session, 2026-11-21T13:16:13Z; Node solvePow gave 166085. */
    private val liveChallenge = "4f65291cc972a196667f6ad92b19697f49b3be9139bc6911718c25215a3ce7bf"

    @Test fun fastPowGivesNodesNonceOnLiveChallenge() {
        assertEquals("166085", Pow.solve(liveChallenge, 18))
        assertEquals("166085", Pow.solveReference(liveChallenge, 18))
    }

    @Test fun fastPowEqualsReferenceAcrossPaddingEdges() {
        // Prefix lengths around the 55/56/64-byte SHA-256 padding edges, plus long ones.
        for (len in listOf(0, 1, 7, 50, 52, 53, 54, 55, 56, 57, 60, 63, 64, 65, 100, 119, 120, 127, 128, 130)) {
            val ch = (0 until len).joinToString("") { "abcdef0123456789"[(it * 7 + len) % 16].toString() }
            for (d in listOf(1, 6, 11)) assertEquals("len=$len d=$d", Pow.solveReference(ch, d), Pow.solve(ch, d))
        }
        assertEquals("10860", Pow.solve("chitram-test-challenge", 12))
        assertEquals("1198", Pow.solve("9f2c1e7a-pow", 18))
    }

    @Test fun fastPowRespectsMaxAndCancel() {
        // 166085 is the first hit, so a bound at or below it finds nothing.
        assertNull(Pow.solve(liveChallenge, 18, max = 166_085))
        assertEquals("166085", Pow.solve(liveChallenge, 18, max = 166_086))
        assertNull(Pow.solve(liveChallenge, 30, active = { false }))
    }

    /** Laptop JVM timing, printed for the report; the assert only guards a regression. */
    @Test fun fastPowIsFasterThanReference() {
        repeat(2) { Pow.solve(liveChallenge, 18); Pow.solveReference(liveChallenge, 18) } // JIT warm-up
        val t0 = System.nanoTime(); Pow.solveReference(liveChallenge, 18); val ref = (System.nanoTime() - t0) / 1_000_000
        val t1 = System.nanoTime(); Pow.solve(liveChallenge, 18, threads = 1); val one = (System.nanoTime() - t1) / 1_000_000
        val t2 = System.nanoTime(); Pow.solve(liveChallenge, 18); val all = (System.nanoTime() - t2) / 1_000_000
        println("POW-TIMING nonce=166085 reference=${ref}ms fast1thread=${one}ms fastAllThreads=${all}ms threads=${Pow.defaultThreads()}")
        assertTrue("fast ${all}ms vs reference ${ref}ms", all <= ref)
    }

    @Test fun powWorkerErrorIsRethrown() {
        // Review M4: a failing worker must not leave a hole that hides the smallest nonce.
        try { Pow.solve(liveChallenge, 18, threads = 4, active = { throw IllegalStateException("boom") }); org.junit.Assert.fail("must rethrow") }
        catch (e: IllegalStateException) { assertEquals("boom", e.message) }
    }

    // ---- front memory -------------------------------------------------------

    private val fronts = listOf("s25", "mapple", "s2", "s28", "s27", "s10", "s19", "s4", "s12", "s6", "s7", "s8", "s16")
    private val cool = 60_000L

    @Test fun teluguSuccessIsTriedFirstAndSurvivesRestart() {
        val kv = MemoryKeyValue()
        var clock = 1_000_000L
        val book = FrontBook(kv) { clock }
        book.found("s12", wanted = true)
        clock += 1000
        book.found("s7", wanted = true)
        book.found("s27", wanted = false)
        // A new process: same SharedPreferences, new book.
        val again = FrontBook(kv) { clock }
        val plan = again.plan(fronts)
        assertEquals(listOf("s7", "s12", "s27"), plan.order.take(3))
        assertEquals(fronts.toSet(), plan.order.toSet())
    }

    @Test fun cooldownFrontIsSkippedThenHeals() {
        val kv = MemoryKeyValue()
        var clock = 1_000_000L
        val book = FrontBook(kv) { clock }
        book.failed("s10", "SOURCE_COOLDOWN", cool)
        val plan = FrontBook(kv) { clock }.plan(fronts)
        assertEquals(listOf("s10"), plan.skipped)
        assertEquals("s10", plan.order.last()) // skipped = started after every other front, never dropped
        clock += cool + 1
        assertTrue(FrontBook(kv) { clock }.plan(fronts).skipped.isEmpty())
        assertEquals(fronts, FrontBook(kv) { clock }.plan(fronts).order)
    }

    @Test fun scrapeFailedDemotesButNeverSkips() {
        // Review I1: SCRAPE_FAILED is per title. A non-Telugu front goes last, never skipped.
        val kv = MemoryKeyValue()
        var clock = 1_000_000L
        val book = FrontBook(kv) { clock }
        repeat(3) { book.failed("s19", "SCRAPE_FAILED", cool) }
        val plan = book.plan(fronts)
        assertTrue(plan.skipped.isEmpty())
        assertEquals(listOf("s19"), plan.last)
        // Any answer clears it.
        book.notHere("s19")
        assertEquals(fronts, book.plan(fronts).order)
    }

    @Test fun teluguFrontStaysFirstOnPerTitleFailures() {
        val kv = MemoryKeyValue()
        var clock = 1_000_000L
        val book = FrontBook(kv) { clock }
        book.found("s7", wanted = true)
        for (k in listOf("SCRAPE_FAILED", "SCRAPE_FAILED", "TIMEOUT", "OTHER", "SOURCE_TIMEOUT")) {
            clock += 1000
            book.failed("s7", k, cool)
            val plan = FrontBook(kv) { clock }.plan(fronts)
            assertEquals(k, "s7", plan.order.first())
            assertTrue(k, plan.last.isEmpty() && plan.skipped.isEmpty())
        }
    }

    @Test fun siteWideFailureDemotesEvenATeluguFront() {
        val kv = MemoryKeyValue()
        var clock = 1_000_000L
        val book = FrontBook(kv) { clock }
        book.found("s7", wanted = true)
        book.failed("s7", "SOURCE_BUSY", cool)
        assertEquals(listOf("s7"), book.plan(fronts).last)
        book.failed("s7", "SOURCE_COOLDOWN", cool)
        assertEquals(listOf("s7"), book.plan(fronts).skipped)
        clock += 10 * 60_000L + 1
        assertEquals("s7", book.plan(fronts).order.first()) // healed, Telugu first again
    }

    @Test fun streakResetsOnceTheLastWindowHasPassed() {
        val kv = MemoryKeyValue()
        var clock = 0L
        val book = FrontBook(kv) { clock }
        book.failed("s2", "SOURCE_COOLDOWN", cool)       // window 60 s
        book.failed("s2", "SOURCE_COOLDOWN", cool)       // inside it: 120 s
        clock = 3 * 24 * 3600_000L                       // days later
        book.failed("s2", "SOURCE_COOLDOWN", cool)       // fresh streak: 60 s again
        clock += cool - 1
        assertEquals(listOf("s2"), book.plan(fronts).skipped)
        clock += 2
        assertTrue(book.plan(fronts).skipped.isEmpty())
    }

    @Test fun newFailureKindReplacesTheOldWindow() {
        // Review M1: a 10-min cooldown followed by a TIMEOUT is no longer skipped.
        val kv = MemoryKeyValue()
        var clock = 0L
        val book = FrontBook(kv) { clock }
        repeat(6) { book.failed("s2", "SOURCE_COOLDOWN", cool) }
        clock += 1000
        book.failed("s2", "TIMEOUT", cool)
        val plan = book.plan(fronts)
        assertTrue(plan.skipped.isEmpty())
        assertEquals(listOf("s2"), plan.last)
    }

    @Test fun neverSkipsEveryFront() {
        val kv = MemoryKeyValue()
        val book = FrontBook(kv) { 5_000L }
        for (f in listOf("s25", "s12")) book.failed(f, "SOURCE_COOLDOWN", cool)
        val plan = book.plan(listOf("s25", "s12"))
        assertTrue(plan.skipped.isEmpty())
        assertEquals(listOf("s25", "s12"), plan.order)
    }

    @Test fun cooldownDoublesAndCapsAtTenMinutes() {
        val kv = MemoryKeyValue()
        var clock = 0L
        val book = FrontBook(kv) { clock }
        repeat(8) { book.failed("s2", "SOURCE_COOLDOWN", cool) }
        clock = 10 * 60_000L - 1
        assertEquals(listOf("s2"), book.plan(fronts).skipped)
        clock = 10 * 60_000L + 1
        assertTrue(book.plan(fronts).skipped.isEmpty())
    }

    @Test fun legacyRememberedFrontStillLeads() {
        val kv = MemoryKeyValue()
        kv.put(MappleResolver.KEY_FRONT, "s12")
        assertEquals("s12", FrontBook(kv) { 0L }.plan(fronts).order.first())
    }

    @Test fun corruptStoreIsIgnored() {
        val kv = MemoryKeyValue()
        kv.put(FrontBook.KEY, "{not json")
        assertEquals(fronts, FrontBook(kv) { 0L }.plan(fronts).order)
    }

    @Test fun failureKindIsReadFromTheMessage() {
        assertEquals("SOURCE_COOLDOWN", FrontBook.kindOf("mapple front s10: SOURCE_COOLDOWN: cooling"))
        assertEquals("SCRAPE_FAILED", FrontBook.kindOf("mapple front s19: SCRAPE_FAILED"))
        assertEquals("TIMEOUT", FrontBook.kindOf("mapple front s25: timed out after 8000ms"))
        assertEquals("OTHER", FrontBook.kindOf(null))
    }

    // ---- race stats + concurrency --------------------------------------------

    @Test fun raceReportsStatsAndTeluguEndsTheWaitAtOnce() = runBlocking {
        val stats = MappleResolver.RaceStats()
        val t0 = System.currentTimeMillis()
        val r = MappleResolver.raceFronts<Pair<String, Boolean>>(
            listOf("s27", "s7", "s8"), 3, 2500, 12000, wanted = { it.second }, stats = stats,
        ) { f ->
            when (f) {
                "s27" -> { delay(50); f to false }
                "s7" -> { delay(300); f to true }
                else -> { delay(5000); null }
            }
        }
        val took = System.currentTimeMillis() - t0
        assertEquals("s7" to true, r)
        assertTrue("took ${took}ms", took < 1500)
        assertEquals(3, stats.started.get())
        assertTrue(stats.fallbackAt.get() > 0)
    }

    // ---- early return + background Telugu (mapple-speed-2) --------------------

    /**
     * Phone log 2026-11-21 20:37 IST, CPH2447, APK 1.2.42, RRR (movie/579974), race
     * start to settle, scaled 1/10: s25 8890 ms, mapple 8015 ms, s2 3990 ms, s28 1680 ms
     * failed; s27 answered 2000 ms after it started, no Telugu (0 audio tracks); the
     * other 8 fronts failed or were not there, the last at 18.8 s.
     */
    private val rrr = mapOf("s25" to 889L, "mapple" to 802L, "s2" to 399L, "s28" to 168L, "s27" to 200L)
    private val rrrOrder = MappleConfig().fronts

    private suspend fun rrrRace(parallel: Int, bg: kotlinx.coroutines.CoroutineScope?, onBetter: (String?) -> Unit = {}): String? =
        MappleResolver.raceFronts<String>(rrrOrder, parallel, 250, 1200, wanted = { false }, background = bg, onBetter = onBetter) { f ->
            delay(rrr[f] ?: 300L)
            f.takeIf { it == "s27" }
        }

    @Test fun rrrReplayFirstRowNoLongerWaitsForAbsentTelugu() = runBlocking {
        var t0 = System.currentTimeMillis()
        assertEquals("s27", rrrRace(3, null))
        val blocking = System.currentTimeMillis() - t0

        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default)
        val better = kotlinx.coroutines.CompletableDeferred<String?>()
        t0 = System.currentTimeMillis()
        assertEquals("s27", rrrRace(3, scope) { better.complete(it) })
        val early3 = System.currentTimeMillis() - t0
        assertNull("no Telugu front: nothing more", kotlinx.coroutines.withTimeout(5000) { better.await() })

        t0 = System.currentTimeMillis()
        assertEquals("s27", rrrRace(4, scope))
        val early4 = System.currentTimeMillis() - t0
        println("RRR-REPLAY blocking=${blocking}ms early3=${early3}ms early4=${early4}ms (x10 = device ms)")
        // Log: fronts 7673 ms then wait 11130 ms. Early: s27's own 767 ms (scaled); parallel 4 starts s27 at s28's end, about 368 ms.
        assertTrue("blocking $blocking", blocking >= 1500)
        assertTrue("early3 $early3", early3 in 700..1200)
        assertTrue("early4 $early4", early4 in 330..700)
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun earlyRaceReturnsFirstHitAndHandsTeluguToTheBackground() = runBlocking {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default)
        val better = kotlinx.coroutines.CompletableDeferred<Pair<String, Boolean>?>()
        val t0 = System.currentTimeMillis()
        val r = MappleResolver.raceFronts<Pair<String, Boolean>>(
            listOf("s27", "s7", "s8"), 3, 2500, 12000, wanted = { it.second }, background = scope, onBetter = { better.complete(it) },
        ) { f ->
            when (f) {
                "s27" -> { delay(50); f to false }
                "s7" -> { delay(800); f to true }
                else -> { delay(5000); null }
            }
        }
        val took = System.currentTimeMillis() - t0
        assertEquals("s27" to false, r)
        assertTrue("first row in ${took}ms", took < 600)
        assertEquals("s7" to true, kotlinx.coroutines.withTimeout(3000) { better.await() })
        // The Telugu hit ends the background race: s8 (5 s) does not hold it.
        assertTrue("background ended in ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 2000)
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun earlyRaceWithTeluguFirstStopsEverythingAndTellsNull() = runBlocking {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default)
        val better = kotlinx.coroutines.CompletableDeferred<Pair<String, Boolean>?>()
        val finished = java.util.concurrent.atomic.AtomicInteger()
        val r = MappleResolver.raceFronts<Pair<String, Boolean>>(
            listOf("s7", "s8"), 2, 2500, 12000, wanted = { it.second }, background = scope, onBetter = { better.complete(it) },
        ) { f ->
            if (f == "s7") { delay(50); f to true } else { delay(3000); finished.incrementAndGet(); null }
        }
        assertEquals("s7" to true, r)
        assertNull(kotlinx.coroutines.withTimeout(1000) { better.await() })
        delay(3200)
        assertEquals("slow front cancelled", 0, finished.get())
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun earlyRaceCancelledBeforeAnyHitStopsTheRaceAndTellsNull() = runBlocking {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default)
        val better = kotlinx.coroutines.CompletableDeferred<String?>()
        val finished = java.util.concurrent.atomic.AtomicInteger()
        val r = kotlinx.coroutines.withTimeoutOrNull(200) {
            MappleResolver.raceFronts<String>(listOf("a", "b"), 2, 100, 100, wanted = { true }, background = scope, onBetter = { better.complete(it) }) { f ->
                delay(1500); finished.incrementAndGet(); f
            }
        }
        assertNull(r)
        assertNull(kotlinx.coroutines.withTimeout(1000) { better.await() })
        delay(1600)
        assertEquals("race cancelled with its caller", 0, finished.get())
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun earlyRaceKeepsTheSameTeluguCapAsTheBlockingRace() = runBlocking {
        // Telugu after the cap (betterWaitMaxMs) is not delivered, as in the blocking race.
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default)
        val better = kotlinx.coroutines.CompletableDeferred<Pair<String, Boolean>?>()
        val r = MappleResolver.raceFronts<Pair<String, Boolean>>(
            listOf("s27", "s7"), 2, 100, 300, wanted = { it.second }, background = scope, onBetter = { better.complete(it) },
        ) { f -> if (f == "s27") { delay(20); f to false } else { delay(2000); f to true } }
        assertEquals("s27" to false, r)
        assertNull(kotlinx.coroutines.withTimeout(1500) { better.await() })
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
    }

    @Test fun defaultParallelismCoversTheSlowFirstWave() {
        // s25, s2, s28 carry 22-25s caps; with 3 slots they could hold every slot.
        // 4, not more: the rate limit from one home IP is unmeasured (coordinator ruling 2026-11-21).
        assertEquals(4, MappleConfig().frontParallelism)
    }

    @Test fun sessionLivesFiveHoursUnderTheSixHourToken() {
        // requestToken expiresIn 21599999 ms, measured live 2026-11-21T13:16:04Z.
        assertEquals(5 * 60 * 60 * 1000L, MappleConfig().sessionTtlMs)
        assertEquals(18_000_000L, com.chitram.app.resolve.ResolveConfig.parse("""{"mapple":{"sessionTtlMs":18000000}}""").mapple.sessionTtlMs)
        // Never past the token's own 6 h life.
        assertEquals(21_600_000L, com.chitram.app.resolve.ResolveConfig.parse("""{"mapple":{"sessionTtlMs":99999999}}""").mapple.sessionTtlMs)
    }
}
