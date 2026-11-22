package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.HedgedDns
import com.chitram.app.data.LastProviderStore
import com.chitram.app.data.NetworkWatch
import com.chitram.app.data.Source
import com.chitram.app.player.LastPlayed
import com.chitram.app.player.StartRace
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Dns
import okhttp3.Request
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicInteger

/**
 * 1.2.52: the last-played provider never delays the start (Major movie/605153),
 * and the details-page JSON calls survive a dead pooled connection (Dhurandhar
 * movie/1291608: /api/title .. /full SocketTimeoutException after 30003 ms, dns -1 connect -1).
 */
class V152Test {
    private fun row(id: String, provider: String, lang: String, device: Boolean = true) =
        Source(id, provider, provider, "https://x/$id.m3u8", false, "1080p", emptyList(), listOf(lang), false, false, emptyList(), null, null, false,
            onDevice = if (device) provider else null)

    // ---- last provider ----------------------------------------------------------------

    /** The remembered provider is still resolving; a Telugu row is ready: start under ~300 ms. */
    @Test fun aRememberedProviderThatIsNotReadyDoesNotDelayTheStart() = runBlocking {
        val vm = CompletableDeferred(listOf(row("vm-te", "castletv", "Telugu", device = false)))
        val ready = CompletableDeferred(listOf(row("mapple-te", "mapple", "Telugu")))
        val remembered = async { delay(20_000); listOf(row("nm-te", "netmirror", "Telugu")) }
        val t0 = System.currentTimeMillis()
        val first = StartRace().firstMany(vm, listOf(ready, remembered), "Telugu", pinned = listOf(remembered))
        val ms = System.currentTimeMillis() - t0
        assertTrue("started in ${ms}ms", ms < 450)
        assertFalse(first.device.any { it.provider == "netmirror" })
        val list = first.backend + first.device
        assertEquals(null, LastPlayed.startRow(list, LastProviderStore.Pin("netmirror", false), "Telugu"))
        remembered.cancel()
    }

    /**
     * The remembered provider's kept row lands a moment after Play (its job had not
     * run yet when the VM's kept answer came back): it still leads the start.
     */
    @Test fun aRememberedProviderThatIsReadyStartsFirst() = runBlocking {
        val vm = CompletableDeferred(listOf(row("vm-te", "castletv", "Telugu", device = false)))
        val remembered = async { delay(40); listOf(row("nm-te", "netmirror", "Telugu")) }
        val first = StartRace().firstMany(vm, listOf(remembered), "Telugu", pinned = listOf(remembered))
        val list = first.backend + first.device
        assertEquals("nm-te", LastPlayed.startRow(list, LastProviderStore.Pin("netmirror", false), "Telugu")?.id)
    }

    @Test fun playerVmPassesTheRememberedJobAndLogsNotReady() {
        val src = listOf(File("src/main/java/com/chitram/app/player/PlayerVm.kt"), File("app/src/main/java/com/chitram/app/player/PlayerVm.kt")).first { it.exists() }.readText()
        assertTrue(src.contains("pinned = pinnedJobs"))
        assertTrue(src.contains("LastPlayed.notReady(r.type, r.id, saved.provider, startRow.provider)"))
        assertTrue(LastPlayed.notReady("movie", 605153, "netmirror", "mapple") == "[last] movie/605153 provider=netmirror not ready, started mapple")
    }

    // ---- http: dead pooled connections ----------------------------------------------------

    @Test fun sharedClientPingsHttp2ConnectionsEvery10s() {
        assertEquals(10_000, Api.buildClient().pingIntervalMillis)
        // Derived clients share the setting and the pool.
        val c = Api.buildClient()
        val d = c.newBuilder().build()
        assertEquals(10_000, d.pingIntervalMillis)
        assertTrue(c.connectionPool === d.connectionPool)
    }

