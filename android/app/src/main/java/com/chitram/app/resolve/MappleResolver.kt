package com.chitram.app.resolve

import com.chitram.app.data.KeyValue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
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
 * Self-recovery: the session host heals through [HostBook]; per-front outcomes
 * live in [FrontBook] (kept across launches): fronts that gave Telugu go first,
 * failing ones go last or are skipped to the tail for a self-ending window.
 *
 * Timing: one line per resolve, "mapple: timing total=... session=... media=...
 * pow=... fronts=... wait=...", so device time can be read from logcat.
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

    /** Per-front outcomes on the device; see [FrontBook]. */
    private val book = FrontBook(kv, now)

    /** What a race did: fronts started, and when the first non-preferred hit arrived (0 = none). */
    class RaceStats {
        val started = java.util.concurrent.atomic.AtomicInteger()
        val fallbackAt = java.util.concurrent.atomic.AtomicLong()
    }

    /**
     * Early return (mapple-speed-2, RRR on CPH2447: 11.1 s of the 19.8 s was the
     * wait behind a non-Telugu hit, and no Telugu front existed). With a [Later],
     * the first playable front is returned at once and the race keeps looking for
     * the preferred language in [scope], under the same betterWaitMaxMs cap.
     * [deliver] gets that row (its own key, so both rows stay) or null, once.
     * [handedOff] is set before resolve returns when a background search is live;
     * when it is false after resolve returns or throws, nothing more will come and
     * the caller completes its side with null. [deliver] must be idempotent
     * (a CompletableDeferred.complete).
     */
    class Later(val scope: CoroutineScope, val deliver: (Resolved?) -> Unit) {
        @Volatile var handedOff = false
    }

    /** Per-resolve phase times for the timing log line. */
    private class Timing(val t0: Long) {
        var session = 0L; var media = 0L; var pow = 0L; var fronts = 0L; var wait = 0L
        var started = 0; var total = 0; var parallel = 0; var skipped: List<String> = emptyList(); var on = "-"
    }

    /**
     * null: no front has this title. Throws when the chain itself failed.
     * `fresh` forces a new session (used to recover a row that failed in playback).
     * `preferred` is the audio language a front must carry to win at once.
     */
    suspend fun resolve(
        cfg: MappleConfig, type: String, tmdbId: Long, season: Int = 0, episode: Int = 0,
        preferred: String = "Telugu", fresh: Boolean = false,
        later: Later? = null,
    ): Resolved? {
        val mediaType = if (type == "tv" || type == "series") "tv" else "movie"
        val id = tmdbId.toString()
        val http = base.newBuilder().callTimeout(cfg.stepTimeoutMs, TimeUnit.MILLISECONDS).build()
        val tm = Timing(now())
        var outcome = "error"
        try {
            val (first, reused) = session(cfg, http, mediaType, id, fresh)
            var s = first
            tm.session = now() - tm.t0
            val m0 = now()
            var retryBoot = 0L
            val token = try {
                mediaSession(cfg, http, s, mediaType, id, season, episode, tm)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                // A reused session the site rejected (TTL is 5 h, the site can drop it
                // sooner): one fresh session, one retry. Only a token/session rejection
                // qualifies; a PoW or network failure is not the session's fault. A
                // session made in this call is not retried, so this cannot loop.
                if (!reused || (e as? StepException)?.step != STEP_REJECTED) throw e
                android.util.Log.i("Chitram", "mapple: session rejected (${e.message}), re-bootstrapping")
                val b0 = now()
                s = session(cfg, http, mediaType, id, fresh = true).first
                retryBoot = now() - b0
                tm.session += retryBoot
                mediaSession(cfg, http, s, mediaType, id, season, episode, tm)
            }
            tm.media = now() - m0 - retryBoot // a retry's bootstrap is counted under session
            return sweep(cfg, s, token, mediaType, id, season, episode, preferred, tm, later).also { outcome = if (it == null) "none" else "ok" }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) outcome = "cancelled"
            // A failed chain says nothing good about the session: next resolve starts clean.
            if (e !is kotlinx.coroutines.CancellationException) session = null
            throw e
        } finally {
            android.util.Log.i("Chitram", timingLine(tm, now() - tm.t0, outcome, "$mediaType/$id"))
        }
    }

    /** The session and whether it was reused (true) or made by this call. */
    private suspend fun session(cfg: MappleConfig, http: OkHttpClient, type: String, id: String, fresh: Boolean): Pair<Session, Boolean> = mutex.withLock {
        val cur = session
        val configured = hosts.candidates(NAME, cfg.bases)
        if (!fresh && cur != null && now() - cur.at < cfg.sessionTtlMs && cur.base in configured) return cur to true
        val (b, s) = hosts.heal(NAME, cfg.bases) { candidate -> bootstrap(cfg, http, candidate, type, id) }
        android.util.Log.i("Chitram", "mapple: session on $b")
        session = s
        s to false
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

    private suspend fun mediaSession(cfg: MappleConfig, http: OkHttpClient, s: Session, type: String, id: String, season: Int, episode: Int, tm: Timing): String {
        fun body(pow: JsonObject?) = buildJsonObject {
            put("mediaId", id); put("mediaType", type); put("tv_slug", ""); put("requestToken", s.requestToken)
            if (type == "tv" && season > 0) { put("season", season); put("episode", episode) }
            if (pow != null) put("pow", pow)
        }.toString()
        var init = postMedia(cfg, http, s, body(null))
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
            tm.pow += now() - t0
            android.util.Log.i("Chitram", "mapple: pow d=$difficulty solved in ${now() - t0}ms")
            // The nonce is nested under pow{} and sent as a STRING (flat = re-challenged forever).
            val answer = buildJsonObject { put("challengeId", pow["challengeId"] ?: JsonPrimitive("")); put("nonce", nonce) }
            init = postMedia(cfg, http, s, body(answer))
        }
        return init?.str("token") ?: throw StepException("mapple media-session", 200, "no streamToken")
    }

    private class Hit(val front: String, val url: String, val master: Master)

    /** media includes pow; fronts = race start to first hit (or to the end); wait = fallback hit to the end. */
    private fun timingLine(t: Timing, total: Long, outcome: String, what: String): String =
        "mapple: timing $what $outcome total=${total}ms session=${t.session}ms media=${t.media}ms pow=${t.pow}ms " +
            "fronts=${t.fronts}ms wait=${t.wait}ms tried=${t.started}/${t.total} parallel=${t.parallel} skipped=${t.skipped} on=${t.on}"

    /** Fronts tried last or skipped right now (test and log seam). */
    internal fun coolingFronts(): Set<String> = book.cooling()

    /**
     * Fronts in [FrontBook] order (Telugu fronts first, skipped ones at the tail).
     * Up to `frontParallelism` run at once. A playable master that carries the
     * preferred audio language wins at
     * once; one without it (s25 gave Salaar with no audio list, s12 gave five
     * languages, Telugu first) is held for `betterWaitMs` while the other fronts
     * finish, so the Telugu one is not lost to whichever answered first. With a
     * [Later] it is returned at once instead and the hold runs in the background:
     * a Telugu front found there arrives as a second row through [Later.deliver].
     */
    private suspend fun sweep(cfg: MappleConfig, s: Session, token: String, type: String, id: String, season: Int, episode: Int, preferred: String, tm: Timing, later: Later? = null): Resolved? {
        val plan = book.plan(cfg.fronts)
        val order = plan.order
        if (plan.last.isNotEmpty()) android.util.Log.i("Chitram", "mapple: failing fronts tried last: ${plan.last}")
        if (plan.skipped.isNotEmpty()) android.util.Log.i("Chitram", "mapple: fronts skipped to the tail: ${plan.skipped}")
        val answered = java.util.concurrent.atomic.AtomicInteger()
        val failed = java.util.concurrent.atomic.AtomicInteger()
        fun wanted(m: Master) = Hls.languages(m.audio).any { com.chitram.app.data.Ranking.sameLanguage(it, preferred) }
        val stats = RaceStats()
        val r0 = System.currentTimeMillis() // same clock as RaceStats.fallbackAt
        tm.total = order.size; tm.parallel = cfg.frontParallelism; tm.skipped = plan.skipped
        val hit: Hit? = try {
            raceFronts(
                order, cfg.frontParallelism, cfg.betterWaitMs, cfg.betterWaitMaxMs,
                wanted = { wanted(it.master) },
                onFallback = { h, waitMs ->
                    android.util.Log.i("Chitram", if (later != null) "mapple: ${h.front} has it without $preferred audio, playing it now; looking for $preferred for up to ${waitMs}ms in the background"
                        else "mapple: ${h.front} has it without $preferred audio, waiting up to ${waitMs}ms for a better front")
                },
                stats = stats,
                background = later?.scope,
                onBetter = { better ->
                    val ms = System.currentTimeMillis() - r0
                    if (better == null) {
                        if (later?.handedOff == true) android.util.Log.i("Chitram", "mapple: background $type/$id: no $preferred front after ${ms}ms, tried ${stats.started.get()}/${order.size}")
                        later?.deliver?.invoke(null)
                    } else {
                        nextStoredFront(kv.get(KEY_FRONT), better.front, true)?.let { kv.put(KEY_FRONT, it) }
                        android.util.Log.i("Chitram", "mapple: background $type/$id: $preferred on ${better.front} after ${ms}ms, ${better.master.audio.size} audio tracks, row added")
                        later?.deliver?.invoke(toResolved(cfg, s, better, key = "$NAME-${better.front}"))
                    }
                },
            ) { front ->
                val cap = cfg.frontTimeoutMs[front] ?: cfg.defaultFrontTimeoutMs
                val r = try {
                    withTimeoutOrNull(cap) { tryFront(cfg, s, token, front, type, id, season, episode) }
                        ?: throw StepException("mapple front $front", 0, "timed out after ${cap}ms")
                } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    failed.incrementAndGet()
                    book.failed(front, FrontBook.kindOf(e.message), cfg.frontCooldownMs)
                    android.util.Log.i("Chitram", "mapple: front $front failed: ${e.message}")
                    return@raceFronts null
                }
                answered.incrementAndGet()
                when (r) {
                    is FrontResult.Found -> book.found(front, wanted(r.master))
                    else -> book.notHere(front)
                }
                (r as? FrontResult.Found)?.let { Hit(front, it.url, it.master) }
            }
        } finally {
            val end = System.currentTimeMillis()
            val fb = stats.fallbackAt.get()
            tm.started = stats.started.get()
            tm.fronts = (if (fb > 0) fb else end) - r0
            tm.wait = if (fb > 0) end - fb else 0
        }
        if (hit == null) {
            if (answered.get() == 0 && failed.get() > 0) throw StepException("mapple fronts", 0, "all ${failed.get()} fronts tried failed")
            android.util.Log.i("Chitram", "mapple: no front has $type/$id")
            return null
        }
        // A non-preferred first hit with a live background race: the race goes on after this return.
        if (later != null && !wanted(hit.master)) later.handedOff = true
        // Remember a front that carried the preferred language; a language-less one only if nothing better is known.
        nextStoredFront(kv.get(KEY_FRONT), hit.front, wanted(hit.master))?.let { kv.put(KEY_FRONT, it) }
        tm.on = hit.front
        android.util.Log.i("Chitram", "mapple: $type/$id on ${hit.front}, ${hit.master.audio.size} audio tracks")
        return toResolved(cfg, s, hit, key = null)
    }

    /** `key` null keeps the row id "device-mapple"; a background row gets its own key so both rows stay. */
    private fun toResolved(cfg: MappleConfig, s: Session, hit: Hit, key: String?) = Resolved(
        provider = NAME,
        label = if (hit.front == "mapple") "mapple" else "mapple · ${hit.front}",
        url = hit.url,
        headers = streamHeaders(cfg, s.base),
        segmentToken = null,
        audio = hit.master.audio,
        levels = hit.master.levels,
        codecs = hit.master.codecs,
        key = key,
    )

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
            // failureKind first: FrontBook reads the kind (SOURCE_COOLDOWN, SCRAPE_FAILED) from this text.
            throw StepException("mapple front $front", r.code, listOfNotNull(out.str("failureKind"), out.str("details")).joinToString(": ").ifEmpty { "retryable" })
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

    /**
     * POST to media-session. A 401/403, or an error naming the token or session
     * (the old path's 401 "Invalid request token"), throws [STEP_REJECTED].
     */
    private suspend fun postMedia(cfg: MappleConfig, http: OkHttpClient, s: Session, json: String): JsonObject? {
        val r = http.fetch(req(cfg, s.base, s.jar, s.base + cfg.mediaSessionPath).header("content-type", "application/json")
            .post(json.toRequestBody(JSON)).build())
        s.jar.absorb(r.headers)
        val o = obj(r.body)
        val err = o?.str("error").orEmpty()
        if (r.code == 401 || r.code == 403 || (o?.str("token") == null && (err.contains("token", true) || err.contains("session", true))))
            throw StepException(STEP_REJECTED, r.code, "HTTP ${r.code} ${err.ifEmpty { r.body.take(80) }}")
        return o
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
        private const val STEP_REJECTED = "mapple session rejected"
        private val JSON = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true; isLenient = true }

        /**
         * The front to remember for next time: only one that carried the preferred
         * audio. A language-less hit (Kubera's Hindi-only "mapple" front) must not
         * become the front tried first. null: keep what is stored.
         */
        internal fun nextStoredFront(current: String?, hitFront: String, hitWanted: Boolean): String? =
            if (hitWanted) hitFront else current

        /**
         * Runs `attempt` over `order`, `parallelism` at a time. A result `wanted`
         * accepts wins at once. The first other result is held as a fallback while
         * the remaining fronts run; it is returned when every front has settled, or
         * after maxOf(betterWaitMs, betterWaitMaxMs) since it arrived, whichever is
         * first. A fixed betterWaitMs cut-off accepted Kubera's Hindi-only front
         * before the Telugu front (s12, 9th of 13) had started.
         */
        internal suspend fun <T : Any> raceFronts(
            order: List<String>, parallelism: Int, betterWaitMs: Long, betterWaitMaxMs: Long,
            wanted: (T) -> Boolean,
            onFallback: (T, Long) -> Unit = { _, _ -> },
            stats: RaceStats? = null,
            /**
             * Early return (mapple-speed-2): the first hit of any kind is returned at
             * once and the race keeps running in this scope for a `wanted` one, under
             * the same wait cap. null = the old blocking race.
             */
            background: CoroutineScope? = null,
            /**
             * With [background]: called exactly once when the background race ends:
             * the `wanted` hit found after an early non-wanted return, else null
             * (none found, nothing left to look for, or cancelled).
             */
            onBetter: (T?) -> Unit = {},
            attempt: suspend (String) -> T?,
        ): T? {
            if (background == null) return coroutineScope {
                val done = CompletableDeferred<T?>()
                startFronts(this, order, parallelism, maxOf(betterWaitMs, betterWaitMaxMs), wanted, onFallback, stats, null, done, attempt)
                val h = done.await()
                coroutineContext.job.children.forEach { it.cancel() }
                h
            }
            val first = CompletableDeferred<T?>()
            val done = CompletableDeferred<T?>()
            val told = java.util.concurrent.atomic.AtomicBoolean(false)
            val best = java.util.concurrent.atomic.AtomicReference<T?>(null)
            val race = background.launch {
                coroutineScope {
                    startFronts(this, order, parallelism, maxOf(betterWaitMs, betterWaitMaxMs), wanted, onFallback, stats, first, done, attempt)
                    val end = done.await()
                    // Only a wanted hit that came after the early return is "better".
                    // `first` is always complete here: it is set before `done` on every path.
                    if (end != null && wanted(end) && first.await() !== end) best.set(end)
                    coroutineContext.job.children.forEach { it.cancel() }
                }
            }
            race.invokeOnCompletion {
                first.complete(null)
                if (told.compareAndSet(false, true)) onBetter(best.get())
            }
            val f = try { first.await() } catch (e: kotlinx.coroutines.CancellationException) { race.cancel(); throw e }
            // A wanted first hit, or no hit at all: nothing more to look for.
            if (f == null || wanted(f)) race.cancel()
            return f
        }

        /**
         * The race itself, in [scope]. `first` (optional) gets the first hit of any
         * kind, or null when every front settled without one; `done` gets the
         * wanted hit, or the fallback after `waitMs` / when every front settled.
         */
        private fun <T : Any> startFronts(
            scope: CoroutineScope, order: List<String>, parallelism: Int, waitMs: Long,
            wanted: (T) -> Boolean, onFallback: (T, Long) -> Unit, stats: RaceStats?,
            first: CompletableDeferred<T?>?, done: CompletableDeferred<T?>,
            attempt: suspend (String) -> T?,
        ) {
            val sem = Semaphore(parallelism.coerceAtLeast(1))
            val fallback = java.util.concurrent.atomic.AtomicReference<T?>(null)
            // One loop takes the slots in plan order, so the FrontBook order holds on a
            // multi-threaded dispatcher too (13 coroutines racing for permits did not).
            scope.launch {
                val jobs = ArrayList<kotlinx.coroutines.Job>()
                for (front in order) {
                    sem.acquire()
                    if (done.isCompleted) { sem.release(); break }
                    stats?.started?.incrementAndGet()
                    jobs += scope.launch {
                        try {
                            val r = attempt(front) ?: return@launch
                            first?.complete(r)
                            if (wanted(r)) done.complete(r)
                            else if (fallback.compareAndSet(null, r)) {
                                stats?.fallbackAt?.set(System.currentTimeMillis())
                                onFallback(r, waitMs)
                                // In the outer scope: a child of this front's job would hold joinAll open.
                                scope.launch { kotlinx.coroutines.delay(waitMs); done.complete(fallback.get()) }
                            }
                        } finally { sem.release() }
                    }
                }
                jobs.joinAll(); first?.complete(null); done.complete(fallback.get())
            }
        }

        fun streamHeaders(cfg: MappleConfig, base: String) = mapOf("User-Agent" to cfg.userAgent, "Referer" to "$base/", "Origin" to base)

        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        internal fun obj(text: String): JsonObject? = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
    }
}
