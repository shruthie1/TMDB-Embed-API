package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.HttpException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Catalog calls are cached for 1 h on disk; streams and errors never are.
 * A local server sends the same headers as the live backend (max-age=0 / no-store).
 */
class HttpCacheTest {
    private val server = MockWebServer()
    private val hits = ConcurrentHashMap<String, AtomicInteger>()
    private lateinit var api: Api

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                hits.getOrPut(path) { AtomicInteger() }.incrementAndGet()
                val (code, cc, body) = when {
                    path.startsWith("/api/streams") -> Triple(200, "public, max-age=600", """{"success":true,"count":0}""")
                    path.startsWith("/api/rows/broken") -> Triple(500, "public, max-age=600", "{}")
                    else -> Triple(200, "public, max-age=0, must-revalidate", """{"titles":[],"episodes":[]}""")
                }
                return MockResponse().setResponseCode(code).setHeader("Cache-Control", cc)
                    .setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
        val dir = Files.createTempDirectory("chitram-http").toFile()
        api = Api(Api.buildClient(), server.url("").toString().trimEnd('/'), Api.httpCache(dir))
    }

    @After fun stop() { server.shutdown() }

    private fun hits(p: String) = hits[p]?.get() ?: 0

    @Test fun clientsSplit() {
        assertNull("player/Coil client must not cache", api.client.cache)
        assertNotNull(api.catalogClient.cache)
        assertEquals(Api.HTTP_CACHE_BYTES, api.catalogClient.cache!!.maxSize())
    }

    @Test fun pathClassification() {
        for (p in listOf("/api/rows/top10", "/api/search?q=a", "/api/title/movie/1/full", "/api/similar/movie/1",
            "/api/person/1", "/api/discover?page=1", "/api/season/1/1")) assertTrue(p, Api.isCatalogPath(p))
        for (p in listOf("/api/streams/movie/1", "/api/streams/series/1?season=1&episode=1", "/api/resolve", "/api/other"))
            assertFalse(p, Api.isCatalogPath(p))
    }

    @Test fun streamRequestCarriesNoStore() {
        val cc = api.request("/api/streams/movie/1").cacheControl
        assertTrue(cc.noStore)
        assertTrue(cc.noCache)
        assertFalse(api.request("/api/rows/top10").cacheControl.noStore)
    }

    @Test fun catalogServedFromCacheOnRevisit() = runBlocking {
        api.row("top10")
        api.row("top10")
        api.season(1399, 1)
        api.season(1399, 1)
        assertEquals(1, hits("/api/rows/top10"))
        assertEquals(1, hits("/api/season/1399/1"))
    }

    @Test fun streamsNeverCached() = runBlocking {
        api.streams("movie", 7)
        api.streams("movie", 7)
        assertEquals(2, hits("/api/streams/movie/7"))
    }

    @Test fun errorsNeverCached() = runBlocking {
        repeat(2) { try { api.row("broken") } catch (_: HttpException) {} }
        assertEquals(2, hits("/api/rows/broken"))
    }
}
