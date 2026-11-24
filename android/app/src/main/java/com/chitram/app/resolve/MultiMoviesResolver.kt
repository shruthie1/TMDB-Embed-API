package com.chitram.app.resolve

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * MultiMovies (VidBolt), resolved on the device (port of providers/multimovies.js).
 * Used when the VM is down or its multimovies row failed: one JSON call gives the
 * HLS master, whose EXT-X-MEDIA renditions carry the languages. Since 1.2.50 a
 * sacdn `/dash/` source is a dash-direct row: its signed index.mpd, played with
 * media3 DASH (StreamInterceptor signs the segments); `/hls/` sources keep the
 * bridge master.
 *
 * Not ported: the server's dead-audio-rendition probe and its "segments disguised
 * as images" probe. A row that cannot play fails in the player and the start
 * moves on; no language tag is dropped.
 */
class MultiMoviesResolver(
    client: OkHttpClient,
    origin: String = ORIGIN,
    /** Per-master cap (server MASTER_TIMEOUT_MS): a slow master drops only its own row. */
    private val masterTimeoutMs: Long = MASTER_TIMEOUT_MS,
    /** Remembers the VidBolt host that last answered (7 days); a throwaway book when null. */
    hosts: HostBook? = null,
    /**
     * VidBolt hosts and resolvePath from resolve-config: the VM puts a verified
     * heal first in `bases`, so the device needs no title-page or scraper trail.
     * [origin] alone by default.
     */
    private val config: () -> MultiMoviesConfig = { MultiMoviesConfig(bases = listOf(origin)) },
) {
    private val hosts = hosts ?: HostBook(com.chitram.app.data.MemoryKeyValue())
    /** Tried after the config hosts, so a config list without it never removes it (review I2). */
    private val builtIn = listOf(origin)

    /**
     * 8 s connect (review I1): covers the measured 7.6 s connect to a live
     * Cloudflare host. The resolver has no proxy fallback, so no 3 s here.
     */
    internal val http = client.newBuilder()
        .connectTimeout(com.chitram.app.data.Api.DEVICE_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(API_TIMEOUT_MS, TimeUnit.MILLISECONDS).build()

    /** The first row of [resolveAll], or null when there is none. Throws when the API call failed. */
    suspend fun resolve(type: String, tmdbId: Long, season: Int, episode: Int): Resolved? =
        resolveAll(type, tmdbId, season, episode).firstOrNull()

    /**
     * One row per VidBolt HLS master from EVERY VidBolt server (server twin:
     * providers/multimovies.js). The plain /api/resolve returns whichever server
     * VidBolt picks (RRR: `luna`, one unlabelled 720p row, while `callisto` had
     * the two Telugu masters, 2026-11-21), so each server is also asked with
     * `only=<id>` in parallel. Server ids come from the embed page's "servers"
     * JSON (cached [SERVER_LIST_TTL_MS]), [FALLBACK_SERVERS] until it is read.
     * Each call is capped at [RESOLVE_STEP_MS]; the ask phase ends when all have
     * answered, or once the plain resolve has answered and [SETTLE_MS] has
     * passed. Masters start as each answer lands, each capped at
     * [masterTimeoutMs] and by what is left of [budgetMs]; a dead or slow one
     * drops only its row. Rows keep ask order (plain first, then servers),
     * one per master ([masterKey]). Each source's own `language` labels a lone
     * generic rendition; "Original" labels nothing. Each sacdn source's
     * index.mpd audio `lang` then decides Telugu and corrects tam/kan/hin/mal
     * ([mpdLanguagePlan]); when an MPD fails the title falls back to "last
     * listed Telugu wins" ([teluguClaimWinner]).
     * `originalLang` is accepted for the caller and not used: "Original" is
     * never the TMDB language (server twin, 2026-11-22). Throws when no ask got a 2xx answer.
     */
    @Suppress("UNUSED_PARAMETER")
    suspend fun resolveAll(type: String, tmdbId: Long, season: Int, episode: Int, originalLang: String? = null, budgetMs: Long = Long.MAX_VALUE): List<Resolved> {
        val t0 = System.currentTimeMillis()
        val cfg = config()
        fun left() = if (budgetMs == Long.MAX_VALUE) Long.MAX_VALUE else budgetMs - (System.currentTimeMillis() - t0)
        // Host probe = the resolve itself (no extra request). The host moves only
        // when it is dead (review I3): refused/reset, DNS failure, a 2xx that is not
        // JSON (parked page) or a 5xx on the plain resolve. A timeout, 403 or 429
        // fails the call and keeps the host. A 2xx with no source is the title, not
        // the host: the next host is not asked (VidBolt 429s after ~16 calls in 15 s)
        // and the 7-day pin is not refreshed.
        val (_, out) = hosts.heal(NAME, cfg.bases, builtIn) { base ->
            if (left() <= BUDGET_MARGIN_MS) return@heal HostBook.Probe.Dead(StepException("multimovies resolve", 0, "budget spent before $base"))
            try {
                val rows = resolveAt(base, cfg.resolvePath, type, tmdbId, season, episode, left())
                HostBook.Probe.Ok(Result.success(rows), remember = rows.isNotEmpty() || hosts.healed(NAME) != base)
            } catch (x: HostDown) {
                android.util.Log.i("Chitram", "[multimovies] host $base dead (${x.error.message}): next host")
                HostBook.Probe.Dead(x.error)
            } catch (x: StepException) {
                android.util.Log.i("Chitram", "[multimovies] host $base kept (code ${x.code}): call failed, host not moved")
                HostBook.Probe.Ok(Result.failure(x), remember = false)
            }
        }
        return out.getOrThrow()
    }

    private suspend fun resolveAt(origin: String, resolvePath: String, type: String, tmdbId: Long, season: Int, episode: Int, budgetMs: Long): List<Resolved> = coroutineScope {
        val t0 = System.currentTimeMillis()
        val tv = type == "tv" || type == "series"
        val s = season.coerceAtLeast(1)
        val e = episode.coerceAtLeast(1)
        val path = if (tv) "tv/$tmdbId/$s/$e" else "movie/$tmdbId"
        val api = if (tv) "$origin$resolvePath?type=tv&id=$tmdbId&season=$s&episode=$e" else "$origin$resolvePath?type=movie&id=$tmdbId"
        val referer = "$origin/$path"
        fun left() = if (budgetMs == Long.MAX_VALUE) Long.MAX_VALUE else budgetMs - (System.currentTimeMillis() - t0) - BUDGET_MARGIN_MS
        val headers = streamHeaders(origin)

        val throttled = System.currentTimeMillis() < throttledUntil
        val listed = if (throttled) emptyList() else knownServers()
        val servers = (listed ?: FALLBACK_SERVERS).toMutableList()
        // Servers asked this call; cooled ones are skipped (server twin: per-server cooldown).
        val asked = mutableListOf<String>()
        val cooled = mutableListOf<String>()
        if (throttled) android.util.Log.i("Chitram", "[multimovies] vidbolt throttled (429): plain resolve only for $tmdbId")

        val events = Channel<Any>(Channel.UNLIMITED)
        val askJobs = mutableListOf<kotlinx.coroutines.Job>()
        // Arrival order: teluguClaimWinner reads the first answer that lists two Telugu sources.
        val answers = LinkedHashMap<String, Answer>()
        val masters = LinkedHashMap<String, kotlinx.coroutines.Deferred<Resolved?>>()
        var pending = 0

        fun ask(label: String, server: String?) {
            pending++
            askJobs += launch {
                val url = if (server == null) api else "$api&only=${java.net.URLEncoder.encode(server, "UTF-8")}"
                val step = minOf(RESOLVE_STEP_MS, left())
                val a = if (step <= 0) Answer(label, timedOut = true) else try {
                    withTimeoutOrNull(step) {
                        val r = http.fetch(Request.Builder().url(url).header("User-Agent", UA).header("Referer", referer).build())
                        if (!r.ok) return@withTimeoutOrNull Answer(label, code = r.code)
                        val body = MappleResolver.obj(r.body) ?: return@withTimeoutOrNull Answer(label, code = r.code, error = NOT_JSON)
                        val stream = body["stream"] as? JsonObject
                        val sources = (stream?.get("sources") as? JsonArray).orEmpty()
                            .mapNotNull { it as? JsonObject }
                            .filter { str(it, "kind") == "hls" }
                            .mapNotNull { o -> str(o, "url")?.let { it to str(o, "language") } }
                        Answer(label, ok = true, code = r.code, server = stream?.let { str(it, "server") }, sources = sources)
                    } ?: Answer(label, timedOut = true)
                } catch (x: Exception) {
                    if (x is kotlinx.coroutines.CancellationException) throw x
                    // Refused, reset, DNS: the host is gone. A socket/call timeout is not.
                    Answer(label, error = x.message ?: x.javaClass.simpleName, dead = x !is java.io.InterruptedIOException)
                }
                events.trySend(a)
            }
        }

        // Each answer's sources (url, raw language) in arrival order, complete once the ask phase ends.
        val listedSources = kotlinx.coroutines.CompletableDeferred<List<List<Pair<String, String?>>>>()
        // index.mpd per sacdn source, started as its answer lands (server twin fetchMpd).
        val mpds = LinkedHashMap<String, kotlinx.coroutines.Deferred<MpdResult>>()
        // The title's language plan, complete after the ask phase plus at most masterTimeoutMs (the MPD GETs).
        val langPlan = kotlinx.coroutines.CompletableDeferred<LangPlan>()

        // One GET per MPD: the language evidence AND, for a dash-direct row, its liveness
        // (200 with a Representation). Capped like a master: the MPD is now the row's master.
        fun mpdFetch(mpdUrl: String) = async {
            val cap = minOf(masterTimeoutMs, left())
            if (cap <= 0) return@async MpdResult(false, error = "budget spent")
            try {
                withTimeoutOrNull(cap) {
                    val r = http.fetch(Request.Builder().url(mpdUrl).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
                    when {
                        !r.ok -> MpdResult(false, error = "HTTP ${r.code}")
                        !r.body.contains("<MPD") -> MpdResult(false, error = "not an MPD")
                        else -> mpdInfo(r.body)
                    }
                } ?: MpdResult(false, error = "no answer in ${cap}ms")
            } catch (x: Exception) {
                if (x is kotlinx.coroutines.CancellationException) throw x
                MpdResult(false, error = x.message ?: x.javaClass.simpleName)
            }
        }

        fun master(url: String, raw: String?) = async {
            val cap = minOf(masterTimeoutMs, left())
            if (cap <= 0) return@async null
            val m = withTimeoutOrNull(cap) {
                try {
                    val reply = http.fetch(Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build())
                    if (reply.ok) Hls.parse(reply.body, url) else null
                } catch (x: Exception) {
                    if (x is kotlinx.coroutines.CancellationException) throw x
                    null
                }
            }
            if (m == null || m.levels.isEmpty()) return@async null
            // "Original" labels nothing (sourceLanguage). The title's plan
            // (MPD tags, or last-listed-wins when an MPD failed) decides the
            // language stamped on a lone generic rendition.
            val d = langPlan.await().sources[masterKey(url)]
            val lang = if (d != null) d.language else sourceLanguage(raw)
            Resolved(
                provider = "multimovies",
                label = "MultiMovies",
                url = url,
                headers = headers,
                segmentToken = null,
                audio = withSourceLanguage(m.audio, lang),
                levels = m.levels.sortedByDescending { it.height },
                codecs = m.codecs,
                // Stable id from the master (review I4): a re-resolve in another order keeps each row's language.
                key = "multimovies-${masterKey(url)}",
            )
        }

        // A sacdn /dash/ source plays its signed index.mpd directly (media3 DASH): the
        // bridge master is not fetched (dash-hls-bridge out of quota, CF 1027, 2026-11-22).
        // Its row lives when the MPD answered 200 with a Representation.
        fun dashRow(k: String, mpdUrl: String, raw: String?, mpd: kotlinx.coroutines.Deferred<MpdResult>) = async {
            val m = mpd.await()
            if (!m.ok) {
                android.util.Log.i("Chitram", "[multimovies] dash-direct $tmdbId $k dropped: ${m.error}")
                return@async null
            }
            val d = langPlan.await().sources[k]
            val lang = if (d != null) d.language else sourceLanguage(raw)
            Resolved(
                provider = "multimovies",
                label = "MultiMovies",
                url = mpdUrl,
                headers = headers,
                segmentToken = null,
                // One audio AdaptationSet, named like the bridge's lone "Audio"
                // rendition, so the plan's language is stamped the same way.
                audio = withSourceLanguage(listOf(AudioTrack(null, "Audio", true)), lang),
                levels = m.levels.sortedByDescending { it.height },
                codecs = m.codecs,
                key = "multimovies-$k",
                dash = true,
            )
        }

        ask(DEFAULT, null)
        fun askServer(id: String) {
            if (cooling(id)) { cooled += id; return }
            asked += id
            ask(id, id)
        }
        servers.toList().forEach { askServer(it) }
        if (listed == null) {
            pending++
            askJobs += launch {
                val ids = try {
                    withTimeoutOrNull(minOf(RESOLVE_STEP_MS, left()).coerceAtLeast(1)) {
                        val r = http.fetch(Request.Builder().url(referer).header("User-Agent", UA).header("Referer", "$origin/").build())
                        if (r.ok) parseServerIds(r.body) else null
                    }
                } catch (x: Exception) {
                    if (x is kotlinx.coroutines.CancellationException) throw x
                    null
                }
                events.trySend(EmbedIds(ids))
            }
        }

        // Ask phase. Only this loop touches servers / answers / masters.
        var why = "all answered"
        while (pending > 0) {
            val elapsed = System.currentTimeMillis() - t0
            val stopAt = if (answers.containsKey(DEFAULT)) minOf(SETTLE_MS, RESOLVE_STEP_MS) else RESOLVE_STEP_MS
            if (elapsed >= stopAt) { why = if (stopAt == RESOLVE_STEP_MS) "step cap" else "settled"; break }
            val ev = withTimeoutOrNull(stopAt - elapsed) { events.receive() } ?: continue
            pending--
            when (ev) {
                is Answer -> {
                    answers[ev.label] = ev
                    if (ev.code == 429) throttledUntil = System.currentTimeMillis() + THROTTLE_COOLDOWN_MS
                    val named = ev.server
                    if (!throttled && ev.ok && named != null && named !in servers) { servers += named; askServer(named) }
                    for ((url, lang) in ev.sources) masterKey(url).let { k ->
                        if (k !in masters) {
                            val mpdUrl = mpdUrlOf(url)
                            if (mpdUrl != null) {
                                val f = mpdFetch(mpdUrl)
                                mpds[k] = f
                                masters[k] = dashRow(k, mpdUrl, lang, f)
                            } else masters[k] = master(url, lang)
                        }
                    }
                }
                is EmbedIds -> {
                    val ids = ev.ids
                    if (ids == null) {
                        android.util.Log.i("Chitram", "[multimovies] server list unreadable, using ${servers.joinToString(",")}")
                    } else {
                        serverList = ids to System.currentTimeMillis()
                        ids.filter { it !in servers }.forEach { servers += it; askServer(it) }
                    }
                }
            }
        }
        askJobs.forEach { it.cancel() }
        events.close()
        listedSources.complete(answers.values.filter { it.ok }.map { it.sources })

        // A 429 is VidBolt limiting our whole IP, not this server: the streak is left as is.
        asked.forEach { if (answers[it]?.code == 429) releaseProbe(it) else recordServer(it, answers[it]?.ok == true) }
        val labels = listOf(DEFAULT) + asked
        val summary = labels.joinToString(" ") { l ->
            val a = answers[l]
            when {
                a == null -> "$l=cut"
                a.timedOut -> "$l=timeout"
                !a.ok -> "$l=error(${a.code.takeIf { it > 0 }?.let { "HTTP $it" } ?: a.error})"
                else -> "$l=${a.sources.size}" + if (l == DEFAULT && a.server != null) "(${a.server})" else ""
            }
        }
        android.util.Log.i("Chitram", "[multimovies] servers for $tmdbId after ${System.currentTimeMillis() - t0}ms ($why): $summary" + if (cooled.isEmpty()) "" else " cooled=${cooled.joinToString(",")}")

        if (masters.isEmpty()) {
            val def = answers[DEFAULT]
            // Empty is trusted only when VidBolt said so: the plain resolve (which
            // walks every server) or every listed server answered 2xx.
            if (def?.ok == true || (asked.isNotEmpty() && asked.all { answers[it]?.ok == true })) {
                android.util.Log.i("Chitram", "[multimovies] no hls source for $tmdbId")
                return@coroutineScope emptyList()
            }
            val err = StepException("multimovies resolve", def?.code ?: 0, summary)
            val dead = def != null && !def.ok && !def.timedOut && (def.dead || def.code >= 500 || def.error == NOT_JSON)
            throw if (dead) HostDown(err) else err
        }

        val lists = listedSources.await()
        val plan = mpdLanguagePlan(lists, mpds.mapValues { it.value.await() })
        if (plan.fallback) {
            android.util.Log.i("Chitram", "[multimovies] mpd-lang fallback for $tmdbId: ${plan.why} - last listed Telugu wins")
            val winner = teluguClaimWinner(lists)
            plan.sources.filterValues { it.drop }.keys.forEach { k ->
                android.util.Log.i("Chitram", "[multimovies] telugu-claim dropped for $tmdbId: $k listed Telugu, " +
                    if (!winner.isNullOrEmpty()) "kept $winner (listed later)" else "claims never listed together - none kept")
            }
        } else {
            plan.sources.forEach { (k, d) ->
                if (d.language != d.listed || d.drop) android.util.Log.i("Chitram", "[multimovies] mpd-lang fix for $tmdbId: $k listed ${d.listed ?: "-"}, mpd ${d.mpd ?: "-"} -> ${if (d.drop) "unverified" else d.language}")
            }
        }
        android.util.Log.i("Chitram", plan.line(tmdbId.toString()))
        langPlan.complete(plan)
        val done = masters.mapValues { it.value.await() }
        val seen = HashSet<String>()
        val rows = labels.flatMap { l -> answers[l]?.sources.orEmpty() }
            .mapNotNull { (url, _) -> masterKey(url).takeIf { seen.add(it) }?.let { done[it] } }
        android.util.Log.i("Chitram", "[multimovies] ${rows.size} of ${masters.size} master(s) for $tmdbId in ${System.currentTimeMillis() - t0}ms")
        android.util.Log.i("Chitram", "[multimovies] dash-direct $tmdbId sources=${rows.count { it.dash }} bridge=${rows.count { !it.dash && unwrap(it.url) != it.url }}")
        // 1.2.67: a partial answer (throttled, a server cut/timed out/failed, a master dropped) is
        // marked incomplete so the cache keeps it 5 min, not 30 (server twin multimovies.js:811-823).
        val short = labels.filter { answers[it]?.ok != true }
        val dropped = done.values.count { it == null }
        if (throttled || short.isNotEmpty() || dropped > 0) {
            android.util.Log.i("Chitram", "[multimovies] partial for $tmdbId:${if (throttled) " throttled" else ""}${if (short.isEmpty()) "" else " unheard=${short.joinToString(",")}"}${if (dropped > 0) " dropped=$dropped" else ""}")
            return@coroutineScope rows.map { it.copy(incomplete = true) }
        }
        rows
    }

    private class Answer(
        val label: String,
        val ok: Boolean = false,
        val timedOut: Boolean = false,
        val code: Int = 0,
        val error: String? = null,
        val server: String? = null,
        val sources: List<Pair<String, String?>> = emptyList(),
        /** The fetch threw a non-timeout error (refused, reset, DNS). */
        val dead: Boolean = false,
    )
    private class EmbedIds(val ids: List<String>?)
    /** The plain resolve says the host itself is gone: [HostBook] tries the next host. */
    private class HostDown(val error: StepException) : Exception(error.message)

    companion object {
        const val ORIGIN = "https://vidbolt.xyz"
        /** HostBook name; the same key the backend heals under. */
        const val NAME = "multimovies"
        const val UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
        private const val API_TIMEOUT_MS = 10_000L
        const val MASTER_TIMEOUT_MS = 8_000L
        /** Cap on each /api/resolve and embed-page call (server resolveStepMs). */
        const val RESOLVE_STEP_MS = 5_000L
        /** After the plain resolve answers, stop waiting for slower servers once this much has passed (server settleMs). */
        const val SETTLE_MS = 2_000L
        /** After an HTTP 429 from VidBolt, only the plain resolve runs for this long (about 16 calls in ~15 s gave 429, 2026-11-21). */
        const val THROTTLE_COOLDOWN_MS = 60_000L
        private const val DEFAULT = "default"
        private const val NOT_JSON = "not JSON"
        /** vidbolt.xyz/movie/579974 embed page "servers", 2026-11-21. */
        val FALLBACK_SERVERS = listOf("orion", "callisto", "luna", "vega", "quantum", "quasar")
        const val SERVER_LIST_TTL_MS = 6 * 60 * 60 * 1000L

        /** Last server list read from an embed page, with the time it was read. */
        @Volatile private var serverList: Pair<List<String>, Long>? = null
        @Volatile private var throttledUntil = 0L
        internal fun knownServers(): List<String>? = serverList?.takeIf { System.currentTimeMillis() - it.second < SERVER_LIST_TTL_MS }?.first
        /** Tests only: forget the cached server list and any 429 cooldown. */
        internal fun resetServerState() { serverList = null; throttledUntil = 0L; synchronized(health) { health.clear() } }

        /**
         * Per-server cooldown (owner ruling 2026-11-21, server twin in providers/multimovies.js):
         * [COOLDOWN_STREAK] asks in a row with no 2xx answer (cut, timeout, error; a 429 leaves the streak as is), across
         * titles, and the server is not asked for [COOLDOWN_MS]. After that one ask probes it:
         * 2xx clears the streak, anything else starts another hour. callisto (the Telugu
         * server) is never cooled.
         */
        const val COOLDOWN_STREAK = 3
        const val COOLDOWN_MS = 60 * 60 * 1000L
        private val NEVER_COOLED = setOf("callisto")
        internal class Health(var streak: Int = 0, var until: Long = 0L, var probing: Boolean = false)
        private val health = HashMap<String, Health>()

        /** True when [id] must not be asked now; claims the single probe once the hour is over. */
        internal fun cooling(id: String): Boolean = synchronized(health) {
            if (id in NEVER_COOLED) return false
            val h = health.getOrPut(id) { Health() }
            if (h.streak < COOLDOWN_STREAK) return false
            if (System.currentTimeMillis() < h.until || h.probing) return true
            h.probing = true
            android.util.Log.i("Chitram", "[multimovies] server-cooldown probe $id streak=${h.streak}")
            false
        }

        /** A 429 answer: streak and hour unchanged, only the probe claim is released. */
        internal fun releaseProbe(id: String) = synchronized(health) { health[id]?.probing = false }

        internal fun recordServer(id: String, ok: Boolean) = synchronized(health) {
            val h = health.getOrPut(id) { Health() }
            h.probing = false
            if (ok) {
                if (h.streak >= COOLDOWN_STREAK) android.util.Log.i("Chitram", "multimovies: server-cooldown $id off streak=0")
                h.streak = 0; h.until = 0L
            } else {
                h.streak += 1
                if (h.streak >= COOLDOWN_STREAK && id !in NEVER_COOLED) {
                    h.until = System.currentTimeMillis() + COOLDOWN_MS
                    android.util.Log.i("Chitram", "multimovies: server-cooldown $id on streak=${h.streak}")
                }
            }
        }

        /** Tests only: a copy of one server's health, and a way to end its hour early. */
        internal fun serverHealth(id: String): Health = synchronized(health) { health[id]?.let { Health(it.streak, it.until, it.probing) } ?: Health() }
        internal fun endCooldown(id: String) = synchronized(health) { health[id]?.until = 0L }

        /** Server ids from the embed page's config JSON (`"servers":[{"id":"orion",...}]`), or null (server parseServerIds). */
        internal fun parseServerIds(html: String?): List<String>? {
            val m = Regex(""""servers"\s*:\s*(\[[^\]]*])""").find(html ?: return null) ?: return null
            val ids = Regex(""""id"\s*:\s*"([^"]*)""").findAll(m.groupValues[1]).map { it.groupValues[1] }
                .filter { Regex("^[a-z0-9_-]{1,32}$", RegexOption.IGNORE_CASE).matches(it) }.distinct().toList()
            return ids.ifEmpty { null }
        }
        /** Left of the caller's budget after the masters, so the outer budget never fires first. */
        private const val BUDGET_MARGIN_MS = 250L
        private val SACDN_ID = Regex("""/(\d{10,})_""")

        /** A url's inner target: `?url=` wrappers (m3u8-proxy, dash-hls-bridge) decoded, up to 3 deep. */
        internal fun unwrap(url: String): String {
            var u = url
            repeat(3) {
                val inner = u.toHttpUrlOrNull()?.queryParameter("url")?.takeIf { it.startsWith("http") } ?: return u
                u = inner
            }
            return u
        }

        /**
         * Stable id for one master across re-resolves: the sacdn encode id when
         * the url names one, else a hash of the inner host and path (the query
         * holds rotating signatures and keys).
         */
        internal fun masterKey(url: String): String {
            val inner = unwrap(url)
            SACDN_ID.find(inner)?.let { return it.groupValues[1] }
            val h = inner.toHttpUrlOrNull()
            val stem = if (h != null) h.host + h.encodedPath else inner.substringBefore('?')
            val d = java.security.MessageDigest.getInstance("SHA-1").digest(stem.toByteArray())
            return d.take(5).joinToString("") { "%02x".format(it) }
        }
        fun streamHeaders(origin: String) = mapOf("User-Agent" to UA, "Referer" to "$origin/", "Origin" to origin)
        private fun str(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

        /** A rendition NAME that says nothing about language (server GENERIC_AUDIO_NAME). */
        private val GENERIC_AUDIO_NAME = Regex("""^(audio|audio\s*\d+|track\s*\d*|default|main|aac|stereo|sound)$""", RegexOption.IGNORE_CASE)
        private val NO_LANGUAGE_CODE = Regex("^(und|unk|mul|zxx)$", RegexOption.IGNORE_CASE)

        /** "[4] Telugu", "1. English", "Hindi (Original)" -> "Telugu", "English", "Hindi" (server cleanName). */
        internal fun cleanName(name: String?): String =
            (name ?: "").replace(Regex("""^\s*(\[\d+]|\d+[.)])\s*"""), "").replace(Regex("""\s*\(.*\)\s*$"""), "").trim()

        private const val TELUGU = "Telugu"

        /**
         * Server mpdTimeoutMs, kept for reference. Since 1.2.50 the device caps each
         * index.mpd GET at the master cap instead: the MPD is a dash-direct row's
         * liveness check, so a slow-but-alive MPD must not drop the row.
         */
        const val MPD_TIMEOUT_MS = 2_500L
        private const val MPD_HOST = "sacdn.hakunaymatata.com"
        private val SIGNED = listOf("Policy", "Signature", "Key-Pair-Id")
        /**
         * MPD audio `lang` that counts as evidence (server MPD_EVIDENCE). Against
         * speech ID on 13 titles (2026-11-22): tel 6 of 6, tam/kan/hin 4 of 4;
         * `eng` 0 of 1 (Vikram's Tamil) and `und` carry no evidence.
         */
        private val MPD_EVIDENCE = mapOf("tel" to TELUGU, "te" to TELUGU, "tam" to "Tamil", "ta" to "Tamil",
            "kan" to "Kannada", "kn" to "Kannada", "hin" to "Hindi", "hi" to "Hindi", "mal" to "Malayalam", "ml" to "Malayalam")

        /**
         * Server mpdUrlOf: the signed index.mpd beside a sacdn DASH master, from
         * any `?url=` wrapper (the bridge drops the DASH `lang`). The CloudFront
         * query signs the whole /dash/<id>/ folder. Null when not sacdn or unsigned.
         */
        internal fun mpdUrlOf(url: String): String? {
            val layers = mutableListOf<okhttp3.HttpUrl>()
            var u = url
            for (i in 0 until 4) {
                val h = u.toHttpUrlOrNull() ?: break
                layers += h
                u = h.queryParameter("url")?.takeIf { it.startsWith("http") } ?: break
            }
            val target = layers.lastOrNull() ?: return null
            if (target.host != MPD_HOST || !Regex("^/dash/[^/]+/").containsMatchIn(target.encodedPath)) return null
            val from = layers.asReversed().firstOrNull { l -> SIGNED.all { l.queryParameter(it) != null } } ?: return null
            val q = SIGNED.joinToString("&") { "$it=" + java.net.URLEncoder.encode(from.queryParameter(it)!!, "UTF-8").replace("+", "%20").replace("%7E", "~") }
            return "https://$MPD_HOST" + target.encodedPath.substringBeforeLast('/') + "/index.mpd" + "?" + q
        }

        /** Server mpdAudioLang: the one audio AdaptationSet `lang`, lower case, or null (none or several). */
        internal fun mpdAudioLang(text: String): String? =
            Regex("""<AdaptationSet\b[^>]*>""").findAll(text).map { it.value }
                .filter { Regex("""contentType="audio"|mimeType="audio/""").containsMatchIn(it) }
                .mapNotNull { Regex("""\slang="([^"]*)"""").find(it)?.groupValues?.get(1)?.trim()?.lowercase()?.takeIf(String::isNotEmpty) }
                .toSet().singleOrNull()

        internal class MpdResult(val ok: Boolean, val lang: String? = null, val error: String? = null,
                                 val levels: List<com.chitram.app.data.Level> = emptyList(), val codecs: String? = null)

        private val REPRESENTATION = Regex("""<Representation\b[^>]*>""")
        private fun attr(tag: String, name: String) = Regex("""\s$name="([^"]*)"""").find(tag)?.groupValues?.get(1)

        /**
         * A 200 MPD body: alive when it lists at least one Representation. Video
         * Representations (with a height) become levels, highest first; codecs are
         * the distinct video then audio codec strings ("hev1,mp4a.40.2"), so a
         * device without HEVC ranks the row last (CodecSupport). The audio `lang`
         * feeds the language plan.
         */
        internal fun mpdInfo(text: String): MpdResult {
            val reps = REPRESENTATION.findAll(text).map { it.value }.toList()
            if (reps.isEmpty()) return MpdResult(false, error = "no Representation")
            val video = reps.filter { attr(it, "height") != null }
            val levels = video.mapNotNull { r ->
                val h = attr(r, "height")?.toIntOrNull() ?: return@mapNotNull null
                com.chitram.app.data.Level(height = h, quality = "${h}p", bandwidth = attr(r, "bandwidth")?.toLongOrNull() ?: 0, codecs = attr(r, "codecs"))
            }
            val codecs = (video + reps.filter { it !in video }).mapNotNull { attr(it, "codecs") }.distinct().joinToString(",").ifEmpty { null }
            return MpdResult(true, lang = mpdAudioLang(text), levels = levels, codecs = codecs)
        }
        internal class SourcePlan(val listed: String?, var language: String?, var drop: Boolean = false, var reason: String? = null, var mpd: String? = null)
        internal class LangPlan(val fallback: Boolean, val why: String?, val claims: Int, val tel: Int, val fixed: Int, val sources: Map<String, SourcePlan>) {
            /** The greppable per-title line (server twin). */
            fun line(id: String) = "[multimovies] mpd-lang $id claims=$claims tel=$tel fixed=$fixed fallback=${if (fallback) 1 else 0}"
        }

        /**
         * Server mpdLanguagePlan. `lists`: each answer's (url, raw language) in
         * arrival order; `mpd`: masterKey -> result (no entry: no MPD).
         *  - MPD tel/te: Telugu, whatever the label (Devara "Kurdish sub").
         *  - Listed Telugu with any other or no tag: Telugu dropped, unverified.
         *  - A listed language contradicted by tam/kan/hin/mal: the tag.
         *  - eng, und, no tag: the label stands.
         * Any MPD failed, or a Telugu claim without one: [teluguClaimWinner] for the whole title.
         */
        internal fun mpdLanguagePlan(lists: List<List<Pair<String, String?>>>, mpd: Map<String, MpdResult>): LangPlan {
            val sources = LinkedHashMap<String, SourcePlan>()
            for ((url, raw) in lists.flatten()) masterKey(url).let { k -> if (k !in sources) sourceLanguage(raw).let { sources[k] = SourcePlan(it, it) } }
            val claims = sources.values.count { it.listed == TELUGU }
            val failed = sources.keys.filter { mpd[it]?.ok == false }
            val unsigned = sources.filter { (k, s) -> s.listed == TELUGU && k !in mpd }.keys
            if (failed.isNotEmpty() || unsigned.isNotEmpty()) {
                val winner = teluguClaimWinner(lists)
                sources.forEach { (k, s) -> if (s.listed == TELUGU && winner != null && winner != k) { s.language = null; s.drop = true; s.reason = "duplicate" } }
                val why = listOfNotNull(
                    failed.takeIf { it.isNotEmpty() }?.joinToString(",", "mpd failed ") { "$it(${mpd[it]?.error})" },
                    unsigned.takeIf { it.isNotEmpty() }?.joinToString(",", "no mpd for Telugu claim "),
                ).joinToString("; ")
                return LangPlan(true, why, claims, 0, 0, sources)
            }
            var tel = 0
            var fixed = 0
            sources.forEach { (k, s) ->
                val code = mpd[k]?.lang
                s.mpd = code
                val evidence = code?.let { MPD_EVIDENCE[it] }
                when {
                    evidence == TELUGU -> { tel++; if (s.listed != TELUGU) { s.language = TELUGU; fixed++ } }
                    s.listed == TELUGU -> { s.language = null; s.drop = true; s.reason = "mpd"; fixed++ }
                    evidence != null && s.listed != null && evidence != s.listed -> { s.language = evidence; fixed++ }
                }
            }
            return LangPlan(false, null, claims, tel, fixed, sources)
        }

        /**
         * Server teluguClaimWinner. Two sources of one title may each say
         * "Telugu"; live 2026-11-22, RRR lists 5820588283537016992 and
         * 5355663801620775816 as Telugu, and speech ID reads the first as Tamil
         * (ta 0.60) and the second as Telugu (te 1.00), as the owner hears.
         * Only the LAST Telugu claim in the first answer listing two or more
         * stands. Claims never listed together: "" (none stands). One claim or
         * none: null (nothing to drop). `lists`: each answer's (url, raw language).
         */
        internal fun teluguClaimWinner(lists: List<List<Pair<String, String?>>>): String? {
            fun claims(list: List<Pair<String, String?>>) = list.filter { sourceLanguage(it.second) == TELUGU }.map { masterKey(it.first) }.distinct()
            if (lists.flatMap { claims(it) }.distinct().size < 2) return null
            for (l in lists) claims(l).let { if (it.size >= 2) return it.last() }
            return ""
        }

        /**
         * VidBolt's per-source `language` when it names a KNOWN audio language
         * (server sourceLanguage + knownLanguage). "<lang> sub/subs/subbed/
         * subtitles" carry the original audio with subtitles: never a language.
         * "Original" names no language, never the TMDB one: live 2026-11-22,
         * Vidrift's RRR "Original" (TMDB te) is byte-identical to the "English"
         * MovieBox source (speech ID ta/hi), Jailer's (TMDB ta) to a Malayalam
         * one (ml 1.00). Junk like "Hindi dubbed" or "Dual Audio" is null.
         */
        internal fun sourceLanguage(raw: String?): String? {
            val v = raw?.trim().orEmpty()
            if (v.isEmpty() || Regex("""\bsub(s|bed|titles?)?$""", RegexOption.IGNORE_CASE).containsMatchIn(v)) return null
            if (v.equals("original", true)) return null
            return com.chitram.app.data.Ranking.knownLanguageName(v)
        }

        /**
         * Server audioFromMaster precedence: a real master LANGUAGE wins. The
         * source language is stamped only when the master has exactly ONE
         * audio rendition, untagged (or `und`) with a generic or no NAME: one
         * source language cannot name several renditions (review C1).
         * Anything else keeps its NAME. Nothing is dropped.
         */
        internal fun withSourceLanguage(audio: List<AudioTrack>, sourceLang: String?): List<AudioTrack> {
            if (sourceLang == null || audio.size != 1) return audio
            val a = audio.single()
            val code = a.language?.trim().orEmpty()
            val name = cleanName(a.name)
            val tagged = code.isNotEmpty() && !NO_LANGUAGE_CODE.matches(code)
            return if (!tagged && (name.isEmpty() || GENERIC_AUDIO_NAME.matches(name))) listOf(a.copy(language = sourceLang)) else audio
        }
    }
}
