package com.chitram.app.resolve

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Source
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull

/**
 * mapple, vaplayer, CastleTV and MultiMovies, resolved from the device's own
 * (residential) IP. Castle runs on every start (it is the Telugu workhorse and
 * must not depend on the VM); MultiMovies only when the VM is down or failed.
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
        listOf(MAPPLE, VAPLAYER) + listOfNotNull(NETMIRROR.takeIf { netmirror != null }, CASTLE.takeIf { castle != null }, MULTIMOVIES.takeIf { vmDown && multimovies != null })

    fun launch(scope: CoroutineScope, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", title: String? = null, vmDown: Boolean = false): List<Deferred<Source?>> =
        names(vmDown).map { n -> scope.async { resolveOne(n, type, id, season, episode, codecs, preferred, fresh = false, title = title) } }

    /** Providers may return several distinct catalogs/dubs; keep every row. */
    fun launchAll(scope: CoroutineScope, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", title: String? = null, vmDown: Boolean = false): List<Deferred<List<Source>>> =
        names(vmDown).map { n -> scope.async { resolveAll(n, type, id, season, episode, codecs, preferred, title = title) } }

    suspend fun resolveAll(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", fresh: Boolean = false, title: String? = null): List<Source> {
        if (name == MULTIMOVIES) return resolveMultiMovies(type, id, season, episode, codecs, fresh)
        if (name != NETMIRROR) return listOfNotNull(resolveOne(name, type, id, season, episode, codecs, preferred, fresh, title))
        if (!fresh && isOpen(name)) return emptyList()
        return guarded(name) {
            val cfg = config.get().netmirror
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
                val result = if (t == null) emptyList() else netmirror?.resolve(cfg, type, t.first, t.second, season, episode, fresh) { completed += it }.orEmpty()
                timedOut = false
                result
            }
            if (timedOut && completed.isEmpty()) throw StepException(name, 0, "budget ${cfg.budgetMs}ms spent")
            (rows ?: completed.map { it.copy(incomplete = true) }).map { toSource(it, codecs) }
        }.orEmpty()
    }

    /** Every VidBolt source as its own row (one per language master): never only the first. */
    private suspend fun resolveMultiMovies(type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, fresh: Boolean): List<Source> {
        val m = multimovies ?: return emptyList()
        if (!fresh && isOpen(MULTIMOVIES)) return emptyList()
        return guarded(MULTIMOVIES) {
            var timedOut = true
            val r = withTimeoutOrNull(MULTIMOVIES_BUDGET_MS) { m.resolveAll(type, id, season, episode).also { timedOut = false } }
            if (timedOut) throw StepException(MULTIMOVIES, 0, "budget ${MULTIMOVIES_BUDGET_MS}ms spent")
            r.orEmpty().map { toSource(it, codecs) }
        }.orEmpty()
    }

    /**
     * One provider, bounded by its budget, never throws. `fresh` = recovery after a
     * playback error: a new mapple session, a new vaplayer token for the current IP.
     */
    suspend fun resolveOne(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", fresh: Boolean = false, title: String? = null): Source? {
        if (name == NETMIRROR || name == MULTIMOVIES) return com.chitram.app.data.Ranking.rank(resolveAll(name, type, id, season, episode, codecs, preferred, fresh, title), preferred).firstOrNull()
        if (!fresh && isOpen(name)) {
            android.util.Log.i("Chitram", "on-device $name: skipped, breaker open")
            return null
        }
        return guarded(name) {
            val all = config.get()
            when (name) {
                MAPPLE -> {
                    val cfg = all.mapple
                    if (!cfg.enabled) return@guarded null
                    var timedOut = true
                    val r = withTimeoutOrNull(cfg.budgetMs) {
                        mapple.resolve(cfg, type, id, season, episode, preferred, fresh).also { timedOut = false }
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

    private suspend fun <T> guarded(name: String, block: suspend () -> T?): T? {
        val t0 = now()
        return try {
            block().also {
                breakers.remove(name)
                android.util.Log.i("Chitram", "on-device $name: ${if (it != null && (it as? Collection<*>)?.isEmpty() != true) "ok" else "none"} in ${now() - t0}ms")
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
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
        const val CASTLE_BUDGET_MS = 25_000L
        const val MULTIMOVIES_BUDGET_MS = 15_000L
        private const val TITLE_WAIT_MS = 4_000L

        /** OnDeviceResolver name for a row's provider or onDevice value, or null when the device cannot resolve it. */
        fun nameFor(provider: String?): String? = when (provider?.lowercase()) {
            MAPPLE -> MAPPLE
            VAPLAYER -> VAPLAYER
            CASTLE -> CASTLE
            MULTIMOVIES -> MULTIMOVIES
            NETMIRROR -> NETMIRROR
            else -> null
        }
        const val BREAKER_FAILS = 3
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
            )
        }
    }
}
