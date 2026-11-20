package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import java.util.Locale

/**
 * The player's loading screen as a pure function (loading-ux spec, shared with
 * web/lib/player/loadingModel.js: same constants, same strings).
 *
 * One clock (`playAt`) for the whole start. No "Try again" while anything is
 * still loading: it shows only after 30s with no source list, or on the end
 * card. From 30s with a list and no frame, "Choose a server" opens Details.
 */
object LoadingModel {
    const val LOADING_SLOW_HINT_MS = 15_000L
    const val LOADING_CHOOSER_MS = 30_000L
    const val LOADING_RETRY_MS = 30_000L

    const val CHECK_SERVER = "check:server"
    const val CHECK_MAPPLE = "check:mapple"
    const val CHECK_VAPLAYER = "check:vaplayer"

    enum class Phase(val key: String) {
        FINDING("finding"), FINDING_SLOW("finding-slow"), FOUND("found"), STARTING("starting"),
        ADVANCING("advancing"), ADVANCING_SKIP("advancing-skip"), FAILED("failed"),
    }

    enum class RowState { WAITING, CHECKING, STARTING, PLAYING, SKIPPED, FAILED }

    /** The fixed set of reasons a row did not play. */
    object Reason {
        const val NO_ANSWER = "no answer in 8s"
        const val NO_PICTURE = "no picture in 20s"
        const val UNSUPPORTED = "won't play on this device"
        const val EXPIRED = "link expired"
        const val STOPPED = "stopped loading"
        const val SERVER = "server error"
        const val NOT_FOUND = "not found"
        const val NOT_TELUGU = "not Telugu"
    }

    /** A search-phase row: the backend call or one on-device resolver. `found` null while it runs. */
    data class Check(val id: String, val label: String, val startedAt: Long, val endedAt: Long? = null, val found: Int? = null)

    /** One source put on screen. Open while `endedAt` is null. */
    data class Attempt(val id: String, val startedAt: Long, val endedAt: Long? = null, val state: RowState = RowState.STARTING, val reason: String? = null)

    data class Input(
        val now: Long,
        val playAt: Long,
        val title: String,
        val preferred: String = "Telugu",
        /** null until the source list exists. */
        val sources: List<Source>?,
        val labels: Map<String, String>,
        val firstListSize: Int,
        val attempts: List<Attempt>,
        val checks: List<Check>,
        val framed: Boolean,
        val failed: Boolean,
        /** End-card detail when nothing was tried (no list, server unreachable). */
        val failMessage: String = "",
    )

    data class Row(
        val id: String,
        val title: String,
        val status: String,
        val state: RowState,
        val clickable: Boolean,
        /** TalkBack text: the same words as the web row button. */
        val description: String,
    )

    data class View(
        val phase: Phase,
        val headline: String,
        val detail: String,
        val showChooser: Boolean,
        val showTryAgain: Boolean,
        val rows: List<Row>,
        val footer: String,
    )

    data class RetryPlan(val refresh: Boolean, val keepDevice: Boolean)

    /** Search-phase Try again re-asks the server only; on the end card it is a full refresh. */
    fun retryPlan(failed: Boolean): RetryPlan = if (failed) RetryPlan(refresh = true, keepDevice = false) else RetryPlan(refresh = false, keepDevice = true)

    fun advanceNotice(from: String, to: String, skip: Boolean): String =
        if (skip) "$from won't play on this device. Trying $to." else "$from is slow. Trying $to."

    fun reasonFor(httpCode: Int?, decoder: Boolean): String = when {
        decoder -> Reason.UNSUPPORTED
        httpCode == 403 || httpCode == 410 -> Reason.EXPIRED
        httpCode == 404 -> Reason.NOT_FOUND
        httpCode != null && httpCode >= 500 -> Reason.SERVER
        else -> Reason.STOPPED
    }

    /**
     * One stable label per row id over the full list, dead rows included: a
     * label never changes during a start. New rows of a provider that already
     * has a label are numbered after it ("showsst" then "showsst 2").
     */
    fun labelRows(prev: Map<String, String>, all: List<Source>): Map<String, String> {
        val out = LinkedHashMap(prev)
        val fresh = all.filter { it.id !in out }
        for ((provider, rows) in fresh.groupBy { it.provider }) {
            val numbered = Regex("^" + Regex.escape(provider) + "( \\d+)?$")
            val existing = out.values.count { numbered.matches(it) }
            if (existing == 0 && rows.size == 1) { out[rows[0].id] = provider; continue }
            rows.forEachIndexed { i, s -> out[s.id] = "$provider ${existing + i + 1}" }
        }
        return out
    }

    /** The language that will play: the preferred one when the row has it, else its first. */
    fun langOf(s: Source, preferred: String): String? =
        s.languages.firstOrNull { it.equals(preferred, true) } ?: s.languages.firstOrNull { it.isNotBlank() }

    private fun qualityOf(s: Source): String? = Ranking.height(s).takeIf { it > 0 }?.let { "${it}p" }

    private fun secs(ms: Long): Long = (ms.coerceAtLeast(0)) / 1000
    private fun secs1(ms: Long): String = String.format(Locale.US, "%.1f", ms.coerceAtLeast(0) / 1000.0)

