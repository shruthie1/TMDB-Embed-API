package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source

/**
 * "Refresh sources" journey (owner 2026-11-22), the same on the details page, the
 * player's source list and the failure card:
 * idle -> refreshing -> updated / no change / failed -> cooldown -> idle.
 * Pure state: the screens draw [label], [noteAt] and [chips]; tests drive it.
 */
data class RefreshModel(
    val running: Boolean = false,
    /** Short result line, shown until [noteUntil]. */
    val note: String? = null,
    val noteUntil: Long = 0L,
    /** The next refresh of this title may run from here (SourceRefresh.readyAt). */
    val readyAt: Long = 0L,
    /** Providers that answered during this refresh, with their row count, in answer order. */
    val answered: List<Pair<String, Int>> = emptyList(),
) {
    enum class State { IDLE, REFRESHING, COOLDOWN }

    fun state(now: Long): State = when {
        running -> State.REFRESHING
        readyAt > now -> State.COOLDOWN
        else -> State.IDLE
    }

    fun label(now: Long): String = when (state(now)) {
        State.REFRESHING -> Copy.RUNNING
        State.COOLDOWN -> Copy.cooldown(readyAt - now)
        State.IDLE -> Copy.IDLE
    }

    fun noteAt(now: Long): String? = note?.takeIf { now < noteUntil }

    /** Provider chips filling in while refreshing: "castletv 2 · mapple 1". */
    fun chips(): String = answered.joinToString(" · ") { (n, c) -> "$n $c" }

    fun start(now: Long, readyAt: Long): RefreshModel = RefreshModel(running = true, readyAt = readyAt)

    fun answered(name: String, rows: Int): RefreshModel = copy(answered = answered.filter { it.first != name } + (name to rows))

    fun finish(now: Long, note: String): RefreshModel = copy(running = false, note = note, noteUntil = now + NOTE_MS)

    /** Pressed during the cooldown: say when, never a dead control. */
    fun blocked(now: Long, readyAt: Long): RefreshModel = copy(running = false, note = Copy.cooldown(readyAt - now), noteUntil = now + NOTE_MS, readyAt = readyAt)

    object Copy {
        const val IDLE = "Refresh sources"
        const val RUNNING = "Refreshing…"
        const val FAILED = "Couldn't refresh. Try again."
        const val NO_CHANGE = "No new sources"
        const val NONE = "No sources found yet"
        const val PLAYBACK_CONTINUES = "Current playback continues"
        fun cooldown(ms: Long) = "Refresh again in ${((ms.coerceAtLeast(0) + 999) / 1000).coerceAtLeast(1)}s"
        fun updated(n: Int, inLang: Int, language: String) = "Updated: $n ${if (n == 1) "source" else "sources"} ($inLang $language)"
    }

    companion object {
        /** Result lines hide after this. */
        const val NOTE_MS = 3_000L

        /**
         * The result line. [failed]: nothing came back. Empty answer: none found.
         * The same urls as before: no new sources. Else the count, with how many
         * carry the viewer's language.
         */
        fun outcome(before: Set<String>, after: List<Source>, failed: Boolean, preferred: String): String = when {
            failed -> Copy.FAILED
            after.isEmpty() -> Copy.NONE
            before.isNotEmpty() && after.map { it.url }.toSet() == before -> Copy.NO_CHANGE
            else -> Copy.updated(after.size, after.count { s -> s.languages.any { Ranking.sameLanguage(it, preferred) } }, preferred)
        }

        /**
         * The one automatic start after a refresh: the source on screen had already
         * failed (failure card) and the refresh found rows. Never while one plays.
         */
        fun autoStart(errored: Boolean, rows: List<Source>): Boolean = errored && rows.isNotEmpty()

        /** What a refresh answer does to the player: the new list (null: keep the old one) and the row to start, if any. */
        data class Applied(val list: List<Source>?, val start: Source?)

        /**
         * Gap 10.3. Nothing came back: the old list stays, nothing starts. A row is
         * playing: it stays listed ([keep] merges it back when the answer lacks it)
         * and nothing switches. Failure card: the new list's first row starts.
         */
        fun apply(fresh: List<Source>, failed: Boolean, current: Source?, errored: Boolean, keep: (List<Source>, Source) -> List<Source>): Applied {
            if (failed || fresh.isEmpty()) return Applied(null, null)
            val list = if (!errored && current != null && fresh.none { it.id == current.id }) keep(fresh, current) else fresh
            return Applied(list, if (autoStart(errored, list)) list.first() else null)
        }
    }
}
