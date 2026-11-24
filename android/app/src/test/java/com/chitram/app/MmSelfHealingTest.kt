package com.chitram.app

import com.chitram.app.data.*
import com.chitram.app.resolve.*
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class MmSelfHealingTest {
    private val server=MockWebServer()
    private val base=server.url("").toString().trimEnd('/')
    private val client=OkHttpClient()
    private val now=1_800_000_000_000L
    private val master="#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",LANGUAGE=\"te\",NAME=\"Original\",URI=\"te.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO=\"a\"\nv.m3u8\n"
    @After fun close() { server.shutdown() }
    private fun store(json: String): ResolveConfigStore {
        val kv=MemoryKeyValue()
        kv.put(ResolveConfigStore.KEY,json);kv.put(ResolveConfigStore.KEY_AT,now.toString())
        return ResolveConfigStore(client,"$base/config",kv,now={now})
    }
    @Test fun publishedParserEndpointAndUserAgentAreConsumedThroughMediaHeaders()= runBlocking {
        val seen=CopyOnWriteArrayList<RecordedRequest>()
        server.dispatcher=object: Dispatcher(){override fun dispatch(r:RecordedRequest):MockResponse {
            seen+=r
            return when(r.path){
                "/new/embed/imdb/tt8178634" -> MockResponse().setBody("sourceLink=$base/master.m3u8")
                "/master.m3u8" -> MockResponse().setBody(master)
                else -> MockResponse().setBody("segment")
            }
        }}
        val cfg=InsertunitConfig(base="$base/new",userAgent="Healed-UA",hlsPatterns=listOf("sourceLink=(https?://\\S+)"))
        val row=InsertunitResolver(client,origin="https://obsolete.invalid").resolveAll("movie",579974,"tt8178634",0,0,cfg=cfg).single()
        assertEquals(listOf("Telugu"),Hls.languages(row.audio))
        StreamInterceptor.client(client,row.headers,row.segmentToken).fetch(Request.Builder().url("$base/segment.ts").build())
        assertEquals(3,seen.size)
        assertTrue(seen.all{it.getHeader("User-Agent")=="Healed-UA" && it.getHeader("Referer")==null})
    }
    @Test fun fingerprintIgnoresDeliveryMetadataButTracksEndpointParserAndHeaderChanges() {
        val a=ResolveConfig()
        assertEquals(a.fingerprint("insertunit"),a.copy(version=999,ttlSec=60,prewarm=emptySet()).fingerprint("insertunit"))
        assertNotEquals(a.fingerprint("insertunit"),a.copy(insertunit=a.insertunit.copy(userAgent="new-UA")).fingerprint("insertunit"))
        assertNotEquals(a.fingerprint("insertunit"),a.copy(insertunit=a.insertunit.copy(hlsPatterns=listOf("new=(.*)"))).fingerprint("insertunit"))
        val cfg=ResolveConfig.parse("""{"insertunit":{"enabled":false,"base":"https://new.example","userAgent":"new-UA","hlsPatterns":["source=(.*)"],"budgetMs":7000},"vidout":{"catalogue":"https://catalog.example/hls"}}""")
        assertFalse(cfg.enabled("insertunit"));assertEquals("https://new.example",cfg.insertunit.base)
        assertEquals(listOf("source=(.*)"),cfg.insertunit.hlsPatterns)
        assertEquals(7000L,cfg.insertunit.budgetMs)
        assertEquals("https://catalog.example/hls",cfg.vidout.catalogue)
    }
    @Test fun disabledProviderDoesNotServeItsCacheOrStartAnotherRequest()= runBlocking {
        val cfg=store("""{"insertunit":{"enabled":false,"prewarm":true}}""")
        val cache=StreamCache(MemoryKeyValue()){now}
        val key=StreamCache.key("movie",579974,0,0)
        val row=OnDeviceResolver.toSource(TaggedHls.row(master,"$base/master.m3u8","insertunit","Insertunit",emptyMap())!!,CodecSupport{_,_->true})
        cache.putDevice(key,"insertunit","Telugu",listOf(row))
        val od=OnDeviceResolver(null,cfg,MappleResolver(client,HostBook(MemoryKeyValue()),MemoryKeyValue()),VaplayerResolver(client,HostBook(MemoryKeyValue()),bundledWasm={ByteArray(0)}),insertunit=InsertunitResolver(client,base),cache=cache,imdbFor={_,_->"tt8178634"})
        assertTrue(od.resolveAll("insertunit","movie",579974,0,0,CodecSupport{_,_->true}).isEmpty())
        assertFalse(od.prewarmNames().contains("insertunit"))
        assertTrue(InsertunitResolver(client,base).resolveAll("movie",579974,"tt8178634",0,0,cfg=InsertunitConfig(enabled=false)).isEmpty())
        assertEquals(0,server.requestCount)
        assertNotNull(cache.device(key,"insertunit","Telugu"))
    }
    @Test fun obsoleteLookupIsCancelledBeforeItsNextStepAndCannotOverwriteTheCache()= runBlocking {
        val seen=CopyOnWriteArrayList<String>()
        server.dispatcher=object: Dispatcher(){override fun dispatch(r:RecordedRequest):MockResponse {
            seen+=r.path.orEmpty()
            return when(r.path){
                "/config" -> MockResponse().setBody("""{"insertunit":{"userAgent":"new-UA"}}""")
                "/old" -> MockResponse().setBody("old").setBodyDelay(3,TimeUnit.SECONDS)
                else -> MockResponse().setBody("new")
            }
        }}
        val store=store("""{"insertunit":{"userAgent":"old-UA"}}""")
        val old=store.lease("insertunit")
        val task=async(Dispatchers.IO+ResolveLeaseContext(store,old)) {
            client.fetch(Request.Builder().url("$base/old").build())
            client.fetch(Request.Builder().url("$base/forbidden-old-next-step").build())
        }
        assertNotNull(withContext(Dispatchers.IO){server.takeRequest(2,TimeUnit.SECONDS)})
        store.refresh()
        try {task.await();fail("obsolete lookup returned")} catch(_:ObsoleteConfiguration){}
        var wrote=false;assertFalse(store.ifCurrent(old){wrote=true});assertFalse(wrote)
        val fresh=store.lease("insertunit")
        assertTrue(store.ifCurrent(fresh){wrote=true});assertTrue(wrote)
        withContext(ResolveLeaseContext(store,fresh)){assertEquals("new",client.fetch(Request.Builder().url("$base/new").build()).body)}
        assertEquals(listOf("/old","/config","/new"),seen.toList())
    }
    @Test fun callerCancellationDuringResponseBodyStartsNoNextRequest()= runBlocking {
        server.enqueue(MockResponse().setBody("slow").setBodyDelay(3,TimeUnit.SECONDS))
        val task=launch(Dispatchers.IO){client.fetch(Request.Builder().url("$base/body").build());client.fetch(Request.Builder().url("$base/forbidden").build())}
        assertNotNull(withContext(Dispatchers.IO){server.takeRequest(2,TimeUnit.SECONDS)})
        withTimeout(1000){task.cancelAndJoin()}
        assertEquals(1,server.requestCount)
    }
}
