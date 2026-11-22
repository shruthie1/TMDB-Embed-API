package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.MultiMoviesResolver
import com.chitram.app.resolve.ResolveConfig
import com.chitram.app.resolve.ResolveConfigStore
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Provider self-heal Task 10: castletv / multimovies / routes sections, and the
 * remote static copy as the fallback when the VM config fetch fails.
 */
class ResolveConfigTest {
    private val server = MockWebServer()
    private val base = server.url("").toString().trimEnd('/')
    private val seen = CopyOnWriteArrayList<String>()
    private var vmCode = 200
    private var vmBody = """{"version":1,"ttlSec":3600,"castletv":{"bases":["https://vm.castle"]}}"""
    private var remoteCode = 200
    private var remoteBody = """{"version":2,"ttlSec":3600,"castletv":{"bases":["https://remote.castle"]}}"""

    private var vmDelayMs = 0L
    private var remoteDelayMs = 0L

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val p = request.path!!
                seen += p
                return when (p) {
                    "/api/resolve-config" -> MockResponse().setResponseCode(vmCode).setBody(vmBody).setHeadersDelay(vmDelayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                    "/resolve-config.json" -> MockResponse().setResponseCode(remoteCode).setBody(remoteBody).setHeadersDelay(remoteDelayMs, java.util.concurrent.TimeUnit.MILLISECONDS)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @After fun stop() = server.shutdown()

    private var clock = 1_000_000L
    private fun store(kv: MemoryKeyValue, vmUp: Boolean = true) = ResolveConfigStore(
        OkHttpClient(), "$base/api/resolve-config", kv, now = { clock },
        remoteUrl = "$base/resolve-config.json", vmUp = { vmUp },
    )

    @Test fun vmFailsRemoteUsedAndCached() = runBlocking {
        vmCode = 500
        val kv = MemoryKeyValue()
        val cfg = store(kv).refresh()
        assertEquals(listOf("https://remote.castle"), cfg.castletv.bases)
        assertEquals(listOf("/api/resolve-config", "/resolve-config.json"), seen.toList())
        // A new store (app restart) with nothing reachable reads the cached remote copy.
        vmCode = 500; remoteCode = 500
        assertEquals(listOf("https://remote.castle"), store(kv).refresh().castletv.bases)
    }

    @Test fun vmAnswersRemoteNotAsked() = runBlocking {
        val cfg = store(MemoryKeyValue()).refresh()
        assertEquals(listOf("https://vm.castle"), cfg.castletv.bases)
        assertEquals(listOf("/api/resolve-config"), seen.toList())
    }

    @Test fun bothFailKeepsLastCachedCopy() = runBlocking {
        val kv = MemoryKeyValue()
        val s = store(kv)
        assertEquals(listOf("https://vm.castle"), s.refresh().castletv.bases)
        vmCode = 503; remoteCode = 404
        assertEquals(listOf("https://vm.castle"), s.refresh().castletv.bases)
    }

    @Test fun nothingEverFetchedGivesDefaults() = runBlocking {
        vmCode = 500; remoteCode = 500
        assertEquals(ResolveConfig(), store(MemoryKeyValue()).refresh())
    }

    @Test fun vmPausedSkipsTheVmUrl() = runBlocking {
        val cfg = store(MemoryKeyValue(), vmUp = false).refresh()
        assertEquals(listOf("https://remote.castle"), cfg.castletv.bases)
        assertEquals(listOf("/resolve-config.json"), seen.toList())
    }

    @Test fun badJsonFromVmFallsToRemote() = runBlocking {
        vmBody = "<html>vercel error</html>"
        assertEquals(listOf("https://remote.castle"), store(MemoryKeyValue()).refresh().castletv.bases)
    }

    @Test fun oldDocGetsNewSectionDefaults() {
        val cfg = ResolveConfig.parse("""{"version":1,"mapple":{"bases":["https://mapple.fun"]},"vaplayer":{},"netmirror":{}}""")
        assertEquals(CastleResolver.BASE, cfg.castletv.bases.first())
        assertEquals("T!BgJB", cfg.castletv.keySuffix)
        assertEquals(MultiMoviesResolver.ORIGIN, cfg.multimovies.bases.first())
        assertEquals("/api/resolve", cfg.multimovies.resolvePath)
        assertTrue(cfg.routes.isEmpty())
    }

    @Test fun vmHealFirstKeepsOrder() {
        val cfg = ResolveConfig.parse("""{"multimovies":{"bases":["https://vidbolt.new","https://vidbolt.xyz/"],"resolvePath":"/api/v2/resolve"}}""")
        assertEquals(listOf("https://vidbolt.new", "https://vidbolt.xyz"), cfg.multimovies.bases)
        assertEquals("/api/v2/resolve", cfg.multimovies.resolvePath)
    }

    @Test fun badValuesKeepBuiltIn() {
        val cfg = ResolveConfig.parse("""{"castletv":{"bases":["http://plain","",5],"keySuffix":7,"extra":true},
            "multimovies":{"bases":"https://x","resolvePath":"api/resolve"},
            "routes":{"castletv":{"web":"direct","apk":"device"},"vaplayer":{"apk":"on-device"},"mapple":{"apk":"none"},
                      "vidrock":{"apk":"fast"},"showsst":"proxy","multimovies":{"apk":"direct"}},
            "unknownProvider":{"bases":["https://y"]}}""")
        assertEquals(listOf(CastleResolver.BASE), cfg.castletv.bases)
        assertEquals("T!BgJB", cfg.castletv.keySuffix)
        assertEquals(MultiMoviesResolver.ORIGIN, cfg.multimovies.bases.first())
        assertEquals("/api/resolve", cfg.multimovies.resolvePath)
        assertEquals(mapOf("castletv" to "device", "vaplayer" to "device", "mapple" to "off", "multimovies" to "direct"), cfg.routes)
    }

    @Test fun serverBuiltInFileParses() {
        val f = listOf("../../routes/resolve-config.json", "../routes/resolve-config.json", "routes/resolve-config.json")
            .map { java.io.File(it) }.firstOrNull { it.exists() } ?: return
        val cfg = ResolveConfig.parse(f.readText())
        assertEquals(CastleResolver.BASE, cfg.castletv.bases.first())
        assertEquals(MultiMoviesResolver.ORIGIN, cfg.multimovies.bases.first())
    }
    // ---- review fixes (review-apk-10-12.md) ---------------------------------

    /** I1: a VM blip at refresh time keeps the cached VM copy (VM heals); the remote copy does not replace it. */
    @Test fun vmCopyKeptWhenVmFailsAndRemoteAnswers() = runBlocking {
        val kv = MemoryKeyValue()
        val s = store(kv)
        assertEquals(listOf("https://vm.castle"), s.refresh().castletv.bases)
        clock += 3601_000 // the VM copy's ttlSec (3600) is spent
        vmCode = 500
        seen.clear()
        assertEquals(listOf("https://vm.castle"), s.get().castletv.bases)
        assertTrue(seen.toString(), "/resolve-config.json" !in seen)
        // An app restart still reads the VM copy.
        assertEquals(listOf("https://vm.castle"), store(kv).current().castletv.bases)
    }

    /** I1: the remote copy only fills a gap; the VM is asked again after RETRY_MS, not after ttlSec. */
    @Test fun remoteCopyRetriesVmAfterRetryWindow() = runBlocking {
        vmCode = 500
        val kv = MemoryKeyValue()
        val s = store(kv)
        assertEquals(listOf("https://remote.castle"), s.refresh().castletv.bases)
        vmCode = 200
        clock += ResolveConfigStore.RETRY_MS + 1 // well inside ttlSec 3600
        assertEquals(listOf("https://vm.castle"), s.get().castletv.bases)
        // The source survives a restart: a remote copy in KeyValue is short-lived there too.
        vmCode = 500
        val kv2 = MemoryKeyValue()
        assertEquals(listOf("https://remote.castle"), store(kv2).refresh().castletv.bases)
        vmCode = 200
        clock += ResolveConfigStore.RETRY_MS + 1
        assertEquals(listOf("https://vm.castle"), store(kv2).get().castletv.bases)
    }

    /** M8: a 200 JSON object with no known provider section is a failed fetch, never cached. */
    @Test fun jsonWithoutConfigShapeIsAFailure() = runBlocking {
        vmBody = """{"error":"x"}"""
        remoteBody = """{"ok":false}"""
        val kv = MemoryKeyValue()
        assertEquals(ResolveConfig(), store(kv).refresh())
        assertEquals(null, kv.get(ResolveConfigStore.KEY))
        // With a good copy cached, the error object does not replace it.
        vmBody = """{"version":1,"ttlSec":3600,"castletv":{"bases":["https://vm.castle"]}}"""
        val s = store(kv)
        assertEquals(listOf("https://vm.castle"), s.refresh().castletv.bases)
        vmBody = """{"error":"x"}"""
        assertEquals(listOf("https://vm.castle"), s.refresh().castletv.bases)
        assertTrue(kv.get(ResolveConfigStore.KEY)!!.contains("vm.castle"))
    }

    /** M7: an expired copy and a hanging VM + remote: get() returns the stale copy within 4 s, not 8 s. */
    @Test fun expiredCopyServedWithinFourSeconds() = runBlocking {
        vmCode = 500
        val kv = MemoryKeyValue()
        val s = store(kv)
        assertEquals(listOf("https://remote.castle"), s.refresh().castletv.bases)
        vmCode = 200; vmDelayMs = 6000; remoteDelayMs = 6000
        clock += 3601_000
        val t0 = System.currentTimeMillis()
        val got = s.get()
        val took = System.currentTimeMillis() - t0
        assertEquals(listOf("https://remote.castle"), got.castletv.bases)
        assertTrue("took ${took}ms", took < 4600)
    }
}
