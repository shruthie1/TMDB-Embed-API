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
) {
    fun launch(scope: CoroutineScope, type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport): List<Deferred<Source?>> = listOf(
        scope.async {
            guarded("mapple") {
                val cfg = config.get().mapple
                if (!cfg.enabled) return@guarded null
                withTimeoutOrNull(cfg.budgetMs) { mapple.resolve(cfg, type, id, season, episode) }
            }?.let { toSource(it, codecs) }
        },
        scope.async {
            guarded("vaplayer") {
                val cfg = config.get().vaplayer
                if (!cfg.enabled) return@guarded null
                withTimeoutOrNull(cfg.budgetMs) {
                    val imdb = imdbFor(type, id)?.takeIf { Regex("^tt\\d{6,}$").matches(it) } ?: return@withTimeoutOrNull null
                    vaplayer.resolve(cfg, imdb, type, season, episode)
                }
            }?.let { toSource(it, codecs) }
        },
    )

    private suspend fun guarded(name: String, block: suspend () -> Resolved?): Resolved? = try {
        val t0 = System.currentTimeMillis()
        block().also { android.util.Log.i("Chitram", "on-device $name: ${if (it != null) "ok" else "none"} in ${System.currentTimeMillis() - t0}ms") }
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        android.util.Log.i("Chitram", "on-device $name failed: ${e.message}")
        null
    }

    companion object {
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
