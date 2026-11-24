package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source

/**
 * Pure playback rules ported from the website so the APK behaves the same:
 * web/lib/player/runtimeCheck.js, switchFlow.js and deadSources.js.
 */
object PlayPolicy {
    // ---- Runtime check (runtimeCheck.js) -------------------------------------

    enum class Runtime { UNKNOWN, OK, MISMATCH }

    /** Shorter than this share of the TMDB runtime: wrong title or truncated file. */
    const val RUNTIME_MIN_RATIO = 0.82

    /**
     * UNKNOWN while the runtime or the duration is missing. A play is never
     * confirmed good in that state: a truncated file confirmed early ranked
     * first forever on the web.
     */
    fun runtimeVerdict(runtimeMin: Int?, durationMs: Long): Runtime {
        if (runtimeMin == null || runtimeMin <= 0 || durationMs <= 0) return Runtime.UNKNOWN
        return if (durationMs / 60_000.0 >= runtimeMin * RUNTIME_MIN_RATIO) Runtime.OK else Runtime.MISMATCH
    }

    // ---- Dead-source verdict (switchFlow.js) ----------------------------------

    enum class Switch { WAIT, LANDED, DEAD }

    /** Attached, but no manifest, no buffer, no duration: the origin is not answering. */
    const val SWITCH_NO_LIFE_MS = 8_000L
    /** Something arrived but no frame: a live-but-slow server gets this long, no longer. */
    const val SWITCH_HARD_MS = 20_000L

    /**
     * One look at a stream that has not shown a frame yet. `alive`: any buffer,
     * a known duration or a ready player. `frames`: it is playing.
     */
    fun switchVerdict(elapsedMs: Long, alive: Boolean, frames: Boolean, flowing: Boolean = false): Switch = when {
        frames -> Switch.LANDED
        elapsedMs >= (if (flowing) SWITCH_FLOWING_MAX_MS else SWITCH_HARD_MS) -> Switch.DEAD
        elapsedMs >= SWITCH_NO_LIFE_MS && !alive && !flowing -> Switch.DEAD
        else -> Switch.WAIT
    }

    /**
     * 1.2.54: bytes still arriving are life. A progressive mp4 with a large moov
     * (NetMirror bcdnxw, measured 7.3 MB at the front) has no duration and no
     * buffer until all of it is in. While a byte came within [SWITCH_FLOW_GAP_MS]
     * the row waits up to [SWITCH_FLOWING_MAX_MS]; once bytes stop, the old cuts apply.
     */
    const val SWITCH_FLOW_GAP_MS = 3_000L
    const val SWITCH_FLOWING_MAX_MS = 45_000L

    fun bytesFlowing(lastBytesAt: Long, playStartedAt: Long, now: Long): Boolean =
        lastBytesAt > 0 && lastBytesAt >= playStartedAt && now - lastBytesAt < SWITCH_FLOW_GAP_MS

    /**
     * multimovies-slow-rca.md fix 3: a mapple row whose own (proxy) host refused
     * the connection before any frame is dead now. ExoPlayer retries a refused
     * connection silently, so without this the 8 s watchdog decides. An HTTP
     * reply, a frame, or another host (captions) keeps the normal path.
     */
    fun proxyHostDead(row: Source?, failedUri: String?, httpReplied: Boolean, framed: Boolean): Boolean {
        if (row == null || failedUri == null || httpReplied || framed) return false
        if (!row.provider.equals("mapple", true)) return false
        val h = DirectRoute.host(failedUri)
        return h != "?" && h == DirectRoute.host(row.url)
    }

    // ---- Provider captions ------------------------------------------------------

    /**
     * Player connect timeout for a row (review I1/I2): 3 s only for a VM row
     * playing direct (it falls back to the proxied url); 8 s for an on-device
     * row (no fallback); null keeps the base client for VM-proxied rows.
     */
    fun connectTimeoutMs(s: Source): Long? = when {
        DirectRoute.isDirect(s) -> com.chitram.app.data.Api.DIRECT_CONNECT_TIMEOUT_MS
        s.onDevice != null -> com.chitram.app.data.Api.DEVICE_CONNECT_TIMEOUT_MS
        else -> null
    }

    /**
     * True when the player can use the shared base client as is: a VM row
     * with no headers, token or TS swap AND no connect override. A VM row
     * playing direct has no headers when the provider needs none, but still
     * needs its short connect timeout (review R2-M6): before, that row took
     * the base 15 s client.
     */
    /** The MediaItem mime type for a row: MPD for a DASH row, HLS otherwise, null for a progressive file (media3 sniffs it). */
    fun mimeFor(s: Source): String? = when {
        s.dash -> androidx.media3.common.MimeTypes.APPLICATION_MPD
        s.progressive -> null
        else -> androidx.media3.common.MimeTypes.APPLICATION_M3U8
    }

    fun usesBaseClient(s: Source, tsSwap: Boolean): Boolean =
        s.onDevice == null && !tsSwap && !s.dash && s.headers.isEmpty() && s.segmentToken == null && connectTimeoutMs(s) == null

    /** True when the url's target (after any `?url=` wrapper) is an HLS playlist path. */
    private fun hlsTarget(url: String): Boolean {
        val inner = com.chitram.app.resolve.MultiMoviesResolver.unwrap(url)
        val path = runCatching { java.net.URI(inner).path }.getOrNull() ?: inner.substringBefore('?')
        return path.endsWith(".m3u8", ignoreCase = true)
    }

    /**
     * Captions the player may sideload as one file. An HLS subtitle playlist
     * is not a VTT file: sideloaded, it never parses, and its direct fetch held
     * up the first frame (multimovies-slow-rca.md fix 1). The master's own
     * SUBTITLES rendition still reaches the player through the HLS source.
     */
    fun sideloadable(subs: List<com.chitram.app.data.SubtitleRef>): List<com.chitram.app.data.SubtitleRef> =
        subs.filter { it.url.isNotBlank() && !hlsTarget(it.url) }

    // ---- Auto-advance (switchFlow.advanceTarget, deadSources.nextAlive) --------

    /**
     * The next row to try after a failure: rows this device can decode first,
     * then the language that was playing (rows with no language tag rank
     * between a match and a mismatch), then the nearest height to the one
     * playing, then list order. `lang` null: list order (the caller passes
     * the preferred language when nothing was playing yet).
     */
    fun nextAlive(sources: List<Source>, dead: Set<String>, lang: String?, height: Int?): Source? {
        val want = lang?.trim()?.lowercase().orEmpty()
        val h = height?.takeIf { it > 0 }
        fun langRank(s: Source): Int {
            if (want.isEmpty()) return 0
            val langs = s.languages.filter { it.isNotBlank() }
            if (langs.any { Ranking.sameLanguage(it, lang) }) return 0
            return if (langs.isEmpty()) 1 else 2
        }
        fun dist(s: Source): Int {
            if (h == null) return 0
            val sh = Ranking.height(s)
            return if (sh <= 0) Int.MAX_VALUE else kotlin.math.abs(sh - h)
        }
        return sources.withIndex()
            .filter { (_, s) -> s.id !in dead }
            .sortedWith(
                compareBy<IndexedValue<Source>> { if (it.value.unsupported) 1 else 0 }
                    .thenBy { langRank(it.value) }
                    .thenBy { dist(it.value) }
                    .thenBy { it.index },
            )
            .firstOrNull()?.value
    }
}
