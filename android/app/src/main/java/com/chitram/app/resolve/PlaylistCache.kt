package com.chitram.app.resolve

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * HLS playlist bodies (master, video and audio media playlists) kept in memory
 * next to the kept rows (StreamCache), so a second Play of a kept row starts
 * with no playlist request. RRR second Play, phone 1.2.48: master 775 ms, then
 * video 449 ms, then audio 678 ms, one after another, before the first segment.
 *
 * Memory only. An entry lives [StreamCache.TTL_MS], less when its url or its
 * master's url states an earlier expiry ([UrlExpiry]). Only a master and a VOD
 * media playlist (#EXT-X-ENDLIST) are kept: a live playlist changes. At most
 * [MAX_BYTES] in all; the least recently used go first. Keys drop a `token`
 * query parameter (vaplayer's segment token is added per request).
 */
class PlaylistCache(private val now: () -> Long = System::currentTimeMillis, private val maxBytes: Long = MAX_BYTES) {
    class Entry(val body: ByteArray, val type: String?, val until: Long, val root: String)

    private val map = LinkedHashMap<String, Entry>(16, 0.75f, true)
    private var bytes = 0L
    /** Playlists being fetched now (prefetch): a player request for one waits for it. */
    private val inflight = ConcurrentHashMap<String, CompletableFuture<Entry?>>()
    /** Child playlist key -> its master's key, so dropping a row drops its playlists too. */
    private val roots = ConcurrentHashMap<String, String>()

    fun get(url: String): Entry? = synchronized(this) {
        val k = key(url)
        val e = map[k] ?: return null
        if (e.until <= now()) { remove(k); return null }
        e
    }

    fun has(url: String): Boolean = get(url) != null

    fun put(url: String, body: ByteArray, type: String?) {
        val k = key(url)
        val root = roots[k] ?: k
        val at = now()
        val expiry = listOfNotNull(UrlExpiry.at(url, at), UrlExpiry.at(root, at)).minOrNull()
        val until = minOf(at + StreamCache.TTL_MS, (expiry ?: Long.MAX_VALUE) - StreamCache.EXPIRY_SKEW_MS)
        if (until <= at || body.size > MAX_BODY) return
        synchronized(this) {
            remove(k)
            map[k] = Entry(body, type, until, root)
            bytes += body.size
            val it = map.entries.iterator()
            while (bytes > maxBytes && it.hasNext()) { val e = it.next(); bytes -= e.value.body.size; it.remove() }
        }
    }

    /** Marks [child] as one of [master]'s playlists. */
    fun link(master: String, child: String) { roots[key(child)] = roots[key(master)] ?: key(master) }

    /** A row is dead (failed in playback, refreshed): its master and every playlist under it go. */
    fun evict(url: String) = synchronized(this) {
        val k = key(url)
        val drop = map.filter { (key, e) -> key == k || e.root == k }.keys
        drop.forEach { remove(it) }
        roots.entries.removeIf { it.value == k }
        drop.size
    }

    /** Registers a fetch of [url]: a future to complete, or null when it is kept or already being fetched. */
    fun begin(url: String): CompletableFuture<Entry?>? {
        if (has(url)) return null
        val f = CompletableFuture<Entry?>()
        return if (inflight.putIfAbsent(key(url), f) == null) f else null
    }

    fun finish(url: String, e: Entry?) { val k = key(url); calls.remove(k); inflight.remove(k)?.complete(e) }

    fun pending(url: String): CompletableFuture<Entry?>? = inflight[key(url)]

    internal fun size(): Int = synchronized(this) { map.size }

    /** The prefetch calls in flight, so a hung one can be cancelled (gap 4.2). */
    private val calls = ConcurrentHashMap<String, okhttp3.Call>()

    fun track(url: String, call: okhttp3.Call) { calls[key(url)] = call }

    /** A prefetch the player gave up on: cancel it and forget it, so the player's own fetch is the only one. */
    fun cancelPending(url: String) {
        val k = key(url)
        calls.remove(k)?.cancel()
        inflight.remove(k)?.complete(null)
    }

    /**
     * Gap 3.7: Android asks for memory back (App.onTrimMemory). RUNNING_LOW (10),
     * RUNNING_CRITICAL (15) and BACKGROUND or worse (40+) drop every kept playlist;
     * RUNNING_MODERATE (5) and UI_HIDDEN (20) keep them (a second Play needs them).
     * Returns the playlists dropped.
     */
    fun trim(level: Int): Int {
        if (level != 10 && level != 15 && level < 40) return 0
        return synchronized(this) { val n = map.size; map.clear(); bytes = 0; n }
    }

    private fun remove(k: String) { map.remove(k)?.let { bytes -= it.body.size } }

    companion object {
        const val MAX_BYTES = 32L * 1024 * 1024
        /** RRR's vidrift playlists are 1.6 MB each. */
        const val MAX_BODY = 4 * 1024 * 1024

        fun key(url: String): String {
            val u = url.toHttpUrlOrNull() ?: return url
            return if (u.queryParameter("token") == null) u.toString() else u.newBuilder().removeAllQueryParameters("token").build().toString()
        }
    }
}

/** One parsed EXT-X-STREAM-INF or EXT-X-MEDIA line of a master. */
object MasterPlaylist {
    data class Variant(val uri: String, val bandwidth: Long, val height: Int, val audio: String?)
    data class Media(val uri: String, val group: String?, val language: String?, val default: Boolean)

    private val ATTR = Regex("""([A-Z0-9-]+)=("[^"]*"|[^,]*)""")
    private fun attrs(line: String): Map<String, String> =
        ATTR.findAll(line.substringAfter(':')).associate { it.groupValues[1] to it.groupValues[2].trim('"') }

    fun isMaster(text: String): Boolean = text.contains("#EXT-X-STREAM-INF")

    fun variants(text: String): List<Variant> {
        val lines = text.lines().map { it.trim() }
        return lines.mapIndexedNotNull { i, l ->
            if (!l.startsWith("#EXT-X-STREAM-INF:")) return@mapIndexedNotNull null
            val uri = lines.drop(i + 1).firstOrNull { it.isNotEmpty() && !it.startsWith("#") } ?: return@mapIndexedNotNull null
            val a = attrs(l)
            Variant(uri, a["BANDWIDTH"]?.toLongOrNull() ?: 0, a["RESOLUTION"]?.substringAfter('x')?.toIntOrNull() ?: 0, a["AUDIO"])
        }
    }

    fun audio(text: String): List<Media> = text.lines().map { it.trim() }.filter { it.startsWith("#EXT-X-MEDIA:") }.mapNotNull { l ->
        val a = attrs(l)
        if (a["TYPE"] != "AUDIO") return@mapNotNull null
        Media(a["URI"] ?: return@mapNotNull null, a["GROUP-ID"], a["LANGUAGE"], a["DEFAULT"] == "YES")
    }

    /**
     * The playlists the player asks for first, fetched together: the first variant
     * (media3 loads it as the primary playlist), the variant the capped start picks
     * ([startVariant]), and that variant's audio rendition in the viewer's language
     * (else the DEFAULT one, else the first). Never segments.
     */
    fun firstLoads(text: String, iso: List<String>, capBps: Long): List<String> {
        val vs = variants(text)
        val start = startVariant(vs, capBps)
        val group = start?.audio
        val inGroup = audio(text).filter { group == null || it.group == group }
        val lang = iso.map { it.lowercase() }
        val a = inGroup.firstOrNull { m -> m.language?.lowercase()?.let { l -> lang.any { it == l || it.take(2) == l.take(2) && l.length >= 2 } } == true }
            ?: inGroup.firstOrNull { it.default } ?: inGroup.firstOrNull()
        return listOfNotNull(vs.firstOrNull()?.uri, start?.uri, a?.uri).distinct()
    }

    /**
     * The variant media3's adaptive selection starts on under the start cap: the
     * highest BANDWIDTH within 0.7 of [capBps] (AdaptiveTrackSelection's default
     * bandwidth fraction), else the lowest.
     */
    fun startVariant(vs: List<Variant>, capBps: Long): Variant? {
        val fit = vs.filter { it.bandwidth > 0 && it.bandwidth <= capBps * 7 / 10 }
        return fit.maxByOrNull { it.bandwidth } ?: vs.minByOrNull { if (it.bandwidth > 0) it.bandwidth else Long.MAX_VALUE }
    }

    /**
     * 1.2.56: [text] with the [startVariant] block (its EXT-X-STREAM-INF line and uri)
     * moved to the first variant slot. media3 loads its first chunk from the first
     * listed variant; every MultiMovies master lists a 1080p 5 Mbps variant first,
     * so the start loaded 1080p, then the cap picked 720p and cancelled it (phone
     * 1.2.54: 1790 ms and 261660 B lost). Every line is kept; the same object comes
     * back when there is nothing to move.
     */
    fun startFirst(text: String, capBps: Long): String {
        val vs = variants(text)
        val start = startVariant(vs, capBps) ?: return text
        if (vs.size < 2 || vs.first() == start) return text
        val lines = text.lines()
        val trimmed = lines.map { it.trim() }
        // The start block: its EXT-X-STREAM-INF line through its uri line.
        val infos = trimmed.indices.filter { trimmed[it].startsWith("#EXT-X-STREAM-INF:") }
        val from = infos.firstOrNull { i ->
            trimmed.drop(i + 1).firstOrNull { it.isNotEmpty() && !it.startsWith("#") } == start.uri &&
                variants(trimmed[i] + "\n" + start.uri).firstOrNull() == start
        } ?: return text
        val to = (from + 1 until lines.size).first { trimmed[it].isNotEmpty() && !trimmed[it].startsWith("#") }
        val block = lines.subList(from, to + 1)
        val rest = lines.subList(0, from) + lines.subList(to + 1, lines.size)
        val at = rest.indexOfFirst { it.trim().startsWith("#EXT-X-STREAM-INF:") }
        return (rest.subList(0, at) + block + rest.subList(at, rest.size)).joinToString("\n")
    }
}

/**
 * The player's (and the prewarm's) playlist layer, as the innermost application
 * interceptor of a stream client:
 *  - a kept playlist is answered from memory (0 requests);
 *  - a playlist being prefetched is waited for, not fetched twice;
 *  - a fetched master or VOD playlist is kept;
 *  - a master starts its first video and audio playlists at once, in parallel
 *    (media3 asks for the audio playlist only after the video playlist).
 * [client] must be the client this interceptor sits in, set after build ([attach]).
 */
class PlaylistInterceptor(
    private val cache: PlaylistCache,
    private val iso: () -> List<String>,
    private val capBps: Long = StartCap.START_BPS,
) : Interceptor {
    @Volatile var client: OkHttpClient? = null

    /** Marks a prefetch request: it fills the cache and never waits on itself. */
    object Prefetch

    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        if (req.method != "GET" || req.header("Range") != null) return chain.proceed(req)
        val url = req.url.toString()
        val prefetch = req.tag(Prefetch::class.java) != null
        if (!prefetch) {
            cache.get(url)?.let { return served(req, it, "memory") }
            cache.pending(url)?.let { f ->
                val e = runCatching { f.get(WAIT_MS, TimeUnit.MILLISECONDS) }.getOrNull()
                if (e != null) return served(req, e, "prefetched")
                // Gap 4.2: the prefetch hung (or failed): cancel it, so this fetch is the only one.
                cache.cancelPending(url)
                android.util.Log.i("Chitram", "[playlist] prefetch of ${req.url.host}/${req.url.encodedPath.takeLast(40)} gave nothing in ${WAIT_MS}ms, fetched directly")
            }
        }
        val res = try { chain.proceed(req) } catch (e: Exception) { if (prefetch) cache.finish(url, null); throw e }
        if (!res.isSuccessful || res.header("Content-Encoding") != null || !looksLikePlaylist(req.url, res)) {
            if (prefetch) cache.finish(url, null)
            return res
        }
        val body = runCatching { res.peekBody(PlaylistCache.MAX_BODY + 1L).bytes() }.getOrNull()
        val text = body?.takeIf { it.size <= PlaylistCache.MAX_BODY }?.let { String(it, Charsets.UTF_8) }
        if (text == null || !text.trimStart().startsWith("#EXTM3U")) { if (prefetch) cache.finish(url, null); return res }
        val master = MasterPlaylist.isMaster(text)
        // 1.2.56: the start variant first, so media3's first chunk is the one the cap plays.
        val served = if (master) MasterPlaylist.startFirst(text, capBps) else text
        val moved = served !== text
        if (moved) {
            val from = MasterPlaylist.variants(text).first()
            val to = MasterPlaylist.variants(served).first()
            android.util.Log.i("Chitram", "[playlist] start variant first ${req.url.host}: ${to.height}p ${to.bandwidth}bps before ${from.height}p ${from.bandwidth}bps")
        }
        val keptBody = if (moved) served.toByteArray(Charsets.UTF_8) else body
        if (master || text.contains("#EXT-X-ENDLIST")) cache.put(url, keptBody, res.header("Content-Type"))
        if (prefetch) cache.finish(url, cache.get(url))
        if (master) prefetchChildren(req, served)
        if (!moved) return res
        val type = res.header("Content-Type")
        return res.newBuilder().removeHeader("Content-Length")
            .body(keptBody.toResponseBody((type ?: M3U8).toMediaTypeOrNull())).build().also { res.close() }
    }

    /** The master's first playlists, all at once, through this same client (its headers and token). */
    private fun prefetchChildren(master: Request, text: String) {
        val c = client ?: return
        val kids = MasterPlaylist.firstLoads(text, iso(), capBps).mapNotNull { master.url.resolve(it) }
        var started = 0
        for (u in kids) {
            cache.link(master.url.toString(), u.toString())
            if (cache.begin(u.toString()) == null) continue
            started++
            val r = Request.Builder().url(u).tag(Prefetch::class.java, Prefetch).build()
            c.newCall(r).also { cache.track(u.toString(), it) }.enqueue(object : okhttp3.Callback {
                override fun onFailure(call: okhttp3.Call, e: java.io.IOException) = cache.finish(u.toString(), null)
                override fun onResponse(call: okhttp3.Call, response: Response) = response.use { cache.finish(u.toString(), cache.get(u.toString())) }
            })
        }
        if (started > 0) android.util.Log.i("Chitram", "[playlist] ${master.url.host}: $started playlist(s) fetched in parallel")
    }

    private fun served(req: Request, e: PlaylistCache.Entry, how: String): Response {
        android.util.Log.i("Chitram", "[playlist] $how hit ${req.url.host}/${req.url.encodedPath.takeLast(40)} ${e.body.size}B, 0 requests")
        return Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .header("Content-Type", e.type ?: M3U8)
            .body(e.body.toResponseBody((e.type ?: M3U8).toMediaTypeOrNull()))
            .build()
    }

    companion object {
        const val M3U8 = "application/vnd.apple.mpegurl"
        /**
         * A prefetch the player joins is waited for at most this long, then cancelled
         * and fetched anew (gap 4.2: a hung prefetch on slow 2G held the player 8 s).
         * A healthy prefetch started earlier answers well inside it (children 400-700 ms).
         */
        const val WAIT_MS = 1_500L

        fun looksLikePlaylist(url: HttpUrl, res: Response): Boolean {
            val path = url.encodedPath.lowercase()
            val type = res.header("Content-Type").orEmpty().lowercase()
            return path.endsWith(".m3u8") || path.endsWith(".m3u") || type.contains("mpegurl") || path.endsWith("/m3u8-proxy")
        }

        /** [base] with this interceptor innermost, wired to its own client for prefetches. */
        fun attach(base: OkHttpClient, cache: PlaylistCache, iso: () -> List<String>): OkHttpClient {
            val p = PlaylistInterceptor(cache, iso)
            return base.newBuilder().addInterceptor(p).build().also { p.client = it }
        }

        /**
         * Prewarm finished: fetch the top row's master and its first video and audio
         * playlists (no segments) into [cache], through a client carrying the row's
         * headers and token. Returns false when the master is already kept.
         */
        fun warm(base: OkHttpClient, cache: PlaylistCache, url: String, headers: Map<String, String>, token: String?, iso: List<String>): Boolean {
            if (cache.has(url)) return false
            val c = attach(StreamInterceptor.client(base, headers, token), cache) { iso }
            c.newCall(Request.Builder().url(url).tag(Prefetch::class.java, Prefetch).build()).execute().close()
            return true
        }
    }
}

/**
 * Start cap (fast first frame): until a play's first frame the adaptive video
 * selection sees at most [START_BPS] of bandwidth, so it starts on a lower
 * rendition (about 720p) and climbs once playback runs. It only lowers the
 * bitrate the adaptive selection may pick inside a track group: the audio
 * language and the track groups chosen do not change.
 */
object StartCap {
    /** 0.7 of it (adaptive bandwidth fraction) is 2.1 Mbps: a 720p rendition, not 1080p. */
    const val START_BPS = 3_000_000L

    fun estimate(measured: Long, capped: Boolean): Long = if (capped) minOf(measured, START_BPS) else measured
}
