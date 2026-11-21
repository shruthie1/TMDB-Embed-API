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
    fun switchVerdict(elapsedMs: Long, alive: Boolean, frames: Boolean): Switch = when {
        frames -> Switch.LANDED
        elapsedMs >= SWITCH_HARD_MS -> Switch.DEAD
        elapsedMs >= SWITCH_NO_LIFE_MS && !alive -> Switch.DEAD
        else -> Switch.WAIT
    }

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
