package com.chitram.app.resolve

import com.chitram.app.data.Api
import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Source
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull

/**
 * mapple and vaplayer, resolved from the device's own (residential) IP. Every
 * other provider stays on the backend. Each resolve is bounded by its config
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

    fun launch(scope: CoroutineScope, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu"): List<Deferred<Source?>> = listOf(
        scope.async { resolveOne(MAPPLE, type, id, season, episode, codecs, preferred, fresh = false) },
        scope.async { resolveOne(VAPLAYER, type, id, season, episode, codecs, preferred, fresh = false) },
    )

    /**
     * One provider, bounded by its budget, never throws. `fresh` = recovery after a
     * playback error: a new mapple session, a new vaplayer token for the current IP.
     */
    suspend fun resolveOne(name: String, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String = "Telugu", fresh: Boolean = false): Source? {
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

    private suspend fun guarded(name: String, block: suspend () -> Resolved?): Resolved? {
        val t0 = now()
        return try {
            block().also {
                breakers.remove(name)
                android.util.Log.i("Chitram", "on-device $name: ${if (it != null) "ok" else "none"} in ${now() - t0}ms")
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
        const val BREAKER_FAILS = 3
        const val BREAKER_OPEN_MS = 5 * 60 * 1000L
        const val BREAKER_MAX_MS = 30 * 60 * 1000L

        fun toSource(r: Resolved, codecs: CodecSupport): Source {
            val top = r.levels.maxOfOrNull { it.height } ?: 0
            return Source(
                id = "device-${r.provider}",
                provider = r.provider,
                label = r.label,
                url = r.url,
                progressive = false,
                quality = if (top > 0) "${top}p" else "Auto",
                levels = r.levels,
                // From the master's EXT-X-MEDIA renditions, in master order: the
                // language ranking needs them (never drop a language tag).
                languages = Hls.languages(r.audio),
                selectableAudio = r.audio.size > 1,
                hybrid = false,
                subtitles = emptyList(),
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
