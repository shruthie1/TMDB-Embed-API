package com.chitram.app.resolve

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Source
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * mapple, vaplayer, CastleTV and MultiMovies, resolved from the device's own
 * (residential) IP. Castle runs on every start (it is the Telugu workhorse and
 * must not depend on the VM); MultiMovies, showsst, OneTouchTV and Vidrift only
 * when the VM is down or failed.
 * Every other provider stays on the backend. Each resolve is bounded by its config
 * budget and never throws: a failure is a missing row, so the player simply has
 * one source fewer and moves on.
 */
class OnDeviceResolver(
    private val api: Api?,
    private val config: ResolveConfigStore,
    private val mapple: MappleResolver,
    private val vaplayer: VaplayerResolver,
    /** imdb id for a title; default asks /api/title/:type/:id/full (cached 1 h). */
    private val imdbFor: suspend (type: String, id: Long) -> String? = { t, i -> api?.titleFull(if (t == "tv") "tv" else "movie", i)?.imdbId },
    /** Search title, year and original title for Castle; default asks /api/title/:type/:id/full (cached 1 h). */
    private val titleFor: suspend (type: String, id: Long) -> Triple<String, Int?, String?>? = { t, i -> api?.titleFull(if (t == "tv") "tv" else "movie", i)?.let { Triple(it.title, it.year, it.originalTitle) } },
    private val castle: CastleResolver? = null,
    private val multimovies: MultiMoviesResolver? = null,
    private val netmirror: NetmirrorResolver? = null,
    /** showsst and OneTouchTV: VM down/failed only, like MultiMovies. Built from the app's client when an Api is given. */
    private val showsst: ShowsstResolver? = api?.let { ShowsstResolver(it.client) },
    private val onetouch: OneTouchTvResolver? = api?.let { OneTouchTvResolver(it.client) },
    /** Vidrift Orion (RRR Telugu): VM down/failed only, like MultiMovies. */
    private val vidrift: VidriftResolver? = api?.let { VidriftResolver(it.client) },
    /**
     * TMDB id for OneTouchTV's matched title (the server's IMDB cross-check,
     * utils/tmdbTitleToImdb.js, on TMDB ids). Default asks /api/search; null
     * (no answer, no confident match) passes, as on the server.
     */
    private val tmdbIdFor: suspend (title: String, year: Int?, series: Boolean) -> Long? = { t, y, series ->
        api?.search(t, emptyList())?.filter { (it.mediaType == "tv") == series }?.let { rows ->
            val same = if (y == null) rows else rows.filter { it.year == null || it.year == y }
            TitleMatch.find(same.ifEmpty { rows }, t) { it.title }?.tmdbId
        }
    },
    /** Rows kept 30 min on the device (StreamCache); null keeps no rows (tests). */
    private val cache: StreamCache? = null,
    /** Playlist bodies kept with the rows (PlaylistCache); dropped with them. */
    private val playlists: PlaylistCache? = null,
    /**
     * Prewarm done: fetch the top-ranked row's master and first playlists into
     * [playlists] (no segments). Null: no warm-up (tests). Never given a VM url.
     */
    private val warmPlaylists: (suspend (Source, String) -> Unit)? = null,
    /**
     * The device has no network (NetState). Gap 13.10: a resolve or prewarm then
     * sends nothing, and a no-network error never counts toward a breaker.
     */
    private val offline: () -> Boolean = { false },
    /** The active network is metered (mobile data). Gap 3.8: no playlist warm-up then. */
    private val metered: () -> Boolean = { false },
    // Last: callers pass the clock as a trailing lambda.
    private val now: () -> Long = System::currentTimeMillis,
) {

    /**
     * Circuit breaker per provider: after BREAKER_FAILS chain failures in a row the
     * provider is skipped for BREAKER_OPEN_MS (doubling, max 30 min), so a site that
     * is down does not cost every play its full budget. After the pause one try is
     * let through; a success (or a clean "not here") closes the breaker.
     */
    private class Breaker(var fails: Int = 0, var openUntil: Long = 0)
    private val breakers = java.util.concurrent.ConcurrentHashMap<String, Breaker>()

    internal fun isOpen(name: String): Boolean = (breakers[name]?.openUntil ?: 0L) > now()

    /** The providers [launch] starts, in its order. MultiMovies only when the VM is not expected to answer. */
    fun names(vmDown: Boolean): List<String> =
        listOf(MAPPLE, VAPLAYER) + listOfNotNull(NETMIRROR.takeIf { netmirror != null }, CASTLE.takeIf { castle != null }, MULTIMOVIES.takeIf { vmDown && multimovies != null },
            SHOWSST.takeIf { vmDown && showsst != null }, ONETOUCH.takeIf { vmDown && onetouch != null }, VIDRIFT.takeIf { vmDown && vidrift != null })

    fun launch(scope: CoroutineScope, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", title: String? = null, vmDown: Boolean = false): List<Deferred<Source?>> =
        names(vmDown).map { n -> scope.async { resolveOne(n, type, id, season, episode, codecs, preferred, fresh = false, title = title) } }

    /** Providers may return several distinct catalogs/dubs; keep every row. */
    /**
     * `late` (mapple-speed-2): mapple returns its first playable front at once and
     * keeps looking for the preferred language in `lateScope`; that row (or nothing)
     * completes `late`, always, so a caller can join it like any late row. It is not
     * one of the returned jobs, so the start never waits on it.
     */
    fun launchAll(scope: CoroutineScope, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", title: String? = null, vmDown: Boolean = false, originalLang: String? = null,
                  late: kotlinx.coroutines.CompletableDeferred<List<Source>>? = null, lateScope: CoroutineScope = scope): List<Deferred<List<Source>>> =
        names(vmDown).map { n ->
            val later = if (n == MAPPLE && late != null) MappleResolver.Later(lateScope) { r -> late.complete(listOfNotNull(r?.let { toSource(it, codecs) })) } else null
            scope.async { resolveAll(n, type, id, season, episode, codecs, preferred, title = title, originalLang = originalLang, later = later) }
        }.also { if (late != null && MAPPLE !in names(vmDown)) late.complete(emptyList()) }

    /**
     * One provider's rows. Kept rows (StreamCache, 30 min) answer first with no request;
     * then a details-page prewarm job; else a resolve, whose rows are kept. `fresh`
     * (a row failed in playback) drops the kept rows and resolves once more.
     */
    suspend fun resolveAll(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", fresh: Boolean = false, title: String? = null, originalLang: String? = null,
                           later: MappleResolver.Later? = null): List<Source> {
        val c = cache ?: return resolveAllNow(name, type, id, season, episode, codecs, preferred, fresh, title, originalLang, later)
        val key = StreamCache.key(type, id, season, episode)
        // Gap 10.5: a fresh resolve keeps the old rows until its own answer is known.
        if (!fresh) c.device(key, name, preferred)?.let { rows ->
            // mapple's late preferred-language row is kept in the same slot: nothing more comes.
            later?.deliver(null)
            val partial = c.devicePartial(key, name, preferred)
            android.util.Log.i("Chitram", "[cache] $name $type/$id hit: ${rows.size} row(s), 0 requests${if (partial) ", partial" else ""}")
            if (partial) refreshPartial(c, key, name, type, id, season, episode, codecs, preferred, title, originalLang)
            return rows
        }
        if (later == null) {
            val out = kotlin.coroutines.coroutineContext[Outcome] ?: Outcome()
            return withContext(out) { resolveAllNow(name, type, id, season, episode, codecs, preferred, fresh, title, originalLang, null) }.also { keep(c, key, name, preferred, it, fresh, out) }
        }
        // mapple: keep its first rows and the late row together, once the late outcome is known,
        // so a kept slot never lacks the preferred-language row a live resolve would add.
        val first = kotlinx.coroutines.CompletableDeferred<List<Source>>()
        val lateRow = kotlinx.coroutines.CompletableDeferred<Source?>()
        val tap = MappleResolver.Later(later.scope) { r -> lateRow.complete(r?.let { toSource(it, codecs) }); later.deliver(r) }
        val out = kotlin.coroutines.coroutineContext[Outcome] ?: Outcome()
        later.scope.launch {
            val rows = first.await()
            val extra = if (tap.handedOff) lateRow.await() else null
            keep(c, key, name, preferred, rows + listOfNotNull(extra), fresh, out)
        }
        return try {
            withContext(out) { resolveAllNow(name, type, id, season, episode, codecs, preferred, fresh, title, originalLang, tap) }.also { first.complete(it) }
        } finally {
            later.handedOff = tap.handedOff
            first.complete(emptyList())
        }
    }

    /**
     * Keeps a resolve's rows. Rows replace the kept ones. Gap 10.5: a fresh resolve
     * that failed (network, budget, offline) keeps the old rows; a clean empty
     * answer drops them (the provider no longer has the title).
     */
    private fun keep(c: StreamCache, key: String, name: String, preferred: String, rows: List<Source>, fresh: Boolean, out: Outcome) {
        if (rows.isNotEmpty()) { if (fresh) c.evictDevice(key, name); c.putDevice(key, name, preferred, rows); return }
        if (!fresh) return
        if (out.failed || offline()) android.util.Log.i("Chitram", "[refresh] $name $key failed: kept rows stay")
        else c.evictDevice(key, name)
    }

    private suspend fun resolveAllNow(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String, fresh: Boolean, title: String?, originalLang: String?,
                                      later: MappleResolver.Later?): List<Source> {
        // Play after a details-page prewarm: continue from that work, never a second fetch.
        if (!fresh && kotlin.coroutines.coroutineContext[Prewarming] == null) claimWarm(name, type, id, season, episode, preferred)?.let { w -> return awaitWarm(name, w, later) }
        if (name == MULTIMOVIES) return resolveMultiMovies(type, id, season, episode, codecs, fresh, originalLang)
        if (name == VIDRIFT) return resolveVidrift(type, id, season, episode, codecs, fresh, originalLang)
        if (name == SHOWSST || name == ONETOUCH) return resolveRows(name, type, id, season, episode, codecs, fresh, title)
        if (name != NETMIRROR) return listOfNotNull(resolveOne(name, type, id, season, episode, codecs, preferred, fresh, title, later))
        if (!fresh && isOpen(name)) return emptyList()
        val titleKey = "$type:$id:$season:$episode"
        if (!fresh && netmirrorEmpty(titleKey)) {
            android.util.Log.i("Chitram", "on-device netmirror: $type/$id had no rows ${(now() - (netmirrorNoRows[titleKey] ?: 0)) / 1000}s ago, not asked")
            return emptyList()
        }
        var searched = false
        val prewarming = kotlin.coroutines.coroutineContext[Prewarming] != null
        val tapping = !prewarming && kotlin.coroutines.coroutineContext[UserTap] != null
        val got = guarded(name) {
            val cfg = cfgNow().netmirror
            if (!cfg.enabled) return@guarded emptyList()
            var timedOut = true
            val completed = mutableListOf<Resolved>()
            val rows = withTimeoutOrNull(cfg.budgetMs) {
                val t = withTimeoutOrNull(TITLE_WAIT_MS) {
                    try { titleFor(type, id) } catch (e: Exception) {
                        if (e is kotlinx.coroutines.CancellationException) throw e
                        null
                    }
                }?.takeIf { it.first.isNotBlank() }
                    ?: title?.let { Triple(it, null, null) }
                val result = if (t == null) emptyList() else netmirror?.resolve(cfg, type, t.first, t.second, season, episode, fresh, prewarm = prewarming, tap = tapping) { completed += it }.orEmpty()
                searched = t != null && netmirror != null
                timedOut = false
                result
            }
            if (timedOut && completed.isEmpty()) throw StepException(name, 0, "budget ${cfg.budgetMs}ms spent")
            (rows ?: completed.map { it.copy(incomplete = true) }).map { toSource(it, codecs) }
        }
        // Gap 2.5: a clean "not on NetMirror" is remembered NO_ROWS_MS; rows clear the mark.
        if (got != null && got.isEmpty() && searched) netmirrorNoRows[titleKey] = now()
        else if (!got.isNullOrEmpty()) netmirrorNoRows.remove(titleKey)
        return got.orEmpty()
    }

    /** Gap 2.5: NetMirror titles that answered "no rows", with when. Memory only. */
    private val netmirrorNoRows = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private fun netmirrorEmpty(titleKey: String): Boolean = netmirrorNoRows[titleKey]?.let { now() - it in 0 until NETMIRROR_NO_ROWS_MS } == true

    /** Every VidBolt source as its own row (one per language master): never only the first. */
    private suspend fun resolveMultiMovies(type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, fresh: Boolean, originalLang: String?): List<Source> {
        val m = multimovies ?: return emptyList()
        if (!fresh && isOpen(MULTIMOVIES)) return emptyList()
        return guarded(MULTIMOVIES) {
            var timedOut = true
            // The resolver keeps its masters inside the budget and returns what finished;
            // this outer cap is only a backstop (review I5).
            val r = withTimeoutOrNull(MULTIMOVIES_BUDGET_MS + 2_000) { m.resolveAll(type, id, season, episode, originalLang, budgetMs = MULTIMOVIES_BUDGET_MS).also { timedOut = false } }
            if (timedOut) throw StepException(MULTIMOVIES, 0, "budget ${MULTIMOVIES_BUDGET_MS}ms spent")
            r.orEmpty().map { toSource(it, codecs) }
        }.orEmpty()
    }

    /** Every Vidrift Orion master as its own row (one per language). */
    private suspend fun resolveVidrift(type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, fresh: Boolean, originalLang: String?): List<Source> {
        val v = vidrift ?: return emptyList()
        if (!fresh && isOpen(VIDRIFT)) return emptyList()
        return guarded(VIDRIFT) {
            var timedOut = true
            // The resolver keeps page + masters inside the budget; this outer cap is only a backstop.
            val r = withTimeoutOrNull(VIDRIFT_BUDGET_MS + 2_000) { v.resolveAll(type, id, season, episode, originalLang, budgetMs = VIDRIFT_BUDGET_MS).also { timedOut = false } }
            if (timedOut) throw StepException(VIDRIFT, 0, "budget ${VIDRIFT_BUDGET_MS}ms spent")
            r.orEmpty().map { toSource(it, codecs) }
        }.orEmpty()
    }

    /**
     * showsst / OneTouchTV: every row, bounded by its budget, never throws. A
     * progressive (MP4) row stays progressive, or media3 would parse it as HLS.
     */
    private suspend fun resolveRows(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, fresh: Boolean, title: String?): List<Source> {
        if (!fresh && isOpen(name)) return emptyList()
        return guarded(name) {
            val budget = if (name == SHOWSST) SHOWSST_BUDGET_MS else ONETOUCH_BUDGET_MS
            var timedOut = true
            val rows = withTimeoutOrNull(budget) {
                val out = if (name == SHOWSST) showsst?.resolveAll(type, id, season, episode).orEmpty() else {
                    val t = withTimeoutOrNull(TITLE_WAIT_MS) { runCatching { titleFor(type, id) }.getOrNull() }
                        ?.takeIf { it.first.isNotBlank() } ?: title?.let { Triple(it, null, null) }
                    val imdb = if (type == "tv") withTimeoutOrNull(TITLE_WAIT_MS) { runCatching { imdbFor(type, id) }.getOrNull() }?.takeIf { it.startsWith("tt") } else null
                    if (t == null) emptyList() else onetouch?.resolveAll(type, id, t.first, t.second, imdb, season, episode, tmdbIdFor).orEmpty()
                }
                timedOut = false
                out
            }
            if (timedOut) throw StepException(name, 0, "budget ${budget}ms spent")
            rows.orEmpty().map { toSource(it.resolved, codecs).copy(progressive = it.progressive, quality = it.quality) }
        }.orEmpty()
    }

    /**
     * One provider, bounded by its budget, never throws. `fresh` = recovery after a
     * playback error: a new mapple session, a new vaplayer token for the current IP.
     */
    suspend fun resolveOne(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", fresh: Boolean = false, title: String? = null,
                           later: MappleResolver.Later? = null): Source? =
        try { resolveOneNow(name, type, id, season, episode, codecs, preferred, fresh, title, later) }
        // No background search live (skipped, failed, Telugu first, cancelled): nothing more will come.
        finally { if (later != null && !later.handedOff) later.deliver(null) }

    private suspend fun resolveOneNow(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String, fresh: Boolean, title: String?, later: MappleResolver.Later?): Source? {
        if (name == NETMIRROR || name == MULTIMOVIES || name == SHOWSST || name == ONETOUCH || name == VIDRIFT) return com.chitram.app.data.Ranking.rank(resolveAll(name, type, id, season, episode, codecs, preferred, fresh, title), preferred).firstOrNull()
        if (!fresh && isOpen(name)) {
            android.util.Log.i("Chitram", "on-device $name: skipped, breaker open")
            return null
        }
        return guarded(name) {
            val all = cfgNow()
            when (name) {
                MAPPLE -> {
                    val cfg = all.mapple
                    if (!cfg.enabled) return@guarded null
                    var timedOut = true
                    val r = withTimeoutOrNull(cfg.budgetMs) {
                        mapple.resolve(cfg, type, id, season, episode, preferred, fresh, later).also { timedOut = false }
                    }
                    if (timedOut) throw StepException(name, 0, "budget ${cfg.budgetMs}ms spent")
                    r
                }
                CASTLE -> {
                    val c = castle ?: return@guarded null
                    var timedOut = true
                    val r = withTimeoutOrNull(CASTLE_BUDGET_MS) {
                        // The catalog title (with year) when it answers quickly; else the title on screen.
                        val t = withTimeoutOrNull(TITLE_WAIT_MS) { runCatching { titleFor(type, id) }.getOrNull() }
                            ?.takeIf { it.first.isNotBlank() } ?: title?.let { Triple(it, null, null) }
                        val out = if (t == null) null else c.resolve(type, t.first, t.second, season, episode, preferred, listOfNotNull(t.third))
                        timedOut = false
                        out
                    }
                    if (timedOut) throw StepException(name, 0, "budget ${CASTLE_BUDGET_MS}ms spent")
                    r
                }
                else -> {
                    val cfg = all.vaplayer
                    if (!cfg.enabled) return@guarded null
                    var timedOut = true
                    val r = withTimeoutOrNull(cfg.budgetMs) {
                        val imdb = imdbFor(type, id)?.takeIf { Regex("^tt\\d{6,}$").matches(it) }
                        val out = if (imdb == null) null else vaplayer.resolve(cfg, imdb, type, season, episode)
                        timedOut = false
                        out
                    }
                    if (timedOut) throw StepException(name, 0, "budget ${cfg.budgetMs}ms spent")
                    r
                }
            }
        }?.let { toSource(it, codecs) }
    }

    // ---- prewarm (prewarm.md) -------------------------------------------------

    /** Marks a prewarm resolve: config from cache only, so it sends nothing to the VM. */
    private class Prewarming : kotlin.coroutines.AbstractCoroutineContextElement(Prewarming) {
        companion object Key : kotlin.coroutines.CoroutineContext.Key<Prewarming>
    }

    /**
     * What a resolve ended with, set by [guarded]: a failure, and whether it was
     * the network (no route, DNS, refused, or the device offline). Gap X2: a
     * finished prewarm job that failed is not reused by Play.
     */
    internal class Outcome : kotlin.coroutines.AbstractCoroutineContextElement(Outcome) {
        companion object Key : kotlin.coroutines.CoroutineContext.Key<Outcome>
        @Volatile var failed = false
        @Volatile var network = false
    }

    /** Config for a resolve: a prewarm never fetches it (the fetch goes to the VM). */
    private suspend fun cfgNow(): ResolveConfig =
        if (kotlin.coroutines.coroutineContext[Prewarming] != null) config.current() else config.get()

    /** One provider's prewarm: its rows, plus mapple's background preferred-language row. */
    private class Warm(val at: Long, val rows: Deferred<List<Source>>, val late: kotlinx.coroutines.CompletableDeferred<Resolved?>?, val outcome: Outcome = Outcome())
    private val warm = java.util.concurrent.ConcurrentHashMap<String, Warm>()
    private val warmScope = CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
    /** NetMirror titles prewarmed, with when: never again inside PREWARM_TTL_MS or NetMirror's cooldown (gap 13.9). */
    private val netmirrorWarmed = java.util.concurrent.ConcurrentHashMap<String, Long>()

    private fun warmTitle(type: String, id: Long, season: Int, episode: Int, preferred: String) = "$type:$id:$season:$episode:${preferred.lowercase()}"

    /** Providers a prewarm starts: config `prewarm` true and a resolver on this device. */
    fun prewarmNames(): List<String> {
        val cfg = config.current()
        val names = names(vmDown = true).filter { it in cfg.prewarm }
        val line = prewarmLine(names, if (cfg.prewarmExplicit) config.source() else ResolveConfigStore.FROM_BUILTIN)
        if (prewarmLogged.getAndSet(line) != line) android.util.Log.i("Chitram", line)
        return names
    }
    /** The last `prewarm: providers=` line logged: printed once, again only when it changes. */
    private val prewarmLogged = java.util.concurrent.atomic.AtomicReference<String?>(null)

    /**
     * Details page opened: start the on-device resolve of every prewarm provider for
     * the title Play would open, in parallel, off the main thread, and keep each
     * job for PREWARM_TTL_MS. Play's [resolveAll] then awaits the job instead of
     * fetching again. Never calls the VM (config from cache, catalog from Vercel).
     * Each provider keeps its own budget and breaker; one slow or failing provider
     * never delays another. Another title's unclaimed jobs are cancelled: one
     * title is prewarmed at a time, so at most one NetMirror prewarm is in flight.
     */
    fun prewarm(type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", title: String? = null, originalLang: String? = null,
                first: String? = null): List<String> {
        val t = warmTitle(type, id, season, episode, preferred)
        val at = now()
        warm.entries.removeIf { (k, w) ->
            (!k.startsWith("$t|") || at - w.at > PREWARM_TTL_MS).also { drop -> if (drop) { w.rows.cancel(); w.late?.cancel() } }
        }
        // Gap 13.10: no network, nothing to warm; no request, no breaker count.
        if (offline()) { android.util.Log.i("Chitram", "prewarm: $type/$id offline, skipped"); return emptyList() }
        val nmCfg = config.current().netmirror
        val nmGuardMs = maxOf(PREWARM_TTL_MS, nmCfg.cooldownMs)
        netmirrorWarmed.entries.removeIf { at - it.value !in 0 until nmGuardMs }
        val started = mutableListOf<String>()
        val kept = mutableListOf<String>()
        val jobs = mutableListOf<Deferred<List<Source>>>()
        // The title's last provider (LastProviderStore) starts first.
        val lead = nameFor(first)
        for (n in prewarmNames().let { all -> if (lead != null && lead in all) listOf(lead) + (all - lead) else all }) {
            val k = "$t|$n"
            // Rows kept from an earlier resolve: nothing to warm, 0 requests.
            if (cache?.hasDevice(StreamCache.key(type, id, season, episode), n, preferred) == true) { kept += n; continue }
            if (warm.containsKey(k)) continue
            // Breaker open: the provider is paused for Play too; nothing to warm.
            if (isOpen(n)) continue
            if (n == NETMIRROR) {
                // Gap 2.5: NetMirror said "no rows" for this title a short while ago.
                if (netmirrorEmpty("$type:$id:$season:$episode")) continue
                // Gap 13.9: the prewarm share of the window budget is spent; Play keeps the rest.
                if (netmirror?.prewarmShareSpent(nmCfg) == true) { android.util.Log.i("Chitram", "prewarm: netmirror $type/$id skipped, prewarm share of the request budget spent"); continue }
                if (netmirrorWarmed.putIfAbsent("$type:$id:$season:$episode", at) != null) continue
            }
            val late = if (n == MAPPLE) kotlinx.coroutines.CompletableDeferred<Resolved?>() else null
            val later = late?.let { l -> MappleResolver.Later(warmScope) { r -> l.complete(r) } }
            val outcome = Outcome()
            val job = warmScope.async(Prewarming() + outcome, start = kotlinx.coroutines.CoroutineStart.LAZY) {
                val t0 = now()
                try {
                    resolveAll(n, type, id, season, episode, codecs, preferred, fresh = false, title = title, originalLang = originalLang, later = later).also { rows ->
                        if (n == NETMIRROR) android.util.Log.i("Chitram", "prewarm: netmirror $type/$id result=${if (rows.isNotEmpty()) "rows" else if (netmirror?.throttled == true) "throttled" else "error"} ms=${now() - t0} rows=${rows.size}")
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    if (n == NETMIRROR) android.util.Log.i("Chitram", "prewarm: netmirror $type/$id result=cancelled ms=${now() - t0} rows=0")
                    throw e
                } finally {
                    // No background search live (none, or cancelled first): nothing more comes.
                    if (later != null && !later.handedOff) late?.complete(null)
                }
            }
            warm[k] = Warm(at, job, late, outcome)
            job.start()
            jobs += job
            started += n
        }
        if (started.isNotEmpty() || kept.isNotEmpty()) warmTop(type, id, season, episode, preferred, jobs)
        if (kept.isNotEmpty()) android.util.Log.i("Chitram", "prewarm: $type/$id s$season e$episode kept rows, skipped ${kept.joinToString(",")}")
        if (started.isNotEmpty()) android.util.Log.i("Chitram", "prewarm: $type/$id s$season e$episode started ${started.joinToString(",")}")
        return started
    }

    /**
     * Providers with a fresh prewarm job for this Play, not yet taken, in launch order.
     * Play starts each of them (even one it would otherwise start only when the VM
     * fails) so its rows join the first list at once.
     */
    fun prewarmedNames(type: String, id: Long, season: Int, episode: Int, preferred: String): List<String> =
        warmSplit(type, id, season, episode, preferred).let { (kept, jobs) -> names(vmDown = true).filter { it in kept || it in jobs } }

    /**
     * [prewarmedNames] in two parts, each in launch order: providers whose rows are
     * kept (StreamCache, 0 requests), and providers with a live prewarm job.
     */
    fun warmSplit(type: String, id: Long, season: Int, episode: Int, preferred: String): Pair<List<String>, List<String>> {
        val t = warmTitle(type, id, season, episode, preferred)
        val at = now()
        val key = StreamCache.key(type, id, season, episode)
        val all = names(vmDown = true)
        val kept = all.filter { n -> cache?.hasDevice(key, n, preferred) == true }
        val jobs = all.filter { n -> n !in kept && warm["$t|$n"]?.let { at - it.at <= PREWARM_TTL_MS && !it.rows.isCancelled } == true }
        return kept to jobs
    }

    /**
     * A row failed in playback: drop the kept rows it came from, so the next resolve
     * (this play's one re-resolve, or the next Play) fetches fresh. A device row drops
     * its provider's rows; a VM row drops the kept VM answers.
     */
    fun dropKept(type: String, id: Long, season: Int, episode: Int, row: Source) {
        val c = cache ?: return
        val key = StreamCache.key(type, id, season, episode)
        val n = row.onDevice?.let(::nameFor)
        if (n != null) c.evictDevice(key, n) else if (row.onDevice == null) c.evictVm(key) else return
        dropPlaylists(listOfNotNull(row.url, row.directUrl, row.proxyUrl))
        android.util.Log.i("Chitram", "[cache] ${row.provider} $type/$id failed in playback: kept ${n ?: "vm"} rows dropped")
    }

    /**
     * "Refresh sources": forget everything kept for this title and episode, so no
     * stored row and no prewarm job answers the next resolve. Returns the urls
     * that were kept (the refresh compares the new answer against them).
     */
    fun forgetTitle(type: String, id: Long, season: Int, episode: Int): Set<String> {
        val key = StreamCache.key(type, id, season, episode)
        // Gap 10.5: the kept rows stay until a provider's new answer replaces them
        // (resolveAll fresh); a failed refresh keeps them.
        val kept = cache?.urls(key).orEmpty()
        val prefix = "$type:$id:$season:$episode:"
        warm.entries.removeIf { (k, w) -> k.startsWith(prefix).also { if (it) { w.rows.cancel(); w.late?.cancel() } } }
        netmirrorNoRows.remove("$type:$id:$season:$episode")
        android.util.Log.i("Chitram", "[refresh] $type/$id s$season e$episode: ${kept.size} kept url(s) stay until new rows come, prewarm jobs dropped")
        return kept
    }

    /** A refresh answered: drop the playlists of kept urls the new answer no longer has. */
    fun dropOldPlaylists(kept: Set<String>, fresh: Set<String>) = dropPlaylists(kept - fresh)

    /**
     * "Refresh sources": every provider in [names] resolves anew, in parallel
     * (fresh: no kept rows, no prewarm job, no NetMirror answer memo; its session
     * token and single-flight lock stay). mapple's preferred-language row is
     * awaited too, so the Telugu row a Play would add is in the answer. Each
     * provider's count goes to [onProvider] as it lands. The rows are kept again
     * (StreamCache) by [resolveAll].
     */
    suspend fun refreshAll(names: List<String>, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", title: String? = null, originalLang: String? = null,
                           onProvider: (String, Int) -> Unit = { _, _ -> }): List<Source> = kotlinx.coroutines.coroutineScope {
        val late = kotlinx.coroutines.CompletableDeferred<List<Source>>()
        // mapple's background search lives here; cancelled once the wait below ends.
        val bg = kotlinx.coroutines.SupervisorJob(coroutineContext[kotlinx.coroutines.Job])
        val lateScope = CoroutineScope(coroutineContext + bg)
        val jobs = names.map { n ->
            val later = if (n == MAPPLE) MappleResolver.Later(lateScope) { r -> late.complete(listOfNotNull(r?.let { toSource(it, codecs) })) } else null
            async(UserTap()) {
                val rows = resolveAll(n, type, id, season, episode, codecs, preferred, fresh = true, title = title, originalLang = originalLang, later = later)
                if (later != null && !later.handedOff) late.complete(emptyList())
                onProvider(n, rows.size)
                rows
            }
        }
        if (MAPPLE !in names) late.complete(emptyList())
        val rows = jobs.flatMap { it.await() }
        val lateRows = withTimeoutOrNull(REFRESH_LATE_WAIT_MS) { late.await() }
        // Done: let the cache write of mapple's slot finish. Timed out: stop the search.
        if (lateRows == null) bg.cancel() else bg.complete()
        val extra = lateRows.orEmpty().filter { e -> rows.none { it.url == e.url } }
        if (extra.isNotEmpty()) onProvider(MAPPLE, extra.size + rows.count { nameFor(it.onDevice) == MAPPLE })
        rows + extra
    }

    private fun dropPlaylists(urls: Collection<String>) {
        val p = playlists ?: return
        val n = urls.sumOf { p.evict(it) }
        if (n > 0) android.util.Log.i("Chitram", "[playlist] $n kept playlist(s) dropped with their rows")
    }

    /**
     * After the prewarm: the rows it kept or resolved, ranked as Play ranks the
     * device rows; the first one's playlists are fetched into memory. VM urls are
     * skipped (the prewarm never loads the VM).
     */
    private fun warmTop(type: String, id: Long, season: Int, episode: Int, preferred: String, jobs: List<Deferred<List<Source>>>) {
        val warmUp = warmPlaylists ?: return
        // Gap 3.8 (owner rule: cut data on browse): rows only on mobile data, no playlists.
        if (metered()) { android.util.Log.i("Chitram", "[playlist] warm skipped: metered network"); return }
        val key = StreamCache.key(type, id, season, episode)
        warmScope.launch(Prewarming()) {
            val fresh = jobs.flatMap { j -> runCatching { j.await() }.getOrDefault(emptyList()) }
            val kept = names(vmDown = true).flatMap { n -> cache?.device(key, n, preferred).orEmpty() }
            val top = com.chitram.app.data.Ranking.rank((fresh + kept).distinctBy { it.url }.filter { !it.unsupported }, preferred).firstOrNull() ?: return@launch
            runCatching { warmUp(top, preferred) }.onFailure {
                if (it is kotlinx.coroutines.CancellationException) throw it
                android.util.Log.i("Chitram", "[playlist] warm ${top.provider} failed: ${it.javaClass.simpleName}")
            }
        }
    }

    /** Unclaimed prewarm jobs (tests). */
    internal fun partialRefreshJobs(): List<kotlinx.coroutines.Job> = partialJobs.values.filter { it.isActive }
    private val partialJobs = java.util.concurrent.ConcurrentHashMap<String, kotlinx.coroutines.Job>()

    /**
     * 1.2.52: Play got a partial answer's kept rows. Ask the provider again in the
     * background, as a prewarm (NetMirror: its half of the request budget only), so a
     * complete answer replaces them; a failed or partial one keeps every kept row.
     * Skipped offline, with the breaker open, or once NetMirror's prewarm share is spent.
     * One refresh per title and provider at a time. Never delays the caller.
     */
    private fun refreshPartial(c: StreamCache, key: String, name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport,
                               preferred: String, title: String?, originalLang: String?) {
        val why = when {
            offline() -> "offline"
            isOpen(name) -> "breaker open"
            name == NETMIRROR && netmirror?.prewarmShareSpent(config.current().netmirror) == true -> "prewarm share of the request budget spent"
            name == NETMIRROR && netmirrorEmpty("$type:$id:$season:$episode") -> "no rows lately"
            else -> null
        }
        if (why != null) { android.util.Log.i("Chitram", "[cache] $name $type/$id partial: no refresh, $why"); return }
        val k = "$key|$name|${preferred.lowercase()}"
        if (partialJobs[k]?.isActive == true) return
        partialJobs[k] = warmScope.launch(Prewarming()) {
            val out = Outcome()
            val rows = try {
                withContext(out) { resolveAllNow(name, type, id, season, episode, codecs, preferred, false, title, originalLang, null) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                emptyList()
            }
            keep(c, key, name, preferred, rows, fresh = false, out = out)
            android.util.Log.i("Chitram", "[cache] $name $type/$id partial refresh: ${rows.size} row(s), complete=${rows.isNotEmpty() && rows.none { it.incomplete }}")
        }.also { j -> j.invokeOnCompletion { partialJobs.remove(k, j) } }
    }
    internal fun prewarmJobs(): List<Deferred<List<Source>>> = warm.values.map { it.rows }

    /** Details page left: cancel this title's prewarm jobs Play has not taken. */
    fun cancelPrewarm(type: String, id: Long) {
        warm.entries.removeIf { (k, w) -> k.startsWith("$type:$id:").also { if (it) { w.rows.cancel(); w.late?.cancel() } } }
    }

    /** Takes this provider's prewarm job for this title, once; null when none is fresh. */
    private fun claimWarm(name: String, type: String, id: Long, season: Int, episode: Int, preferred: String): Warm? {
        val w = warm.remove("${warmTitle(type, id, season, episode, preferred)}|$name") ?: return null
        if (now() - w.at > PREWARM_TTL_MS || w.rows.isCancelled) { w.rows.cancel(); w.late?.cancel(); return null }
        if (unusable(name, w)) {
            w.late?.cancel()
            android.util.Log.i("Chitram", "prewarm: $name $type/$id job ended with 0 rows (${if (w.outcome.network) "network" else if (w.outcome.failed) "failed" else "empty"}), resolving again")
            return null
        }
        android.util.Log.i("Chitram", "prewarm: $name $type/$id reused (age ${now() - w.at}ms, ${if (w.rows.isCompleted) "done" else "in flight"})")
        return w
    }

    /**
     * Gap X2: a finished prewarm job with 0 rows is not reused when it failed on
     * the network (or offline), for every provider; nor when it was empty or
     * failed, for every provider but NetMirror. A NetMirror upstream failure is
     * reused (fewest NetMirror requests); its clean empty is the no-rows mark.
     */
    private fun unusable(name: String, w: Warm): Boolean {
        if (!w.rows.isCompleted || w.rows.isCancelled) return false
        val rows = runCatching { w.rows.getCompleted() }.getOrNull()
        if (!rows.isNullOrEmpty()) return false
        if (w.outcome.network) return true
        return name != NETMIRROR
    }

    /** Play's rows from a prewarm job; mapple's late row goes through Play's own [later], as a list entry only. */
    private suspend fun awaitWarm(name: String, w: Warm, later: MappleResolver.Later?): List<Source> {
        if (later != null) {
            val l = w.late
            if (l == null) later.deliver(null) else {
                later.handedOff = true
                l.invokeOnCompletion { cause -> later.deliver(if (cause == null) l.getCompleted() else null) }
            }
        }
        return try { w.rows.await() } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && !w.rows.isCancelled) throw e
            android.util.Log.i("Chitram", "prewarm: $name job ended without rows: ${e.javaClass.simpleName}")
            emptyList()
        }
    }

    private suspend fun <T> guarded(name: String, block: suspend () -> T?): T? {
        val t0 = now()
        val out = kotlin.coroutines.coroutineContext[Outcome]
        // Gap 13.10: no network: send nothing, count nothing.
        if (offline()) {
            out?.apply { failed = true; network = true }
            android.util.Log.i("Chitram", "on-device $name: offline, skipped")
            return null
        }
        return try {
            block().also {
                breakers.remove(name)
                android.util.Log.i("Chitram", "on-device $name: ${if (it != null && (it as? Collection<*>)?.isEmpty() != true) "ok" else "none"} in ${now() - t0}ms")
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            val net = isNetwork(e)
            out?.apply { failed = true; network = network || net || offline() }
            // Gap 13.10: the device went offline mid-resolve, or a prewarm hit its share: not the provider's fault.
            if (offline()) {
                android.util.Log.i("Chitram", "on-device $name failed in ${now() - t0}ms, not counted (offline): ${e.message}")
                return null
            }
            // 1.2.54: the provider's own pause or budget (cooldown active, budget spent): nothing failed.
            if (e is SelfImposedSkip) {
                android.util.Log.i("Chitram", "[breaker] skip not counted: $name ${e.message}")
                return null
            }
            val b = breakers.getOrPut(name) { Breaker() }
            synchronized(b) {
                b.fails++
                if (b.fails >= BREAKER_FAILS) {
                    val open = (BREAKER_OPEN_MS shl (b.fails - BREAKER_FAILS).coerceAtMost(3)).coerceAtMost(BREAKER_MAX_MS)
                    b.openUntil = now() + open
                    android.util.Log.i("Chitram", "on-device $name: ${b.fails} failures in a row, paused ${open / 1000}s")
                }
            }
            android.util.Log.i("Chitram", "on-device $name failed in ${now() - t0}ms: ${e.message}")
            null
        }
    }

    companion object {
        const val MAPPLE = "mapple"
        const val VAPLAYER = "vaplayer"
        const val CASTLE = "castletv"
        const val MULTIMOVIES = "multimovies"
        const val NETMIRROR = "netmirror"
        const val SHOWSST = "showsst"
        const val ONETOUCH = "onetouchtv"
        const val VIDRIFT = "vidrift"
        const val SHOWSST_BUDGET_MS = 15_000L
        const val ONETOUCH_BUDGET_MS = 20_000L
        const val CASTLE_BUDGET_MS = 25_000L
        const val MULTIMOVIES_BUDGET_MS = 15_000L
        /** Server vidrift budgetMs: page + mirror + masters together. */
        const val VIDRIFT_BUDGET_MS = 15_000L
        private const val TITLE_WAIT_MS = 4_000L

        /** OnDeviceResolver name for a row's provider or onDevice value, or null when the device cannot resolve it. */
        fun nameFor(provider: String?): String? = when (provider?.lowercase()) {
            MAPPLE -> MAPPLE
            VAPLAYER -> VAPLAYER
            CASTLE -> CASTLE
            MULTIMOVIES -> MULTIMOVIES
            NETMIRROR -> NETMIRROR
            SHOWSST -> SHOWSST
            ONETOUCH -> ONETOUCH
            VIDRIFT -> VIDRIFT
            else -> null
        }
        /** `[race] cache hit:` (kept rows) and `[race] continuing prewarm:` (live jobs), each only when not empty. */
        fun raceLines(kept: List<String>, jobs: List<String>): List<String> =
            listOfNotNull(kept.takeIf { it.isNotEmpty() }?.let { "[race] cache hit: ${it.joinToString(",")}" },
                jobs.takeIf { it.isNotEmpty() }?.let { "[race] continuing prewarm: ${it.joinToString(",")}" })
        /** Greppable once-per-change line: which providers prewarm, and whose config said so. */
        fun prewarmLine(names: List<String>, source: String): String = "prewarm: providers=${names.joinToString(",").ifEmpty { "none" }} source=$source"
        /** A prewarm job older than this is not reused (signed links age). */
        const val PREWARM_TTL_MS = 120_000L
        /** A refresh waits this long for mapple's late preferred-language row after every provider answered. */
        const val REFRESH_LATE_WAIT_MS = 15_000L
        /** Gap 2.5: NetMirror's "no rows" for a title holds this long (a Refresh asks anyway). */
        const val NETMIRROR_NO_ROWS_MS = 10 * 60 * 1000L
        const val BREAKER_FAILS = 3

        /** No route to the host: DNS, refused, unreachable (also as a cause). */
        fun isNetwork(e: Throwable): Boolean = generateSequence(e) { it.cause }.take(5).any {
            it is java.net.UnknownHostException || it is java.net.ConnectException || it is java.net.NoRouteToHostException
        }
        const val BREAKER_OPEN_MS = 5 * 60 * 1000L
        const val BREAKER_MAX_MS = 30 * 60 * 1000L

        fun toSource(r: Resolved, codecs: CodecSupport): Source {
            val top = r.levels.maxOfOrNull { it.height } ?: 0
            return Source(
                id = "device-${r.key ?: r.provider}",
                provider = r.provider,
                label = r.label,
                url = r.url,
                progressive = false,
                quality = if (top > 0) "${top}p" else "Auto",
                levels = r.levels,
                // From the master's EXT-X-MEDIA renditions, in master order: the
                // language ranking needs them (never drop a language tag).
                languages = (Hls.languages(r.audio) + r.languages).mapNotNull(com.chitram.app.data.Ranking::languageLabel).distinctBy { it.lowercase() },
                selectableAudio = r.audio.size > 1 && !r.muxed,
                audioLanguages = if (r.provider == NETMIRROR || r.audio.isNotEmpty()) Hls.languages(r.audio).mapNotNull(com.chitram.app.data.Ranking::languageLabel).distinctBy { it.lowercase() } else null,
                catalogLanguages = r.catalogLanguages.mapNotNull(com.chitram.app.data.Ranking::languageLabel).distinctBy { it.lowercase() },
                netmirrorCatalog = r.netmirrorCatalog,
                incomplete = r.incomplete,
                hybrid = false,
                subtitles = r.subtitles,
                videoCodec = null,
                codecString = r.codecs,
                unsupported = codecs.supports(null, r.codecs) == false,
                onDevice = r.provider,
                headers = r.headers,
                segmentToken = r.segmentToken,
                dash = r.dash,
            )
        }
    }
}

/**
 * 1.2.54: marks a resolve the viewer asked for now (a NetMirror row pick that
 * failed, Check streams, Refresh sources). NetMirror then tries past its own cooldown.
 */
class UserTap : kotlin.coroutines.AbstractCoroutineContextElement(UserTap) {
    companion object Key : kotlin.coroutines.CoroutineContext.Key<UserTap>
}
