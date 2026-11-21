package com.chitram.app

import com.chitram.app.resolve.Hls
import com.chitram.app.resolve.VidriftResolver
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * ONE live VidriftResolver run per title from this machine's IP: RRR (579974,
 * originalLang te) and Krack (784572, te). Skipped unless CHITRAM_LIVE=1.
 * One page + one master per language each; no loops.
 */
class LiveVidriftTest {
    @Test fun rrrAndKrack() = runBlocking {
        assumeTrue(System.getenv("CHITRAM_LIVE") == "1")
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val q = chain.request(); val t = System.currentTimeMillis()
            try {
                chain.proceed(q).also { println("LIVE ${q.method} ${q.url.host}${q.url.encodedPath} -> ${it.code} ${System.currentTimeMillis() - t}ms") }
            } catch (e: java.io.IOException) {
                println("LIVE ${q.method} ${q.url.host}${q.url.encodedPath} -> ${e.message} ${System.currentTimeMillis() - t}ms"); throw e
            }
        }.build()
        for ((name, id) in listOf("RRR" to 579974L, "Krack" to 784572L)) {
            val t0 = System.currentTimeMillis()
            val rows = try { VidriftResolver(client).resolveAll("movie", id, 0, 0, originalLang = "te") } catch (e: Exception) {
                println("LIVE vidrift $name: FAILED in ${System.currentTimeMillis() - t0}ms: ${e.message}"); continue
            }
            println("LIVE vidrift $name: ${rows.size} row(s) in ${System.currentTimeMillis() - t0}ms")
            rows.forEach { r ->
                println("LIVE   ${r.key} top=${r.levels.firstOrNull()?.height}p codecs=${r.codecs} langs=${(Hls.languages(r.audio) + r.languages).distinct()} " +
                    "audio=${r.audio.joinToString { "${it.language}/${it.name}" }} subs=${r.subtitles.size} host=${r.url.substringAfter("://").substringBefore('/')}")
            }
        }
    }
}
