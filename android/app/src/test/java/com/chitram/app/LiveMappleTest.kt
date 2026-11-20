package com.chitram.app

import com.chitram.app.data.MemoryKeyValue
import com.chitram.app.resolve.HostBook
import com.chitram.app.resolve.MappleConfig
import com.chitram.app.resolve.MappleResolver
import com.chitram.app.resolve.StreamInterceptor
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * ONE live resolve against the real mapple.fun, from this machine's IP.
 * Skipped unless CHITRAM_LIVE=1. One title (Salaar 770906), one front (s12,
 * where it was found 2026-11-20): 7 requests, plus 1 master refetch without
 * headers to confirm they are required. No loops.
 */
class LiveMappleTest {
    @Test fun salaarResolvesOnThisDevice() = runBlocking {
        assumeTrue(System.getenv("CHITRAM_LIVE") == "1")
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val q = chain.request(); val t = System.currentTimeMillis()
            try {
                chain.proceed(q).also { println("LIVE ${q.method} ${q.url.host}${q.url.encodedPath} -> ${it.code} ${System.currentTimeMillis() - t}ms") }
            } catch (e: java.io.IOException) {
                println("LIVE ${q.method} ${q.url.host}${q.url.encodedPath} -> ${e.message} ${System.currentTimeMillis() - t}ms"); throw e
            }
        }.build()
        val kv = MemoryKeyValue()
        val t0 = System.currentTimeMillis()
        val r = MappleResolver(client, HostBook(kv), kv).resolve(MappleConfig(fronts = listOf("s12")), "movie", 770906)
        val ms = System.currentTimeMillis() - t0
        assertNotNull("mapple gave no row", r)
        r!!
        println("LIVE mapple: ${ms}ms label=${r.label} host=${okhttp3.HttpUrl.Companion.run { r.url.substringBefore('?').substringAfter("://").substringBefore('/') }}")
        println("LIVE audio (${r.audio.size}): " + r.audio.joinToString { "${it.language}/${it.name}${if (it.isDefault) "*" else ""}" })
        println("LIVE levels: " + r.levels.joinToString { "${it.height}p" } + " codecs=${r.codecs}")
        assertEquals("Telugu", r.audio.first().label)
        val bare = client.newCall(Request.Builder().url(r.url).build()).execute().use { it.code }
        val withHdr = StreamInterceptor.client(client, r.headers, null).newCall(Request.Builder().url(r.url).build()).execute().use { it.code }
        println("LIVE master no-headers=$bare with-headers=$withHdr")
        assertEquals(200, withHdr)
    }
}
