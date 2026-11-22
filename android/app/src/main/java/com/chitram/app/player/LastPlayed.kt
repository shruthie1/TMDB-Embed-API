package com.chitram.app.player

import com.chitram.app.data.LastProviderStore
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source

/**
 * Start on the provider that last played this title (owner 2026-11-22). The
 * remembered row starts first when it is in the list the race produced (kept,
 * prewarmed or fresh); nothing waits for it. Telugu-first still wins: an auto
 * memory leads only when its row plays the viewer's language, or when no row
 * in the list does. A manual pick (A8) leads outright, as Ranking.applyPin does.
 */
object LastPlayed {
    /** The row to start on, or null: the list's own first row starts. */
    fun startRow(rows: List<Source>, pin: LastProviderStore.Pin?, preferred: String): Source? {
        if (pin == null || pin.provider.isEmpty()) return null
        val ok = rows.filter { !it.unsupported }
        val mine = ok.filter { it.provider.equals(pin.provider, ignoreCase = true) }
        if (mine.isEmpty()) return null
        // Gap 8.5: a manual pick leads only inside the viewer's language, like an automatic one.
        val inLang = { s: Source -> Ranking.tier(s, preferred) <= 2 }
        return mine.firstOrNull(inLang) ?: mine.first().takeIf { ok.none(inLang) }
    }

    /** True once the row on screen since its first frame has played [LastProviderStore.PLAYED_MS]. */
    fun played(framedAtMs: Long, positionMs: Long, sameRow: Boolean): Boolean =
        sameRow && positionMs - framedAtMs >= LastProviderStore.PLAYED_MS

    /** `[last] <type>/<id> provider=<p> not ready, started <q>`: its row was not there at the start (1.2.52). */
    fun notReady(type: String, id: Long, provider: String, started: String): String = "${line(type, id, provider, "not ready")}, started $started"

    /** `[last] <type>/<id> provider=<p> hit|miss|failed|saved`. */
    fun line(type: String, id: Long, provider: String, outcome: String): String = "[last] $type/$id provider=$provider $outcome"
}