    /** No response headers from /api/title in the hedge window: a second call on a fresh connection answers. */
    @Test fun aHungTitleCallIsHedgedOnAFreshConnection() = runBlocking {
        val server = MockWebServer()
        val n = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (n.incrementAndGet() == 1) MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                else MockResponse().setBody("""{"titles":[]}""")
        }
        server.start()
        try {
            val api = Api(Api.buildClient(), base = server.url("").toString().trimEnd('/'), catalogHedgeMs = 300)
            val t0 = System.currentTimeMillis()
            val rows = withTimeout(5_000) { api.similar("movie", 1291608) }
            assertTrue(rows.isEmpty())
            assertTrue("answered by the hedge in ${System.currentTimeMillis() - t0}ms", System.currentTimeMillis() - t0 < 3_000)
            assertEquals(2, n.get())
        } finally { server.shutdown() }
    }

    @Test fun catalogJsonCallsHaveA10sCallTimeout() {
        val api = Api(Api.buildClient())
        assertEquals(10_000, api.catalogJsonClient.callTimeoutMillis)
        assertEquals(2_500L, Api.CATALOG_HEDGE_MS)
        val src = listOf(File("src/main/java/com/chitram/app/data/Api.kt"), File("app/src/main/java/com/chitram/app/data/Api.kt")).first { it.exists() }.readText()
        assertTrue(src.contains("\"[http] hedged \${req.url.encodedPath} after \${hedgeMs}ms\""))
    }

    /** A default-network change evicts the pool: the next call opens a new connection. */
    @Test fun aNetworkChangeEvictsThePool() {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = MockResponse().setBody("ok") }
        server.start()
        try {
            val api = Api(Api.buildClient())
            api.client.newCall(Request.Builder().url(server.url("/a")).build()).execute().use { it.body!!.string() }
            assertEquals(1, api.client.connectionPool.idleConnectionCount())
            val watch = NetworkWatch { why -> api.networkChanged(why) }
            watch.available("wifi")
            assertEquals("first network: no change", 1, api.client.connectionPool.idleConnectionCount())
            watch.available("lte")
            assertEquals(0, api.client.connectionPool.idleConnectionCount())
        } finally { server.shutdown() }
    }

    @Test fun networkWatchReportsOnlyRealChanges() {
        val seen = mutableListOf<String>()
        val w = NetworkWatch { seen += it }
        w.available("1"); w.available("1")
        assertTrue(seen.isEmpty())
        w.available("2")
        w.lost("1") // not the default any more: nothing
        w.lost("2")
        w.available("3") // after a loss the pool is already evicted: no second eviction
        assertEquals(listOf("default 1 -> 2", "default 2 lost"), seen)
    }

    // ---- dns: a slow lookup is asked again on the other network -------------------------------

    @Test fun aSlowDnsLookupIsAnsweredByTheOtherNetwork() {
        val addr = InetAddress.getByAddress("chtrm2.vercel.app", byteArrayOf(76, 76, 21, 21))
        val slow = object : Dns { override fun lookup(hostname: String): List<InetAddress> { Thread.sleep(5_000); throw UnknownHostException(hostname) } }
        val other = object : Dns { override fun lookup(hostname: String) = listOf(addr) }
        val dns = HedgedDns(slow, { listOf(other) }, slowMs = 200)
        val t0 = System.currentTimeMillis()
        assertEquals(listOf(addr), dns.lookup("chtrm2.vercel.app"))
        assertTrue(System.currentTimeMillis() - t0 < 1_500)
    }

    @Test fun aFastDnsLookupNeverAsksTheOtherNetwork() {
        val addr = InetAddress.getByAddress("chtrm2.vercel.app", byteArrayOf(76, 76, 21, 21))
        val asked = AtomicInteger()
        val dns = HedgedDns(object : Dns { override fun lookup(hostname: String) = listOf(addr) }, { asked.incrementAndGet(); emptyList() }, slowMs = 200)
        assertEquals(listOf(addr), dns.lookup("chtrm2.vercel.app"))
        assertEquals(0, asked.get())
    }
}
