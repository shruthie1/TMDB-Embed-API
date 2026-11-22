package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.resolve.CastleConfig
import com.chitram.app.resolve.CastleResolver
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MultiMoviesConfig
import com.chitram.app.resolve.MultiMoviesResolver
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Provider self-heal Task 11: Castle and MultiMovies pick their host through HostBook. */
class HostHealApkTest {
    private val a = MockWebServer()
    private val b = MockWebServer()
    private val baseA = a.url("").toString().trimEnd('/')
    private val baseB = b.url("").toString().trimEnd('/')
    /** A host that refuses connections. */
    private val dead = MockWebServer().let { s -> s.start(); val u = s.url("").toString().trimEnd('/'); s.shutdown(); u }
    private val kv = MemoryKeyValue()
    private val hosts = HostBook(kv)

    @Before fun fresh() = MultiMoviesResolver.resetServerState()
    @After fun stop() { a.shutdown(); b.shutdown() }

    // ---- Castle ------------------------------------------------------------------

    private val sec = Base64.getEncoder().encodeToString("k3yBytesForTest".toByteArray())

    private fun encrypt(plain: String, suffix: String): String {
        val key = (Base64.getDecoder().decode(sec) + suffix.toByteArray()).copyOf(16)
        val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(key))
        return Base64.getEncoder().encodeToString(c.doFinal(plain.toByteArray()))
    }

    /** A Castle API that hands out a key and finds nothing: resolve returns null after search. */
    private fun castleApi(server: MockWebServer, paths: MutableList<String>, suffix: String = CastleResolver.KEY_SUFFIX) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val p = request.path!!
                paths += p
                return when {
                    p.startsWith("/v0.1/system/getSecurityKey") -> MockResponse().setBody("""{"code":200,"data":"$sec"}""")
                    p.startsWith("/film-api/v1.1.0/movie/searchByKeyword") -> MockResponse().setBody("""{"data":"${encrypt("""{"code":200,"data":{"rows":[]}}""", suffix)}"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @Test fun castleFirstBaseDeadSecondUsedAndRemembered() = runBlocking {
        val seenB = CopyOnWriteArrayList<String>()
        castleApi(b, seenB)
        val c = CastleResolver(OkHttpClient(), hosts = hosts, config = { CastleConfig(bases = listOf(dead, baseB)) })
        assertNull(c.resolve("movie", "Mirai", 2025, 0, 0, "Telugu"))
        assertTrue(seenB.toString(), seenB.any { it.startsWith("/film-api/v1.1.0/movie/searchByKeyword") })
        assertEquals(baseB, hosts.healed(CastleResolver.NAME))
        // The next resolve starts on the remembered host.
        assertEquals(listOf(baseB, dead), hosts.candidates(CastleResolver.NAME, listOf(dead, baseB)))
    }

    @Test fun castleRedirectToAnotherOriginIsFollowed() = runBlocking {
        val seenB = CopyOnWriteArrayList<String>()
        castleApi(b, seenB)
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse().setResponseCode(301).setHeader("Location", "$baseB${request.path}")
        }
        val c = CastleResolver(OkHttpClient(), hosts = hosts, config = { CastleConfig(bases = listOf(baseA)) })
        assertNull(c.resolve("movie", "Mirai", 2025, 0, 0, "Telugu"))
        assertEquals(baseB, hosts.healed(CastleResolver.NAME))
        // Search went to the new host directly, not through a redirect on the old one.
        assertTrue(seenB.any { it.startsWith("/film-api/") })
        assertEquals(1, a.requestCount)
    }

    @Test fun castleKeySuffixFromConfig() = runBlocking {
        val seen = CopyOnWriteArrayList<String>()
        castleApi(a, seen, suffix = "NEWSUF")
        // With the built-in suffix the search answer does not decrypt: the chain throws.
        val old = runCatching { CastleResolver(OkHttpClient(), baseA).resolve("movie", "Mirai", 2025, 0, 0, "Telugu") }
        assertTrue(old.isFailure)
        val c = CastleResolver(OkHttpClient(), hosts = hosts, config = { CastleConfig(bases = listOf(baseA), keySuffix = "NEWSUF") })
        assertNull(c.resolve("movie", "Mirai", 2025, 0, 0, "Telugu"))
    }

    /** Records each URL and answers 500, so no request leaves the test. */
    private fun recorder(urls: MutableList<String>) = OkHttpClient.Builder().addInterceptor { chain ->
        urls += chain.request().url.toString()
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(500).message("x").body("".toResponseBody()).build()
    }.build()

    @Test fun defaultConfigKeepsTodaysUrls() = runBlocking {
        val urls = CopyOnWriteArrayList<String>()
        runCatching { CastleResolver(recorder(urls)).resolve("movie", "Mirai", 2025, 0, 0, "Telugu") }
        assertEquals("https://api.hlowb.com/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US", urls.first())
        urls.clear()
        runCatching { MultiMoviesResolver(recorder(urls)).resolveAll("movie", 579974, 0, 0) }
        assertTrue(urls.toString(), "https://vidbolt.xyz/api/resolve?type=movie&id=579974" in urls)
        assertTrue(urls.toString(), urls.all { it.startsWith("https://vidbolt.xyz/") })
        // App wiring: the parsed default config starts on the same hosts.
        val d = com.chitram.app.resolve.ResolveConfig()
        assertEquals(CastleResolver.BASE, d.castletv.bases.first())
        assertEquals(MultiMoviesResolver.ORIGIN, d.multimovies.bases.first())
    }

    // ---- MultiMovies -------------------------------------------------------------

    private val audioMaster = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Telugu\",LANGUAGE=\"te\",DEFAULT=YES,URI=\"a.m3u8\"\n" +
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,AUDIO=\"a\"\nv720.m3u8\n"

    private fun vidbolt(server: MockWebServer, base: String, seen: MutableList<RecordedRequest>, resolvePath: String = "/api/resolve") {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val p = request.path!!
                return when {
                    p.startsWith(resolvePath) -> MockResponse().setBody("""{"stream":{"server":"x","sources":[{"url":"$base/m/master.m3u8","kind":"hls","language":"Telugu"}]}}""")
                    p == "/m/master.m3u8" -> MockResponse().setBody(audioMaster)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @Test fun multiMoviesVmHealedHostUsedWhenDefaultDead() = runBlocking {
        val seenB = CopyOnWriteArrayList<RecordedRequest>()
        vidbolt(b, baseB, seenB)
        val urls = CopyOnWriteArrayList<String>()
        val client = OkHttpClient.Builder().addInterceptor { chain -> urls += chain.request().url.toString(); chain.proceed(chain.request()) }.build()
        // VM merged view: healed host first, the old default second (here: dead).
        val m = MultiMoviesResolver(client, hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseB, dead)) })
        val rows = m.resolveAll("movie", 579974, 0, 0)
        assertEquals(1, rows.size)
        assertEquals("$baseB/", rows[0].headers["Referer"])
        assertEquals(baseB, rows[0].headers["Origin"])
        // Only VidBolt hosts were asked: no multimovies site, no scraper URL.
        assertTrue(urls.toString(), urls.all { it.startsWith(baseB) || it.startsWith(dead) })
        assertTrue(urls.none { "multimovies" in it || "githubusercontent" in it })
    }

    @Test fun multiMoviesFirstHostDeadSecondUsedAndRemembered() = runBlocking {
        val seenB = CopyOnWriteArrayList<RecordedRequest>()
        vidbolt(b, baseB, seenB, resolvePath = "/api/v2/resolve")
        val m = MultiMoviesResolver(OkHttpClient(), hosts = hosts, config = { MultiMoviesConfig(bases = listOf(dead, baseB), resolvePath = "/api/v2/resolve") })
        val rows = m.resolveAll("movie", 579974, 0, 0)
        assertEquals(listOf("Telugu"), rows.single().audio.mapNotNull { it.label })
        assertEquals("$baseB/", rows[0].headers["Referer"])
        assertTrue(seenB.any { it.path!!.startsWith("/api/v2/resolve?type=movie&id=579974") })
        assertEquals(baseB, hosts.healed(MultiMoviesResolver.NAME))
    }

    @Test fun multiMoviesHostAnsweringNonJsonIsDeadNotRemembered() = runBlocking {
        // A parked or hijacked domain: 200 HTML on every ask.
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("<html>parked</html>")
        }
        val seenB = CopyOnWriteArrayList<RecordedRequest>()
        vidbolt(b, baseB, seenB)
        val m = MultiMoviesResolver(OkHttpClient(), hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        assertEquals(1, m.resolveAll("movie", 579974, 0, 0).size)
        assertEquals(baseB, hosts.healed(MultiMoviesResolver.NAME))
        assertTrue(hosts.candidates(MultiMoviesResolver.NAME, listOf(baseA, baseB)).first() != baseA)
    }

    @Test fun multiMoviesTitleMissingOnALiveHostDoesNotAskTheNextHost() = runBlocking {
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("""{"stream":null}""")
        }
        val m = MultiMoviesResolver(OkHttpClient(), hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        assertTrue(m.resolveAll("movie", 1, 0, 0).isEmpty())
        assertEquals(0, b.requestCount)
        assertNull(hosts.healed(MultiMoviesResolver.NAME))
    }

    @Test fun multiMovies429KeepsTheHostAndThrows() = runBlocking {
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(429)
        }
        val m = MultiMoviesResolver(OkHttpClient(), hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        val err = runCatching { m.resolveAll("movie", 1, 0, 0) }.exceptionOrNull()
        assertTrue(err is com.chitram.app.resolve.StepException && err.code == 429)
        assertEquals(0, b.requestCount)
    }
    // ---- review fixes (review-apk-10-12.md) ---------------------------------

    /** I2: a config host list that drops the built-in host still ends with the built-in host. */
    @Test fun castleConfigWithoutBuiltInHostFallsBackToBuiltIn() = runBlocking {
        val seenB = CopyOnWriteArrayList<String>()
        castleApi(b, seenB)
        // [base] stands for the built-in api.hlowb.com (a test must not reach the real one).
        val c = CastleResolver(OkHttpClient(), baseB, hosts = hosts, config = { CastleConfig(bases = listOf(dead)) })
        assertNull(c.resolve("movie", "Mirai", 2025, 0, 0, "Telugu"))
        assertTrue(seenB.toString(), seenB.any { it.startsWith("/film-api/v1.1.0/movie/searchByKeyword") })
    }

    /**
     * I2: a typo in the config keySuffix: the decrypt is retried once with the built-in suffix.
     * The test key is 15 bytes, so only the suffix's first character reaches the AES key.
     */
    @Test fun castleBadConfigSuffixRetriesBuiltInSuffix() = runBlocking {
        val seen = CopyOnWriteArrayList<String>()
        castleApi(a, seen, suffix = CastleResolver.KEY_SUFFIX)
        val c = CastleResolver(OkHttpClient(), baseA, hosts = hosts, config = { CastleConfig(bases = listOf(baseA), keySuffix = "X!BgJB") })
        assertNull(c.resolve("movie", "Mirai", 2025, 0, 0, "Telugu"))
        assertTrue(seen.toString(), seen.any { it.startsWith("/film-api/v1.1.0/movie/searchByKeyword") })
    }

    @Test fun multiMoviesConfigWithoutBuiltInHostFallsBackToBuiltIn() = runBlocking {
        val seenB = CopyOnWriteArrayList<RecordedRequest>()
        vidbolt(b, baseB, seenB)
        val m = MultiMoviesResolver(OkHttpClient(), baseB, hosts = hosts, config = { MultiMoviesConfig(bases = listOf(dead)) })
        assertEquals(1, m.resolveAll("movie", 579974, 0, 0).size)
    }

    @Test fun hostBookAppendsBuiltInLastDeduped() {
        assertEquals(listOf("https://x", "https://y", "https://b"), hosts.candidates("n", listOf("https://x", "https://y/"), listOf("https://b", "https://y")))
    }

    /** I3: a 403 (Cloudflare on this IP) fails the call and keeps the host, like 429. */
    @Test fun multiMovies403KeepsTheHostAndThrows() = runBlocking {
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(403).setBody("<html>cf</html>")
        }
        val m = MultiMoviesResolver(OkHttpClient(), baseA, hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        val err = runCatching { m.resolveAll("movie", 1, 0, 0) }.exceptionOrNull()
        assertTrue("$err", err is com.chitram.app.resolve.StepException && err.code == 403)
        assertEquals(0, b.requestCount)
        assertNull(hosts.healed(MultiMoviesResolver.NAME))
    }

    /** I3: a timeout at the step cap fails the call and keeps the host. */
    @Test fun multiMoviesTimeoutKeepsTheHostAndThrows() = runBlocking {
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse().setBody("{}").setHeadersDelay(MultiMoviesResolver.RESOLVE_STEP_MS + 2000, java.util.concurrent.TimeUnit.MILLISECONDS)
        }
        val m = MultiMoviesResolver(OkHttpClient(), baseA, hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        assertTrue(runCatching { m.resolveAll("movie", 1, 0, 0) }.isFailure)
        assertEquals(0, b.requestCount)
        assertNull(hosts.healed(MultiMoviesResolver.NAME))
    }

    /** I3: a 5xx on the host still moves to the next host. */
    @Test fun multiMovies5xxMovesTheHost() = runBlocking {
        a.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(503)
        }
        val seenB = CopyOnWriteArrayList<RecordedRequest>()
        vidbolt(b, baseB, seenB)
        val m = MultiMoviesResolver(OkHttpClient(), baseA, hosts = hosts, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        assertEquals(1, m.resolveAll("movie", 579974, 0, 0).size)
        assertEquals(baseB, hosts.healed(MultiMoviesResolver.NAME))
    }

    /** I3: a 2xx with no sources (or a 429) on the pinned host does not refresh the 7-day pin. */
    @Test fun multiMoviesEmptyAnswerDoesNotRefreshThePin() = runBlocking {
        var clock = 0L
        val book = HostBook(kv) { clock }
        book.remember(MultiMoviesResolver.NAME, baseB, listOf(baseA, baseB))
        b.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setBody("""{"stream":null}""")
        }
        clock = HostBook.TTL_MS - 60_000
        val m = MultiMoviesResolver(OkHttpClient(), baseA, hosts = book, config = { MultiMoviesConfig(bases = listOf(baseA, baseB)) })
        assertTrue(m.resolveAll("movie", 1, 0, 0).isEmpty())
        assertEquals(0, a.requestCount)
        clock = HostBook.TTL_MS + 1
        assertNull(book.healed(MultiMoviesResolver.NAME))
    }
}
