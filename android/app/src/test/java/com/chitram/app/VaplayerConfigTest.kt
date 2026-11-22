package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.StepException
import com.chitram.app.resolve.VaplayerConfig
import com.chitram.app.resolve.VaplayerResolver
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Provider self-heal Task 12: the player page's `const CONFIG = {...}` backs up
 * the apiToken regex, its streamDataApiUrl beats the configured apiUrl, and
 * rateLimited:true is a 429 so the breaker backs off.
 */
class VaplayerConfigTest {
    private val urls = CopyOnWriteArrayList<String>()

    /** Wrapper -> player page [page] -> api.php answers "not here" (status 404), so resolve returns null. */
    private fun client(page: String) = OkHttpClient.Builder().addInterceptor { chain ->
        val u = chain.request().url.toString()
        urls += u
        val body = when {
            "/embed/va_src.php" in u -> """{"src":"https://player.test/p/1"}"""
            u.startsWith("https://player.test/") -> page
            "/api.php?" in u -> """{"status_code":"404"}"""
            else -> ""
        }
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body(body.toResponseBody("text/html".toMediaType())).build()
    }.build()

    private val cfg = VaplayerConfig(wrapperBases = listOf("https://wrap.test"), apiUrl = "https://streamdata.wrap.test/api.php")

    private suspend fun run(page: String, c: VaplayerConfig = cfg) =
        VaplayerResolver(client(page), HostBook(MemoryKeyValue())) { null }.resolve(c, "tt0816692", "movie")

    private fun apiCall() = urls.single { "/api.php?" in it }

    @Test fun regexMatchKeepsTodaysPath() = runBlocking {
        assertNull(run("""<script>var x = {"apiToken":"TOK1"};</script>"""))
        assertTrue(apiCall(), apiCall().startsWith("https://streamdata.wrap.test/api.php?"))
        assertTrue(apiCall().endsWith("api_token=TOK1"))
    }

    @Test fun regexMissTokenFromConfig() = runBlocking {
        val page = """<script>const CONFIG = { apiToken: 'TOK2', debug: false, nested: {a: "x}y"}, };</script>"""
        assertNull(run(page, cfg.copy(apiTokenRegex = "nomatch=([a-z]+)")))
        assertTrue(apiCall(), apiCall().endsWith("api_token=TOK2"))
    }

    @Test fun configStreamDataApiUrlWins() = runBlocking {
        val page = """<script>const CONFIG = {"apiToken":"TOK3","streamDataApiUrl":"https://streamdata.moved.test/v2/api.php"};</script>"""
        assertNull(run(page))
        assertTrue(apiCall(), apiCall().startsWith("https://streamdata.moved.test/v2/api.php?"))
        assertTrue(apiCall().endsWith("api_token=TOK3"))
    }

    @Test fun nonHttpsStreamDataApiUrlIgnored() = runBlocking {
        assertNull(run("""<script>let CONFIG = {apiToken: "TOK4", streamDataApiUrl: "http://evil.test/api.php"};</script>"""))
        assertTrue(apiCall(), apiCall().startsWith("https://streamdata.wrap.test/api.php?"))
    }

    @Test fun rateLimitedIs429() = runBlocking {
        val err = runCatching { run("""<script>const CONFIG = {"apiToken":"TOK5","rateLimited":true};</script>""") }.exceptionOrNull()
        assertTrue("$err", err is StepException && err.code == 429 && err.step == "vaplayer")
        assertTrue(urls.none { "/api.php?" in it })
    }

    @Test fun noTokenAnywhereStillFails() = runBlocking {
        val err = runCatching { run("<html>nothing</html>") }.exceptionOrNull()
        assertTrue("$err", err is StepException && err.step == "vaplayer player")
    }

    @Test fun parseConfigShapes() {
        assertEquals("a", VaplayerResolver.parseConfig("""const CONFIG = {"apiToken":"a"}""")?.get("apiToken")?.toString()?.trim('"'))
        assertEquals("b", VaplayerResolver.parseConfig("""var CONFIG={apiToken:'b',list:[1,2,],}""")?.get("apiToken")?.toString()?.trim('"'))
        assertNull(VaplayerResolver.parseConfig("const CONFIG = {apiToken: fn()}"))
        assertNull(VaplayerResolver.parseConfig("const CONFIG = {unclosed: 1"))
        assertNull(VaplayerResolver.parseConfig("no config here"))
    }

    /** Review M5: a hostile, deeply nested CONFIG must not throw (StackOverflowError is an Error). */
    @Test fun deeplyNestedConfigFallsBackToRegexPath() = runBlocking {
        val n = 200_000
        val nested = "{\"a\":".repeat(n) + "1" + "}".repeat(n)
        val page = """<script>var x = {"apiToken":"TOK9"}; const CONFIG = $nested;</script>"""
        assertNull(VaplayerResolver.parseConfig(page))
        assertNull(run(page))
        assertTrue(apiCall(), apiCall().endsWith("api_token=TOK9"))
    }
}
