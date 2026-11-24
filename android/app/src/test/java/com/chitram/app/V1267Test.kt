package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.player.providerCheck
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.OnDeviceResolver
import com.chitram.app.resolve.OneTouchTvResolver
import com.chitram.app.resolve.ResolveConfigStore
import com.chitram.app.resolve.ShowsstResolver
import com.chitram.app.resolve.StepException
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 1.2.67: provider empty-row audit fixes on the device
 * (.superpowers/sdd/2026-11-22-ux-pass/provider-empty-audit.md).
 */
class V1267Test {
    private val server = MockWebServer()
    private val base = server.url("").toString().trimEnd('/')
    private val codecs = CodecSupport { _, _ -> null }
    private val seen = CopyOnWriteArrayList<RecordedRequest>()

    /** A hung upstream (showsst mirror) may outlive the test: never fail the test on the fake's shutdown. */
    @After fun stop() { runCatching { server.shutdown() } }

    private fun serve(routes: (RecordedRequest) -> MockResponse) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse { seen += request; return routes(request) }
        }
    }

    private fun od(showsst: ShowsstResolver? = null, castle: CastleResolver? = null): OnDeviceResolver {
        val kv = MemoryKeyValue()
        val client = OkHttpClient()
        return OnDeviceResolver(null, ResolveConfigStore(client, "$base/config", kv), MappleResolver(client, HostBook(kv), kv),
            VaplayerResolver(client, HostBook(kv)) { null }, titleFor = { _, _ -> Triple("Mirai", null, null) }, imdbFor = { _, _ -> null },
            castle = castle, showsst = showsst)
    }

    // ---- b: per-title breaker dedupe, skips say why --------------------------------

    @Test fun theSameTitleFailingAgainCountsOnce() = runBlocking {
        serve { MockResponse().setResponseCode(503) }
        val od = od(showsst = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror(base, base))))
        repeat(3) { od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 7, 0, 0, codecs) }
        assertFalse("one title failing 3 times is not a site outage", od.isOpen(OnDeviceResolver.SHOWSST))
        od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 8, 0, 0, codecs)
        od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 9, 0, 0, codecs)
        assertTrue("3 different titles in a row open the breaker", od.isOpen(OnDeviceResolver.SHOWSST))
    }

    @Test fun aBreakerSkipSaysPausedAndAFailureSaysWhy() = runBlocking {
        serve { MockResponse().setResponseCode(503) }
        val od = od(showsst = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror(base, base))))
        val (_, failed) = providerCheck(OnDeviceResolver.SHOWSST) { od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 1, 0, 0, codecs) }
        assertEquals("ShowsSt failed: all 1 mirrors failed for 1", failed)
        od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 2, 0, 0, codecs)
        od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 3, 0, 0, codecs)
        assertTrue(od.isOpen(OnDeviceResolver.SHOWSST))
        val asked = seen.size
        val (rows, paused) = providerCheck(OnDeviceResolver.SHOWSST) { od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 4, 0, 0, codecs) }
        assertTrue(rows.isEmpty())
        assertEquals("ShowsSt paused, try in 5 min", paused)
        assertEquals("a skip sends nothing", asked, seen.size)
    }

    @Test fun aCleanEmptyCheckNamesTheProvider() = runBlocking {
        val (_, note) = providerCheck<String>(OnDeviceResolver.CASTLE) { emptyList() }
        assertEquals("Not on CastleTV", note)
        val (_, nm) = providerCheck<String>(OnDeviceResolver.NETMIRROR) { emptyList() }
        assertEquals(OnDeviceResolver.NOTE_NOT_ON_NETMIRROR, nm)
    }

    /** Every breaker skip in OnDevice logs: no bare `isOpen(..)) return`. */
    @Test fun noSilentBreakerSkip() {
        val src = listOf(File("src/main/java/com/chitram/app/resolve/OnDevice.kt"), File("app/src/main/java/com/chitram/app/resolve/OnDevice.kt")).first { it.exists() }.readText()
        assertFalse(Regex("""isOpen\([A-Za-z_]+\)\)\s*return""").containsMatchIn(src))
        assertTrue(src.contains("[breaker] skip \$name \$titleKey: open"))
        assertTrue(Regex("""skipOpen\(""").findAll(src).count() >= 7)
    }

    /** The Check row exists for every on-device provider, not only NetMirror. */
    @Test fun everyCheckRowKeyIsACheckTap() {
        OnDeviceResolver.run { listOf(MAPPLE, VAPLAYER, CASTLE, MULTIMOVIES, NETMIRROR, SHOWSST, ONETOUCH, VIDRIFT, INSERTUNIT, VIDOUT) }.forEach {
            assertEquals(com.chitram.app.ui.common.MenuTap.Check, com.chitram.app.ui.common.menuTap(com.chitram.app.player.MenuItem("check:$it", "Check")))
        }
    }

    // ---- f: per-call timeouts fit the budgets ------------------------------------------

    @Test fun stepTimeoutsFitTheirBudgets() {
        assertTrue(2 * ShowsstResolver.STEP_TIMEOUT_MS + ShowsstResolver.PROBE_TIMEOUT_MS < OnDeviceResolver.SHOWSST_BUDGET_MS)
        val tries = OneTouchTvResolver.RETRIES + 1
        val backoff = (1..OneTouchTvResolver.RETRIES).sumOf { OneTouchTvResolver.RETRY_DELAY_MS * it }
        assertTrue(tries * OneTouchTvResolver.STEP_TIMEOUT_MS + backoff < OnDeviceResolver.ONETOUCH_BUDGET_MS)
    }

    /** A hung first mirror leaves the second mirror time inside the 15 s budget. */
    @Test fun showsstHungFirstMirrorStillGivesTheSecondMirrorsRow() = runBlocking {
        serve { r ->
            val p = r.path!!
            when {
                p.startsWith("/a/") -> MockResponse().setResponseCode(503).setHeadersDelay(16, TimeUnit.SECONDS)
                p.startsWith("/b/movie") -> MockResponse().setBody("""{"source":{"label":"VidAPI","url":"$base/hls/master","manifest":"x"}}""")
                else -> MockResponse().setBody("#EXTM3U\n")
            }
        }
        val od = od(showsst = ShowsstResolver(OkHttpClient(), listOf(ShowsstResolver.Mirror("$base/a", base), ShowsstResolver.Mirror("$base/b", base))))
        val rows = od.resolveAll(OnDeviceResolver.SHOWSST, "movie", 1, 0, 0, codecs)
        assertEquals(listOf("$base/hls/master"), rows.map { it.url })
    }

    /** A timed-out OneTouchTV call is not asked again (3 x 15 s never fit 20 s). */
    @Test fun oneTouchTimedOutCallIsNotRetried() = runBlocking {
        serve { MockResponse().setResponseCode(500).setHeadersDelay(10, TimeUnit.SECONDS) }
        val t0 = System.currentTimeMillis()
        val r = runCatching { OneTouchTvResolver(OkHttpClient(), base = base, retryDelayMs = 1).resolveAll("movie", 1, "RRR", 2022, null, 0, 0) }
        val ms = System.currentTimeMillis() - t0
        assertTrue(r.toString(), r.isFailure)
        assertEquals(1, seen.count { it.path!!.startsWith("/vod/search") })
        assertTrue("took ${ms}ms", ms < OneTouchTvResolver.STEP_TIMEOUT_MS + 2_000)
    }

    // ---- a + d: Castle video errors are counted, never a clean empty ------------------

    private val sec = Base64.getEncoder().encodeToString("k3yBytesForTest".toByteArray())

    private fun encrypt(plain: String): String {
        val key = (Base64.getDecoder().decode(sec) + CastleResolver.KEY_SUFFIX.toByteArray()).copyOf(16)
        val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(key))
        return Base64.getEncoder().encodeToString(c.doFinal(plain.toByteArray()))
    }

    private fun wrapped(plain: String) = MockResponse().setBody("""{"data":"${encrypt(plain)}"}""")

    /** Castle with a Telugu and a Hindi track; [ok] says which languageIds answer getVideo2. */
    private fun castleApi(ok: Set<String>) = serve { r ->
        val p = r.path!!
        when {
            p.startsWith("/v0.1/system/getSecurityKey") -> MockResponse().setBody("""{"code":200,"data":"$sec"}""")
            p.startsWith("/film-api/v1.1.0/movie/searchByKeyword") -> wrapped("""{"code":200,"data":{"rows":[{"id":"m1","title":"Mirai"}]}}""")
            p.startsWith("/film-api/v1.9.9/movie") -> wrapped("""{"code":200,"data":{"episodes":[{"id":"e1","number":1,"tracks":[
                {"languageId":"1","languageName":"Telugu","isDefault":true},{"languageId":"2","languageName":"Hindi"}]}]}}""")
            p.startsWith("/film-api/v2.0.1/movie/getVideo2") -> {
                val lang = Regex("\"languageId\":\"(\\d+)\"").find(r.body.readUtf8())?.groupValues?.get(1)
                if (lang != null && lang in ok) wrapped("""{"code":200,"data":{"videos":[{"url":"https://cdn.test/$lang/index.m3u8","resolution":1080,"resolutionDescription":"1080P"}]}}""")
                else MockResponse().setResponseCode(500)
            }
            else -> MockResponse().setResponseCode(404)
        }
    }

    @Test fun castleEveryVideoCallFailedThrowsAndCounts() = runBlocking {
        castleApi(ok = emptySet())
        val e = runCatching { CastleResolver(OkHttpClient(), base).resolve("movie", "Mirai", null, 0, 0, "Telugu") }.exceptionOrNull()
        assertTrue(e.toString(), e is StepException && e.message!!.contains("every video call failed"))
        val od = od(castle = CastleResolver(OkHttpClient(), base))
        val (_, note) = providerCheck(OnDeviceResolver.CASTLE) { od.resolveAll(OnDeviceResolver.CASTLE, "movie", 1, 0, 0, codecs) }
        assertTrue(note, note.startsWith("CastleTV failed: "))
    }

    @Test fun castleSomeVideoCallsFailedIsIncomplete() = runBlocking {
        castleApi(ok = setOf("1"))
        val r = CastleResolver(OkHttpClient(), base).resolve("movie", "Mirai", null, 0, 0, "Telugu")
        assertNotNull(r)
        assertEquals("https://cdn.test/1/index.m3u8", r!!.url)
        assertTrue("a failed Hindi track makes the answer partial", r.incomplete)
        castleApi(ok = setOf("1", "2"))
        assertFalse(CastleResolver(OkHttpClient(), base).resolve("movie", "Mirai", null, 0, 0, "Telugu")!!.incomplete)
    }
}
