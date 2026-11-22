package com.chitram.app

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.player.StartRace
import com.chitram.app.resolve.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class NetmirrorTest {
    private val server = MockWebServer()
    private val seen = CopyOnWriteArrayList<RecordedRequest>()
    private val client = OkHttpClient()
    private val codecs = CodecSupport { _, _ -> null }
    private lateinit var base: String
    private var clock = 2_000_000_000_000L
    private var logins = 0
    private var reject = 0
    private var bare = false
    private var clip = false
    private var loginError = false
    private var failFirstDub = false
    private var series = false
    private var expiring = false
    private var nonSequential = false
    private var paged = false
    private var repeatCursor = false
    private var extraCatalog = false
    private var held = false
    private var slowHotstar = false
    private var apiPrefix = ""
    private val cfg get() = NetmirrorConfig(domains = listOf(base), maxCalls = 50)

    @Before fun setup() {
        server.start(); base = server.url("/").toString().trimEnd('/')
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(r: RecordedRequest): MockResponse {
                seen += r
                val p = r.requestUrl!!.encodedPath
                fun json(s: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(s)
                if (p == "/config") return json("""{"netmirror":{"domains":["https://unit.test"],"budgetMs":3000,"maxCalls":50}}""")
                if (p == "/checknewtv.php" || p == "/other/checknewtv.php") return json("""{"token_hash":"${Base64.getEncoder().encodeToString((base + apiPrefix).toByteArray())}"}""")
                if (p.endsWith("/otp.php")) {
                    logins++
                    assertEquals("111111", r.getHeader("Otp"))
                    return if (loginError) json("""{"status":"error"}""") else json("""{"status":"ok","usertoken":"SECRET-$logins"}""")
                }
                if (p.contains("/newtv/")) {
                    assertEquals("SECRET-$logins", r.getHeader("Usertoken"))
                    if (reject > 0) { reject--; return json("""{"status":"otp","video_link":"$base/bogus.m3u8"}""") }
                }
                val ott = r.getHeader("Ott").orEmpty()
                val id = when (ott) { "pv" -> "222"; "hs" -> "333"; else -> "111" }
                if (p.endsWith("/ott.php")) return json(if (extraCatalog) """{"ott":[{"value":"nf"},{"value":"pv"},{"value":"hs"},{"value":"extra"}]}""" else """{"ott":[{"value":"nf"},{"value":"pv"},{"value":"hs"}]}""")
                if (p.endsWith("/search.php")) {
                    val out = json("""{"searchResult":[{"id":"$id","t":"Test Movie"}${if (failFirstDub && ott == "nf") ",{\"id\":\"112\",\"t\":\"Test Movie (Telugu)\"}" else ""}]}""")
                    return if (held || (slowHotstar && ott == "hs")) out.setBodyDelay(5, TimeUnit.SECONDS) else out
                }
                if (p.endsWith("/post.php")) {
                    val target = r.requestUrl!!.queryParameter("id")!!
                    if (failFirstDub && target == "111") return MockResponse().setResponseCode(500)
                    val seasonRows = if (nonSequential) """[{"id":"s3","s":"Season 3 (8 EP)"},{"id":"s1","s":"Season 1 (8 EP)","selected":true},{"id":"s2","s":"Season 2 (9 EP)"}]""" else """[{"id":"s1","s":"Season 1 (8 EP)","selected":true},{"id":"s2","s":"Season 2 (9 EP)"}]"""
                    return json("""{"type":"${if (series) "t" else "m"}","year":"2024","main_id":"$target","lang":[{"l":"Telugu"}],"season":$seasonRows,"episodes":[]}""")
                }
                if (p.endsWith("/episodes.php")) {
                    val page = r.requestUrl!!.queryParameter("page")
                    if (paged && page == null) return json("""{"episodes":[],"nextPageShow":1,"nextPageSeason":"cursor-s2","nextPage":"3"}""")
                    if (repeatCursor || (paged && page != "3")) return json("""{"episodes":[],"nextPageShow":1,"nextPageSeason":"cursor-s2","nextPage":"3"}""")
                    return json("""{"episodes":[{"id":"444","ep":"E2","sNum":"S2"}],"nextPageShow":0}""")
                }
                if (p.endsWith("/player.php")) {
                    val target = r.requestUrl!!.queryParameter("id")!!
                    return json("""{"status":"ok","video_link":"$base/media/$target.m3u8${if (expiring) "?e=${clock / 1000 + 5}" else ""}","referer":"$base/"}""")
                }
                if (p.startsWith("/media/")) {
                    assertNull("API credential must not reach CDN", r.getHeader("Usertoken"))
                    assertNull(r.getHeader("Otp"))
                    val target = if (clip) "220884" else p.substringAfterLast('/').substringBefore('.')
                    val audio = if (bare) "" else "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",LANGUAGE=\"tel\",NAME=\"[1] Telugu\",URI=\"a/te.m3u8\"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",LANGUAGE=\"hin\",NAME=\"[2] Hindi\",URI=\"a/hi.m3u8\"\n"
                    return MockResponse().setBody("#EXTM3U\n$audio#EXT-X-MEDIA:TYPE=SUBTITLES,NAME=\"English\",LANGUAGE=\"en\",URI=\"subs/en.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n$base/files/$target/720.m3u8\n")
                }
                return MockResponse().setResponseCode(404)
            }
        }
    }
    @After fun teardown() { server.shutdown() }
    private fun resolver() = NetmirrorResolver(client, now = { clock })
    private suspend fun resolve(r: NetmirrorResolver, config: NetmirrorConfig = cfg, fresh: Boolean = false) = r.resolve(config, if (series) "tv" else "movie", "Test Movie", 2024, 2, 2, fresh)

    @Test fun authenticatesOnceCarriesTokenEverywhereAndPreservesCatalogs() = runBlocking {
        val r = resolver()
        val rows = resolve(r)
        assertEquals(3, rows.size)
        assertEquals(1, logins)
        val sources = rows.map { OnDeviceResolver.toSource(it, codecs) }
        assertEquals(3, sources.map { it.id }.toSet().size)
        assertTrue(sources.all { it.languages == listOf("Telugu", "Hindi") && it.selectableAudio })
        assertTrue("HLS subtitles remain embedded, not fed to text side-loader", sources.all { it.subtitles.isEmpty() })
        val before = seen.size
        assertEquals(rows, resolve(r))
        assertEquals(before, seen.size)
        clock += 31_000
        resolve(r)
        assertEquals(1, logins)
        assertEquals(3, seen.count { it.requestUrl!!.encodedPath.endsWith("search.php") })
        assertEquals(6, seen.count { it.requestUrl!!.encodedPath.endsWith("player.php") })
    }
    @Test fun aColdStartReusesTheStoredOtpSessionWithNoOtpCall() = runBlocking {
        val kv = MemoryKeyValue()
        assertEquals(3, resolve(NetmirrorResolver(client, now = { clock }, kv = kv)).size)
        assertEquals(1, logins)
        // New process, same store: 0 otp.php calls, the stored token is sent.
        assertEquals(3, resolve(NetmirrorResolver(client, now = { clock }, kv = kv)).size)
        assertEquals(1, logins)
        assertTrue(seen.filter { it.requestUrl!!.encodedPath.endsWith("player.php") }.all { it.getHeader("Usertoken") == "SECRET-1" })
    }

    @Test fun anExpiredStoredSessionCostsExactlyOneOtpCall() = runBlocking {
        val kv = MemoryKeyValue()
        resolve(NetmirrorResolver(client, now = { clock }, kv = kv))
        clock += NetmirrorConfig().sessionTtlMs + 1
        assertEquals(3, resolve(NetmirrorResolver(client, now = { clock }, kv = kv)).size)
        assertEquals(2, logins)
    }

    @Test fun aStoredSessionFromAnotherApiBaseCostsExactlyOneOtpCall() = runBlocking {
        val kv = MemoryKeyValue()
        resolve(NetmirrorResolver(client, now = { clock }, kv = kv))
        kv.put("netmirror.session.base", "https://other.example")
        assertEquals(3, resolve(NetmirrorResolver(client, now = { clock }, kv = kv)).size)
        assertEquals(2, logins)
        assertEquals("rewritten to the base that issued it", base, kv.get("netmirror.session.base"))
    }

    @Test fun aRefusedOtpClearsTheStoredSession() = runBlocking {
        val kv = MemoryKeyValue()
        resolve(NetmirrorResolver(client, now = { clock }, kv = kv))
        clock += NetmirrorConfig().sessionTtlMs + 1
        loginError = true
        assertTrue(runCatching { resolve(NetmirrorResolver(client, now = { clock }, kv = kv)) }.isFailure)
        assertTrue(kv.map.keys.none { it.startsWith("netmirror.session.") })
    }

    @Test fun otpRenewsOnCatalogDiscoveryThenContinuesWithPostAndPlayer() = runBlocking {
        reject = 1
        assertEquals(3, resolve(resolver()).size)
        assertEquals(2, logins)
        assertEquals(2, seen.count { it.requestUrl!!.encodedPath.endsWith("ott.php") })
        assertEquals(3, seen.count { it.requestUrl!!.encodedPath.endsWith("search.php") })
        assertTrue(seen.any { it.requestUrl!!.encodedPath.endsWith("player.php") && it.getHeader("Usertoken") == "SECRET-2" })
    }
    @Test fun repeatedOtpStopsWithoutServingItsBogusLink() = runBlocking {
        reject = 20
        val r = resolver()
        assertTrue(runCatching { resolve(r) }.isFailure)
        assertEquals(2, logins)
        assertEquals(0, seen.count { it.requestUrl!!.encodedPath.startsWith("/media/") })
        val before = seen.size
        assertTrue(runCatching { resolve(r) }.isFailure)
        assertEquals(before, seen.size)
    }
    @Test fun loginFailureIsNotCachedAsAnEmptyCatalog() = runBlocking {
        loginError = true
        val r = resolver()
        assertTrue(runCatching { resolve(r) }.isFailure)
        assertEquals(1, logins)
        clock += cfg.cooldownMs + cfg.budgetWindowMs
        loginError = false
        assertEquals(3, resolve(r).size)
        assertEquals(2, logins)
    }
    @Test fun sessionTtlAuthenticatesAgainBeforeNextApiRequest() = runBlocking {
        val r = resolver()
        resolve(r)
        clock += cfg.sessionTtlMs + 1
        resolve(r)
        assertEquals(2, logins)
    }
    @Test fun configRotationClearsSessionAndMetadata() = runBlocking {
        val r = resolver()
        resolve(r)
        apiPrefix = "/v2"
        assertEquals(3, resolve(r, cfg.copy(domains = listOf("$base/other"))).size)
        assertEquals(2, logins)
        assertTrue(seen.any { it.requestUrl!!.encodedPath == "/v2/newtv/player.php" })
    }
    @Test fun rejectsWrongVideoAndPausesNextLookup() = runBlocking {
        clip = true
        val r = resolver()
        assertTrue(runCatching { resolve(r) }.isFailure)
        assertEquals(1, seen.count { it.requestUrl!!.encodedPath.endsWith("player.php") })
        val before = seen.size
        assertTrue(runCatching { resolve(r) }.isFailure)
        assertEquals(before, seen.size)
    }
    @Test fun oneFailedDubDoesNotHideItsTeluguSibling() = runBlocking {
        failFirstDub = true
        val rows = resolve(resolver())
        assertTrue(rows.any { it.key == "netmirror-nf-112" })
        assertEquals(3, rows.size)
    }
    @Test fun partialRowsRemainRetryableAndExplicitRetryCompletesThem() = runBlocking {
 failFirstDub = true
 val r = resolver()
 val partial = resolve(r)
 assertEquals(3, partial.size)
 assertTrue(partial.all { it.incomplete })
 val before = seen.size
 val retried = resolve(r)
 assertEquals(partial, retried)
 assertTrue("Partial results must remain retryable instead of becoming complete cache hits", seen.size > before)
 failFirstDub = false
 val complete = resolve(r, fresh = true)
 assertEquals(4, complete.size)
 assertTrue(complete.none { it.incomplete })
 assertTrue(seen.size > before)
 val completedRequests = seen.size
 assertEquals(complete, resolve(r))
 assertEquals("Complete result should reuse player cache", completedRequests, seen.size)
 }
 @Test fun authoritativeSingleLanguageDoesNotInventSelectableTracks() = runBlocking {
        bare = true
        val sources = resolve(resolver()).map { OnDeviceResolver.toSource(it, codecs) }
        assertTrue(sources.all { it.languages == listOf("Telugu") && !it.selectableAudio })
    }
    @Test fun episodesUseSameSessionAndRequestedSeason() = runBlocking {
        series = true
        val rows = resolve(resolver())
        assertEquals(3, rows.size)
        assertTrue(rows.all { it.key!!.endsWith("444") })
        assertTrue(seen.any { it.path == "/newtv/episodes.php?id=s2" })
    }
    @Test fun concurrentLookupsShareLoginAndCancellationReleasesLock() = runBlocking {
        val r = resolver()
        val a = async { resolve(r) }; val b = async { resolve(r) }
        assertEquals(a.await(), b.await()); assertEquals(1, logins)
        held = true; clock += cfg.metadataTtlMs + 1
        val cancelled = async { resolve(r, fresh = true) }
        delay(100); cancelled.cancelAndJoin()
        held = false
        assertEquals(3, resolve(r, fresh = true).size)
    }
    @Test fun multipleDeviceRowsSurviveRaceAndVmProviderTwinFiltering() = runBlocking {
        val sources = resolve(resolver()).map { OnDeviceResolver.toSource(it, codecs) }
        val device = listOf(CompletableDeferred(sources))
        val vm = listOf(sources[0].copy(id = "vm-nm", onDevice = null))
        val first = StartRace(leadMs = 0, graceMs = 0).firstMany(CompletableDeferred(vm), device, "Telugu")
        assertEquals(3, first.device.size)
        assertEquals(3, StartRace.splitTwins(vm, first.device).first.size)
        assertEquals("netmirror", OnDeviceResolver.nameFor("NetMirror"))
    }
    @Test fun vmTitleFailureUsesScreenTitleAndTimeoutKeepsCompletedCatalogs() = runBlocking {
        val kv = MemoryKeyValue()
        val hosts = HostBook(kv)
        val routed = client.newBuilder().addInterceptor { chain ->
            val req = chain.request()
            chain.proceed(if (req.url.host == "unit.test") req.newBuilder().url(server.url(req.url.encodedPath)).build() else req)
        }.build()
        val store = ResolveConfigStore(routed, "$base/config", kv)
        val device = OnDeviceResolver(null, store, MappleResolver(routed, hosts, kv), VaplayerResolver(routed, hosts) { null },
            titleFor = { _, _ -> throw java.io.IOException("VM unavailable") }, netmirror = NetmirrorResolver(routed, now = { clock }))
        slowHotstar = true
        val rows = device.resolveAll("netmirror", "movie", 1, 1, 1, codecs, title = "Test Movie")
        assertEquals("nf and pv survive hs timeout", 2, rows.size)
        assertTrue(rows.all { it.languages.contains("Telugu") })
        slowHotstar = false
        // The timed-out result was not cached as complete; hs joins next time.
        assertEquals(3, device.resolveAll("netmirror", "movie", 1, 1, 1, codecs, title = "Test Movie").size)
        assertTrue(device.names(false).contains("netmirror"))
    }

    @Test fun completionBetweenSnapshotAndLateListenersIsStillMerged() = runBlocking {
        val sources = resolve(resolver()).map { OnDeviceResolver.toSource(it, codecs) }
        val pending = CompletableDeferred<List<com.chitram.app.data.Source>>()
        val jobs = listOf(pending)
        val first = StartRace(leadMs = 0, waitMs = 0).firstMany(CompletableDeferred(emptyList()), jobs, "Telugu")
        assertTrue(first.device.isEmpty())
        pending.complete(sources) // completion in the snapshot/listener gap
        var current = first.device
        jobs.map { async { com.chitram.app.data.Ranking.merge(current, it.await(), "Telugu", null) } }
            .forEach { current = it.await() }
        assertEquals(3, current.size)
        assertTrue(current.first().languages.contains("Telugu"))
        // Replaying a completed job must not introduce duplicate source IDs.
        assertEquals(3, com.chitram.app.data.Ranking.merge(current, pending.await(), "Telugu", null).size)
    }

    @Test fun signedLinkExpiryBeatsPlayerCacheTtl() = runBlocking {
        expiring = true
        val r = resolver()
        resolve(r)
        clock += 6000
        resolve(r)
        assertEquals(6, seen.count { it.requestUrl!!.encodedPath.endsWith("player.php") })
        assertEquals(3, seen.count { it.requestUrl!!.encodedPath.endsWith("search.php") })
    }

    @Test fun shuffledSeasonsAndOpaquePaginationFollowTheRequestedEpisode() = runBlocking {
        series = true; nonSequential = true; paged = true
        val rows = resolve(resolver())
        assertEquals(3, rows.size)
        val episodes = seen.filter { it.requestUrl!!.encodedPath.endsWith("episodes.php") }
        assertTrue(episodes.any { it.path == "/newtv/episodes.php?id=s2" })
        assertTrue(episodes.any { it.path == "/newtv/episodes.php?id=cursor-s2&page=3" })
        assertFalse(episodes.any { it.path!!.contains("id=s1") || it.path!!.contains("id=s3") || it.path!!.contains("page=2") })
    }
    @Test fun repeatedPaginationCursorIsFailureAndNeverAnEmptyCachedCatalog() = runBlocking {
        series = true; paged = true; repeatCursor = true
        val r = resolver()
        assertTrue(runCatching { resolve(r) }.isFailure)
        assertEquals(0, seen.count { it.requestUrl!!.encodedPath.endsWith("player.php") })
        // Metadata already fetched is reusable, but no falsely complete empty row cache is installed.
        repeatCursor = false; clock += cfg.metadataTtlMs + 1
        assertEquals(3, resolve(r).size)
    }
    @Test fun audioMenuParserKeepsTheRequestedLanguageRatherThanGlobalDefault() = runBlocking {
        val rows = resolve(resolver()).map { OnDeviceResolver.toSource(it, codecs) }
        val s = rows[0]
        val picked = com.chitram.app.player.AudioChoice.source("src:${s.id}:Hindi", rows)!!
        assertEquals(s.id, picked.first.id)
        assertEquals("Hindi", picked.second)
        assertNull(com.chitram.app.player.AudioChoice.source("src:${s.id}:French", rows))
        assertNull(com.chitram.app.player.AudioChoice.source("src:missing:Hindi", rows))
        assertNull(com.chitram.app.player.AudioChoice.source("src:${s.id}", rows)!!.second)
    }

    @Test fun newlyAdvertisedCatalogIsResolvedAndPreservedWithoutAnAppUpdate() = runBlocking {
        extraCatalog = true
        val rows = resolve(resolver())
        assertEquals(4, rows.size)
        assertTrue(rows.any { it.key == "netmirror-extra-111" && it.label.endsWith("EXTRA") })
        assertEquals(1, seen.count { it.requestUrl!!.encodedPath.endsWith("ott.php") })
        assertFalse(rows.any { it.incomplete })
    }

    @Test fun publicConfigRejectsBadHostsAndContainsNoToken() {
        val parsed = ResolveConfig.parse("""{"netmirror":{"domains":["http://evil"],"maxCalls":0,"sessionTtlMs":999999999}}""")
        assertEquals(NetmirrorConfig().domains, parsed.netmirror.domains)
        assertEquals(1, parsed.netmirror.maxCalls)
        assertEquals(3_600_000L, parsed.netmirror.sessionTtlMs)
    }
}
