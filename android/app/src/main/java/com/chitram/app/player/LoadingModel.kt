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
    /** 0 rows this long after Play ends the search with the no-sources card (owner 2026-11-24). */
    const val NO_SOURCE_CAP_MS = 45_000L

    /**
     * The search for rows is over: 0 rows and every path (VM, on-device, background
     * mapple) has finished, or [NO_SOURCE_CAP_MS] passed. Any row keeps it going.
     */
    fun noSourceEnd(elapsedMs: Long, rows: Int, pathsActive: Boolean): Boolean = rows == 0 && (!pathsActive || elapsedMs >= NO_SOURCE_CAP_MS)

    /**
     * Caps for "Add <L> audio from another server" (Step 2, 2026-11-21): at most
     * 3 donor servers, 15s per try, 30s for the whole journey. Same names and
     * values in web/lib/player/loadingModel.js.
     */
    const val ADD_AUDIO_MAX_TRIES = 3
    const val ADD_AUDIO_TRY_MS = 15_000L
    const val ADD_AUDIO_TOTAL_MS = 30_000L

    const val CHECK_SERVER = "check:server"
    const val CHECK_MAPPLE = "check:mapple"
    const val CHECK_VAPLAYER = "check:vaplayer"

    enum class Phase(val key: String) {
        FINDING("finding"), FINDING_SLOW("finding-slow"), FOUND("found"), STARTING("starting"),
        SWITCHING("switching"), ADVANCING("advancing"), ADVANCING_SKIP("advancing-skip"), FAILED("failed"),
    }

    /**
     * LEFT: the viewer picked another server while this row was starting.
     * Neutral: not a failure, not counted in "N of M tried" or "We tried N".
     */
    enum class RowState { WAITING, CHECKING, STARTING, PLAYING, SKIPPED, FAILED, LEFT }

    /**
     * Every loading and switch line the viewer reads, word for word the same as
     * web `Copy` in web/lib/player/loadingModel.js (Task 9, 2026-11-21).
     *
     * No line says "slow": the player cannot tell a slow source from a dead one
     * (it sees only "no answer in 8s" or "no picture in 20s"), and the owner read
     * "slow" on almost every switch while the server was fine.
     */
    object Copy {
        /** Failure card: every source was tried and none played. */
        const val COULDNT_PLAY = "Couldn't play any source"
        /** Failure card: the search ended with no source at all. */
        fun noSources(title: String) = if (title.isBlank()) "No sources found" else "No sources found for $title"
        /** Failure card actions: re-resolve now (a tap skips the refresh cooldown) and open the server list. */
        const val TRY_AGAIN = "Try again"
        const val PICK_SOURCE = "Pick a source"
        /** A server switch the viewer asked for is in flight. */
        const val SWITCHING_SERVER = "Switching server…"
        /** The source list is still on its way. */
        const val FINDING = "Finding sources…"
        /** The source list took longer than LOADING_SLOW_HINT_MS, with no switch in flight. */
        const val FINDING_SLOW = "Still finding sources…"
        const val FINDING_SLOW_DETAIL = "First play of a title can take up to a minute."
        /** Row status: the viewer picked another server while this one was starting. */
        const val ROW_LEFT = "Left"
        /** Names used when a row has no label. */
        const val FROM_FALLBACK = "That server"
        const val TO_FALLBACK = "the next server"
        /** A source gave no picture in time and the player moves on by itself. */
        fun didntStart(from: String, to: String) = "$from didn't start. Trying $to."
        /** A source that was playing failed mid-film and the player moves on. */
        fun stopped(from: String, to: String) = "$from stopped. Trying $to."
        /** The device cannot decode the source. */
        fun wontPlay(from: String, to: String) = "$from won't play on this device. Trying $to."
        /** A language pick landed on a server that plays, but without that language (I2). */
        fun noLanguage(from: String, lang: String, to: String) = "$from has no $lang audio. Trying $to."
        /** Add <L> audio from another server (Step 2): the Details group heading. */
        const val ADD_AUDIO_GROUP = "Add audio from another server"
        /** One row per missing language under ADD_AUDIO_GROUP. */
        fun addAudio(lang: String) = "Add $lang audio from another server"
        /** A donor server is being checked; n of total donors (total <= ADD_AUDIO_MAX_TRIES). */
        fun checkingAudio(lang: String, server: String, n: Int, total: Int) = "Checking $server for $lang audio ($n of $total)…"
        /** The pair plays: the language now comes from the donor server. */
        fun audioAdded(lang: String, server: String) = "$lang audio added from $server."
        /** Every donor failed or the caps ran out; the previous stream is back. */
        fun noWorkingAudio(lang: String) = "No server has working $lang audio. Playback is unchanged."
    }

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
        /**
         * True while a server switch the VIEWER asked for is in flight. It wins
         * over the slow hint and the advance notice: the wait is the switch.
         */
        val switching: Boolean = false,
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
        /** Kept for the old failure card; the end card now shows Try again (showTryAgain) instead. */
        val showRefresh: Boolean = false,
        /** End card with rows that all failed: "Pick a source" opens the server list. */
        val showPickSource: Boolean = false,
    )

    enum class Focus { DETAILS, REFRESH }

    /** Where TV focus starts: Try again on the end card, Details while loading. */
    fun tvFocus(v: View): Focus = if (v.phase == Phase.FAILED) Focus.REFRESH else Focus.DETAILS

    data class RetryPlan(val refresh: Boolean, val keepDevice: Boolean)

    /** Search-phase Try again re-asks the server only; on the end card it is a full refresh. */
    fun retryPlan(failed: Boolean): RetryPlan = if (failed) RetryPlan(refresh = true, keepDevice = false) else RetryPlan(refresh = false, keepDevice = true)

    /**
     * The one-line notice when the player moves from one source to the next by
     * itself. `skip`: the device cannot decode it. `missingLang`: it played, but
     * not in the language the viewer picked. `stopped`: it was playing and died
     * mid-film. Otherwise it failed to start.
     */
    fun advanceNotice(from: String?, to: String?, skip: Boolean, stopped: Boolean = false, missingLang: String? = null): String {
        val a = from?.takeIf { it.isNotEmpty() } ?: Copy.FROM_FALLBACK
        val b = to?.takeIf { it.isNotEmpty() } ?: Copy.TO_FALLBACK
        return when {
            skip -> Copy.wontPlay(a, b)
            missingLang != null -> Copy.noLanguage(a, missingLang, b)
            stopped -> Copy.stopped(a, b)
            else -> Copy.didntStart(a, b)
        }
    }

    /**
     * The notice when the failed row `failedId` gives way to the next one.
     * "stopped" only when that row's latest attempt rendered a frame (ended
     * PLAYING); otherwise it failed to start. Looks up the row by id, so an
     * attempt for the next row added after it does not change the answer.
     */
    fun failNotice(attempts: List<Attempt>, failedId: String?, from: String?, to: String?, skip: Boolean, missingLang: String? = null): String {
        val stopped = failedId != null && attempts.lastOrNull { it.id == failedId }?.state == RowState.PLAYING
        return advanceNotice(from, to, skip, stopped, missingLang)
    }

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
        s.languages.firstOrNull { Ranking.sameLanguage(it, preferred) } ?: s.languages.firstOrNull { it.isNotBlank() }

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
        // A row the viewer left by picking another server was not tried.
        val triedAttempts = i.attempts.filter { it.state != RowState.LEFT }
        val k = triedAttempts.size
        val tried = "$k of $n tried" + if (more > 0) " · $more more found" else ""

        val rows = if (list == null) checkRows(i) else sourceRows(i, list, ::label)
        val footer = "Started ${secs(t)}s ago" + if (list != null) " · $k of $n tried" else ""

        if (i.failed) {
            val distinct = triedAttempts.map { it.id }.distinct().size
            val detail = if (distinct > 0) "We tried $distinct sources. None of them played." else i.failMessage.ifEmpty { "No playable source found." }
            // Rows tried and none played: "Couldn't play any source" + Pick a source. Nothing tried
            // (no rows, or late rows after the card): "No sources found for <title>". Both: Try again, Back.
            val none = distinct == 0
            val headline = if (none) Copy.noSources(i.title) else Copy.COULDNT_PLAY
            return View(Phase.FAILED, headline, detail, showChooser = false, showTryAgain = true, rows = rows, footer = footer, showPickSource = !none)
        }
        val chooser = list != null && !i.framed && t >= LOADING_CHOOSER_MS
        val cur = i.attempts.lastOrNull()
        if (i.switching) {
            val target = cur?.let { c -> list?.firstOrNull { it.id == c.id } }
            val facts = listOfNotNull(target?.let { langOf(it, i.preferred) }, target?.let { qualityOf(it) })
            val detail = (facts + if (list != null && k > 0) listOf(tried) else emptyList()).joinToString(" · ")
            return View(Phase.SWITCHING, Copy.SWITCHING_SERVER, detail, chooser, false, rows, footer)
        }
        if (list == null) {
            val slow = t >= LOADING_SLOW_HINT_MS
            val detail = if (slow) Copy.FINDING_SLOW_DETAIL else "${i.preferred} first" + if (t >= 5_000) " · ${secs(t)}s" else ""
            return View(
                if (slow) Phase.FINDING_SLOW else Phase.FINDING,
                if (slow) Copy.FINDING_SLOW else Copy.FINDING,
                detail, showChooser = false, showTryAgain = t >= LOADING_RETRY_MS, rows = rows, footer = footer,
            )
        }
        if (cur == null) {
            val inLang = list.count { s -> s.languages.any { Ranking.sameLanguage(it, i.preferred) } }
            return View(Phase.FOUND, "Found ${list.size} sources", "$inLang in ${i.preferred}", chooser, false, rows, footer)
        }
        val s = list.firstOrNull { it.id == cur.id }
        val facts = listOfNotNull(s?.let { langOf(it, i.preferred) }, s?.let { qualityOf(it) })
        val prev = i.attempts.dropLast(1).lastOrNull()
        if (prev == null || prev.state == RowState.LEFT) return View(Phase.STARTING, "Starting ${label(cur.id)}", facts.joinToString(" · "), chooser, false, rows, footer)
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
                a.state == RowState.LEFT -> RowState.LEFT to Copy.ROW_LEFT
                a.state == RowState.SKIPPED -> RowState.SKIPPED to "Skipped: ${a.reason ?: Reason.UNSUPPORTED}"
                else -> RowState.FAILED to "Failed: ${a.reason ?: Reason.STOPPED} · ${secs(a.endedAt - a.startedAt)}s"
            }
            val clickable = when (state) {
                RowState.WAITING, RowState.FAILED, RowState.LEFT -> !s.unsupported
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