    fun view(i: Input): View {
        val t = i.now - i.playAt
        val list = i.sources
        val labels = i.labels
        fun label(id: String) = labels[id] ?: list?.firstOrNull { it.id == id }?.provider ?: id
        val n = if (i.firstListSize > 0) i.firstListSize else list?.size ?: 0
        val more = (list?.size ?: 0) - n
        val k = i.attempts.size
        val tried = "$k of $n tried" + if (more > 0) " · $more more found" else ""

        val rows = if (list == null) checkRows(i) else sourceRows(i, list, ::label)
        val footer = "Started ${secs(t)}s ago" + if (list != null) " · $k of $n tried" else ""

        if (i.failed) {
            val distinct = i.attempts.map { it.id }.distinct().size
            val detail = if (distinct > 0) "We tried $distinct sources. None of them played." else i.failMessage.ifEmpty { "No playable source found." }
            return View(Phase.FAILED, "Couldn't start ${i.title}", detail, showChooser = false, showTryAgain = true, rows = rows, footer = footer)
        }
        if (list == null) {
            val slow = t >= LOADING_SLOW_HINT_MS
            val detail = if (slow) "First play of a title can take up to a minute." else "${i.preferred} first" + if (t >= 5_000) " · ${secs(t)}s" else ""
            return View(
                if (slow) Phase.FINDING_SLOW else Phase.FINDING,
                if (slow) "Still finding sources…" else "Finding sources…",
                detail, showChooser = false, showTryAgain = t >= LOADING_RETRY_MS, rows = rows, footer = footer,
            )
        }
        val chooser = !i.framed && t >= LOADING_CHOOSER_MS
        val cur = i.attempts.lastOrNull()
        if (cur == null) {
            val inLang = list.count { s -> s.languages.any { it.equals(i.preferred, true) } }
            return View(Phase.FOUND, "Found ${list.size} sources", "$inLang in ${i.preferred}", chooser, false, rows, footer)
        }
        val s = list.firstOrNull { it.id == cur.id }
        val facts = listOfNotNull(s?.let { langOf(it, i.preferred) }, s?.let { qualityOf(it) })
        val prev = i.attempts.dropLast(1).lastOrNull()
        if (prev == null) return View(Phase.STARTING, "Starting ${label(cur.id)}", facts.joinToString(" · "), chooser, false, rows, footer)
        val skip = prev.reason == Reason.UNSUPPORTED
        return View(
            if (skip) Phase.ADVANCING_SKIP else Phase.ADVANCING,
            advanceNotice(label(prev.id), label(cur.id), skip),
            (facts + tried).joinToString(" · "), chooser, false, rows, footer,
        )
    }

    private fun checkRows(i: Input): List<Row> = i.checks.map { c ->
        val status = when {
            c.endedAt == null -> "Checking… ${secs(i.now - c.startedAt)}s"
            (c.found ?: 0) == 0 -> "nothing found · ${secs1(c.endedAt - c.startedAt)}s"
            else -> "${c.found} link${if (c.found == 1) "" else "s"} · ${secs1(c.endedAt - c.startedAt)}s"
        }
        Row(c.id, c.label, status, if (c.endedAt == null) RowState.CHECKING else RowState.WAITING, clickable = false, description = describe(c.label, status))
    }

    private fun sourceRows(i: Input, list: List<Source>, label: (String) -> String): List<Row> {
        // Latest attempt per id, in the order rows were first tried; then the rest in list order.
        val latest = LinkedHashMap<String, Attempt>()
        for (a in i.attempts) { latest.remove(a.id); latest[a.id] = a }
        val firstTry = i.attempts.map { it.id }.distinct()
        val byId = list.associateBy { it.id }
        val order = firstTry.filter { it in byId } + list.map { it.id }.filter { it !in latest }
        return order.map { id ->
            val s = byId.getValue(id)
            val title = listOfNotNull(label(id), langOf(s, i.preferred), qualityOf(s)).joinToString(" · ")
            val a = latest[id]
            val (state, status) = when {
                a == null && s.unsupported -> RowState.SKIPPED to "Skipped: ${Reason.UNSUPPORTED}"
                a == null -> RowState.WAITING to "Waiting"
                a.endedAt == null -> RowState.STARTING to "Starting… ${secs(i.now - a.startedAt)}s"
                a.state == RowState.PLAYING -> RowState.PLAYING to "Playing · ${secs1(a.endedAt - a.startedAt)}s to start"
                a.state == RowState.SKIPPED -> RowState.SKIPPED to "Skipped: ${a.reason ?: Reason.UNSUPPORTED}"
                else -> RowState.FAILED to "Failed: ${a.reason ?: Reason.STOPPED} · ${secs(a.endedAt - a.startedAt)}s"
            }
            val clickable = when (state) {
                RowState.WAITING, RowState.FAILED -> !s.unsupported
                RowState.SKIPPED -> !s.unsupported && a?.reason != Reason.UNSUPPORTED
                else -> false
            }
            Row(id, title, status, state, clickable, describe(title, status))
        }
    }

    /** "CastleTV 2 · Telugu · 1080p" + "Failed: … 20s" -> "CastleTV 2, Telugu, 1080p, failed: … 20 seconds". */
    private fun describe(title: String, status: String): String {
        val words = status.replaceFirstChar { it.lowercase() }.replace(Regex("""(\d+(?:\.\d)?)s\b"""), "$1 seconds")
        return title.split(" · ").joinToString(", ") + ", " + words
    }
}
