package com.chitram.app.resolve

import com.chitram.app.data.KeyValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * mapple on the device (the VM's datacenter IP is blocked; a home IP is not).
 * Same chain as providers/mapple.js, proved end to end from a residential IP
 * on 2026-11-20 (Salaar 770906 on front s12, 14 audio tracks, Telugu first):
 *   1. GET  /watch/<type>/<id>       sets cookies
 *   2. POST /api/ui/session          requestToken
 *   3. POST /api/media-session       streamToken, behind a PoW (difficulty 18)
 *   4. POST /api/encrypt per front   signed path; GET it -> stream_url (the master)
 * Every path, the front list and the hosts come from [MappleConfig].
 *
 * Self-recovery: the session host heals through [HostBook]; a front that errors
 * is skipped for the rest of the session; the last front that worked is tried
 * first next time (kept across launches).
 */
class MappleResolver(
    client: OkHttpClient,
    private val hosts: HostBook,
    private val kv: KeyValue,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val base = client.newBuilder().followRedirects(false).followSslRedirects(false).build()
    private val streamBase = client
    private val mutex = Mutex()
    @Volatile private var session: Session? = null

    private class Session(val base: String, val jar: Jar, val requestToken: String, val at: Long)

    /**
     * Per-front health, kept across sessions. A front that errors or times out
     * cools down (frontCooldownMs, doubling per consecutive failure, max 10 min)
     * and is tried LAST while cooling, never dropped: one slow answer must not
     * hide the only front that has the title. Any answer resets it.
     */
    private class FrontHealth(var fails: Int = 0, var coolUntil: Long = 0)
    private val health = java.util.concurrent.ConcurrentHashMap<String, FrontHealth>()

    /**
     * null: no front has this title. Throws when the chain itself failed.
     * `fresh` forces a new session (used to recover a row that failed in playback).
     * `preferred` is the audio language a front must carry to win at once.
     */
    suspend fun resolve(
        cfg: MappleConfig, type: String, tmdbId: Long, season: Int = 0, episode: Int = 0,
        preferred: String = "Telugu", fresh: Boolean = false,
    ): Resolved? {
        val mediaType = if (type == "tv" || type == "series") "tv" else "movie"
        val id = tmdbId.toString()
        val http = base.newBuilder().callTimeout(cfg.stepTimeoutMs, TimeUnit.MILLISECONDS).build()
        try {
            var s = session(cfg, http, mediaType, id, fresh)
            val token = try {
                mediaSession(cfg, http, s, mediaType, id, season, episode)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                // A reused session may have expired on their side: one fresh retry.
                if (now() - s.at < 2000) throw e
                android.util.Log.i("Chitram", "mapple: session stale (${e.message}), re-bootstrapping")
                s = session(cfg, http, mediaType, id, fresh = true)
                mediaSession(cfg, http, s, mediaType, id, season, episode)
            }
            return sweep(cfg, s, token, mediaType, id, season, episode, preferred)
        } catch (e: Exception) {
            // A failed chain says nothing good about the session: next resolve starts clean.
            if (e !is kotlinx.coroutines.CancellationException) session = null
            throw e
        }
    }

    private suspend fun session(cfg: MappleConfig, http: OkHttpClient, type: String, id: String, fresh: Boolean): Session = mutex.withLock {
        val cur = session
        val configured = hosts.candidates(NAME, cfg.bases)
        if (!fresh && cur != null && now() - cur.at < cfg.sessionTtlMs && cur.base in configured) return cur
        val (b, s) = hosts.heal(NAME, cfg.bases) { candidate -> bootstrap(cfg, http, candidate, type, id) }
        android.util.Log.i("Chitram", "mapple: session on $b")
        session = s
        s
    }

    private suspend fun bootstrap(cfg: MappleConfig, http: OkHttpClient, b: String, type: String, id: String): HostBook.Probe<Session> {
        val jar = Jar()
        val watchUrl = b + cfg.watchPath.replace("{type}", type).replace("{id}", id)
        val page = http.fetch(req(cfg, b, jar, watchUrl).get().build())
        jar.absorb(page.headers)
        if (page.code in 300..399) {
            val to = page.location()?.let { resolveAgainst(watchUrl, it) }?.let(::originOf)
            if (to != null && to != b) return HostBook.Probe.Moved(to)
        }
        if (page.code >= 400) return HostBook.Probe.Dead(StepException("mapple watch", page.code, "HTTP ${page.code} from $b"))
        val res = http.fetch(req(cfg, b, jar, b + cfg.sessionPath).header("accept", "application/json")
            .post(ByteArray(0).toRequestBody(null)).build())
        jar.absorb(res.headers)
        val token = obj(res.body)?.str("token")
            ?: return HostBook.Probe.Dead(StepException("mapple session", res.code, "no requestToken (watch ${page.code}, session ${res.code}: ${res.body.take(120)})"))
        return HostBook.Probe.Ok(Session(b, jar, token, now()))
    }

    private suspend fun mediaSession(cfg: MappleConfig, http: OkHttpClient, s: Session, type: String, id: String, season: Int, episode: Int): String {
        fun body(pow: JsonObject?) = buildJsonObject {
            put("mediaId", id); put("mediaType", type); put("tv_slug", ""); put("requestToken", s.requestToken)
            if (type == "tv" && season > 0) { put("season", season); put("episode", episode) }
            if (pow != null) put("pow", pow)
        }.toString()
        var init = postJson(cfg, http, s, s.base + cfg.mediaSessionPath, body(null))
        if (init?.get("requiresPow")?.let { (it as? JsonPrimitive)?.booleanOrNull } == true) {
            val pow = init["pow"] as? JsonObject ?: throw StepException("mapple pow", 200, "no pow object")
            val challenge = pow.str("challenge") ?: throw StepException("mapple pow", 200, "no challenge")
            val difficulty = (pow["difficulty"] as? JsonPrimitive)?.intOrNull ?: 18
            val t0 = now()
            // CPU work: off the main thread, and stops when the resolve is cancelled.
            val nonce = withContext(Dispatchers.Default) {
                val ctx = currentCoroutineContext()
                Pow.solve(challenge, difficulty, cfg.powMaxIterations) { ctx.isActive }
            } ?: throw StepException("mapple pow", 200, "unsolved at difficulty $difficulty")
            android.util.Log.i("Chitram", "mapple: pow d=$difficulty solved in ${now() - t0}ms")
            // The nonce is nested under pow{} and sent as a STRING (flat = re-challenged forever).
            val answer = buildJsonObject { put("challengeId", pow["challengeId"] ?: JsonPrimitive("")); put("nonce", nonce) }
            init = postJson(cfg, http, s, s.base + cfg.mediaSessionPath, body(answer))
        }
        return init?.str("token") ?: throw StepException("mapple media-session", 200, "no streamToken")
    }

    private class Hit(val front: String, val url: String, val master: Master)

    private fun noteFail(cfg: MappleConfig, front: String) {
        val h = health.getOrPut(front) { FrontHealth() }
        synchronized(h) {
            h.fails++
            val cool = (cfg.frontCooldownMs shl (h.fails - 1).coerceAtMost(4)).coerceAtMost(MAX_COOL_MS)
            h.coolUntil = now() + cool
        }
    }

    /** Fronts cooling down right now (test and log seam). */
    internal fun coolingFronts(): Set<String> = health.filter { it.value.coolUntil > now() }.keys

    /**
     * Fronts in order: the last one that worked first, then the configured list,
     * with cooling-down fronts moved to the end. Up to `frontParallelism` run at
     * once. A playable master that carries the preferred audio language wins at
     * once; one without it (s25 gave Salaar with no audio list, s12 gave five
     * languages, Telugu first) is held for `betterWaitMs` while the other fronts
     * finish, so the Telugu one is not lost to whichever answered first.
     */
    private suspend fun sweep(cfg: MappleConfig, s: Session, token: String, type: String, id: String, season: Int, episode: Int, preferred: String): Resolved? {
        val last = kv.get(KEY_FRONT)?.takeIf { it in cfg.fronts }
        val all = (listOfNotNull(last) + cfg.fronts).distinct()
        val t = now()
        val (ready, cooling) = all.partition { (health[it]?.coolUntil ?: 0L) <= t }
        val order = ready + cooling
        if (cooling.isNotEmpty()) android.util.Log.i("Chitram", "mapple: cooling fronts tried last: $cooling")
        val answered = java.util.concurrent.atomic.AtomicInteger()
        val failed = java.util.concurrent.atomic.AtomicInteger()
        val fallback = java.util.concurrent.atomic.AtomicReference<Hit?>(null)
        fun wanted(m: Master) = Hls.languages(m.audio).any { it.equals(preferred, ignoreCase = true) }
        val hit: Hit? = coroutineScope {
            val sem = Semaphore(cfg.frontParallelism.coerceAtLeast(1))
            val done = CompletableDeferred<Hit?>()
            val jobs = order.map { front ->
                launch {
                    sem.withPermit {
                        if (done.isCompleted) return@withPermit
                        val cap = cfg.frontTimeoutMs[front] ?: cfg.defaultFrontTimeoutMs
                        val r = try {
                            withTimeoutOrNull(cap) { tryFront(cfg, s, token, front, type, id, season, episode) }
                                ?: throw StepException("mapple front $front", 0, "timed out after ${cap}ms")
                        } catch (e: Exception) {
                            if (e is kotlinx.coroutines.CancellationException && !done.isCompleted) throw e
                            if (e !is kotlinx.coroutines.CancellationException) {
                                failed.incrementAndGet()
                                noteFail(cfg, front)
                                android.util.Log.i("Chitram", "mapple: front $front failed: ${e.message}")
                            }
                            return@withPermit
                        }
                        answered.incrementAndGet()
                        health.remove(front)
                        if (r !is FrontResult.Found) return@withPermit
                        val h = Hit(front, r.url, r.master)
                        if (wanted(r.master)) done.complete(h)
                        else if (fallback.compareAndSet(null, h)) {
                            android.util.Log.i("Chitram", "mapple: $front has it without $preferred audio, waiting ${cfg.betterWaitMs}ms for a better front")
                            launch { kotlinx.coroutines.delay(cfg.betterWaitMs); done.complete(fallback.get()) }
                        }
                    }
                }
            }
            launch { jobs.joinAll(); done.complete(fallback.get()) }
            val h = done.await()
            coroutineContext.job.children.forEach { it.cancel() }
            h
        }
        if (hit == null) {
            if (answered.get() == 0 && failed.get() > 0) throw StepException("mapple fronts", 0, "all ${failed.get()} fronts tried failed")
            android.util.Log.i("Chitram", "mapple: no front has $type/$id")
            return null
        }
        // Remember a front that carried the preferred language; a language-less one only if nothing better is known.
        if (wanted(hit.master) || kv.get(KEY_FRONT) == null) kv.put(KEY_FRONT, hit.front)
        android.util.Log.i("Chitram", "mapple: $type/$id on ${hit.front}, ${hit.master.audio.size} audio tracks")
        return Resolved(
            provider = NAME,
            label = if (hit.front == "mapple") "mapple" else "mapple · ${hit.front}",
            url = hit.url,
            headers = streamHeaders(cfg, s.base),
            segmentToken = null,
            audio = hit.master.audio,
            levels = hit.master.levels,
            codecs = hit.master.codecs,
        )
    }

    private sealed interface FrontResult {
        data object NotHere : FrontResult
        class Found(val url: String, val master: Master) : FrontResult
    }

    private suspend fun tryFront(cfg: MappleConfig, s: Session, token: String, front: String, type: String, id: String, season: Int, episode: Int): FrontResult {
        val http = base.newBuilder().callTimeout(cfg.frontTimeoutMs[front] ?: cfg.defaultFrontTimeoutMs, TimeUnit.MILLISECONDS).build()
        val data = buildJsonObject {
            put("mediaId", id); put("mediaType", type); put("tv_slug", ""); put("source", front)
            if (type == "tv" && season > 0) { put("season", season); put("episode", episode) }
        }
        // requestToken at the top level as well as the session's: without it the
        // answer is a 200 that resolves to playback-unavailable.
        val body = buildJsonObject { put("data", data); put("endpoint", cfg.encryptEndpoint); put("requestToken", s.requestToken) }.toString()
        val enc = postJson(cfg, http, s, s.base + cfg.encryptPath, body)
        val path = enc?.str("url") ?: return FrontResult.NotHere
        val signed = s.base + path + "&requestToken=" + enc(s.requestToken) + "&token=" + enc(token)
        val r = http.fetch(req(cfg, s.base, s.jar, signed).header("accept", "application/json").get().build())
        s.jar.absorb(r.headers)
        val out = obj(r.body)
        val streamUrl = (out?.get("data") as? JsonObject)?.str("stream_url").orEmpty()
        // SOURCE_BUSY / SOURCE_TIMEOUT / UPSTREAM_UNAVAILABLE: says nothing about the title.
        if (streamUrl.isEmpty() && (out?.get("retryable") as? JsonPrimitive)?.booleanOrNull == true) {
            throw StepException("mapple front $front", r.code, out.str("details") ?: out.str("failureKind") ?: "retryable")
        }
        if (streamUrl.isEmpty() || streamUrl.contains(cfg.unavailableMarker)) return FrontResult.NotHere
        // The master must answer with the site's headers and must not be empty.
        val mres = StreamInterceptor.client(streamBase, streamHeaders(cfg, s.base), null)
            .newBuilder().callTimeout(cfg.stepTimeoutMs, TimeUnit.MILLISECONDS).build()
            .fetch(Request.Builder().url(streamUrl).build())
        if (!mres.ok) throw StepException("mapple master $front", mres.code, "master HTTP ${mres.code}")
        val master = Hls.parse(mres.body, streamUrl)
        if (master.empty) return FrontResult.NotHere
        return FrontResult.Found(streamUrl, master)
    }

    private suspend fun postJson(cfg: MappleConfig, http: OkHttpClient, s: Session, url: String, json: String): JsonObject? {
        val r = http.fetch(req(cfg, s.base, s.jar, url).header("content-type", "application/json")
            .post(json.toRequestBody(JSON)).build())
        s.jar.absorb(r.headers)
        return obj(r.body)
    }

    private fun req(cfg: MappleConfig, b: String, jar: Jar, url: String): Request.Builder =
        Request.Builder().url(url)
            .header("User-Agent", cfg.userAgent)
            .header("Origin", b)
            .header("Referer", "$b/")
            .apply { jar.header()?.let { header("Cookie", it) } }

    companion object {
        const val NAME = "mapple"
        const val KEY_FRONT = "resolve.mapple.front"
        private const val MAX_COOL_MS = 10 * 60 * 1000L
        private val JSON = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        fun streamHeaders(cfg: MappleConfig, base: String) = mapOf("User-Agent" to cfg.userAgent, "Referer" to "$base/", "Origin" to base)

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        internal fun obj(text: String): JsonObject? = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
    }
}
