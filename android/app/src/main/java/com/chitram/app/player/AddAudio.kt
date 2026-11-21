package com.chitram.app.player

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.PairOutcome
import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * "Add <L> audio from another server" (Step 2, 2026-11-21), server-fused path.
 * Same offer, donor and cap rules as web/lib/player/addAudio.js. Pure model: the
 * player (PlayerVm) does the side effects. Donors are never pre-validated: a try
 * IS the check (POST /hybrid/pair with `language`).
 *
 * Task 6: the on-device merge (media3 MergingMediaSource) is a second path
 * inside the same run. A donor goes there when the server is Unreachable
 * (network, 5xx, per-try timeout), or at once when either half was resolved on
 * this device (the server has no headers for it). A Refused answer never does.
 * Rows resolved on this device are donors only on that path (`onDevicePath`).
 */
object AddAudio {
    private const val TELUGU = "telugu"

    /**
     * What was on screen before the run's first pair: restored at once when a pair
     * fails on the device. [owner]: the run whose fused pair this was, if any.
     */
    data class Fallback(val source: Source, val audioLanguage: String?, val positionMs: Long, val pairedAudio: Source? = null, val owner: Run? = null,
        /** [pairedAudio] was in a server-fused master; false for an on-device merge. */
        val fused: Boolean = pairedAudio != null)

    /**
     * A donor to play. [ok]: the server's fused master; null for the on-device
     * merge (picture row + donor row, both with their own headers).
     */
    data class Hit(val donor: Source, val ok: PairOutcome.Ok?) {
        val onDevice: Boolean get() = ok == null
    }

    /** Either half was resolved on this device: the server cannot fetch it, so the merge is on the device. */
    fun deviceResolved(picture: Source, donor: Source): Boolean = picture.onDevice != null || donor.onDevice != null

    /**
     * One add-audio journey. It owns every donor it tried (failed or played),
     * so the ADD_AUDIO_MAX_TRIES cap holds across a device-failure continuation,
     * and the start time, so the ADD_AUDIO_TOTAL_MS budget does too.
     */
    class Run(
        val language: String,
        donors: List<Source>,
        /** The picture row the donor audio goes under (never a fused copy). */
        val picture: Source,
        val startedAt: Long,
        val totalMs: Long = LoadingModel.ADD_AUDIO_TOTAL_MS,
        val tryMs: Long = LoadingModel.ADD_AUDIO_TRY_MS,
    ) {
        val pool: List<Source> = donors.take(LoadingModel.ADD_AUDIO_MAX_TRIES)
        private val triedIds = LinkedHashSet<String>()
        val tried: Set<String> get() = triedIds
        /** Set at the run's first success: the stream to restore on final failure. */
        var pairFallback: Fallback? = null
        /** The pair on screen (or about to be). */
        var hit: Hit? = null
        /**
         * The run's saved position: the tap position, then the restore point after a
         * device failure. Used only while the current stream has not loaded (web
         * rule); a loaded stream's live position always wins, a backward seek included.
         */
        var resumeMs: Long = 0
        /** True once a device failure restored the old stream: its notices must outlive that stream's READY. */
        var restored = false
        /** Every answer, by donor id. A per-try timeout is Unreachable (Task 6 falls back to the device on it). */
        val outcomes = LinkedHashMap<String, PairOutcome>()
        /** On-device merge tries, by donor id: true when the duration gate passed. */
        val deviceOutcomes = LinkedHashMap<String, Boolean>()
        /**
         * The run's pair reached READY on the device (web landed()). From then on
         * the run is over: a later failure of that stream is normal recovery (I2).
         */
        var landed = false
        /** Last "Checking … (n of total)" line, repeated on a second tap. */
        var checking: String? = null
        @Volatile var cancelled = false; private set
        @Volatile private var inFlight = false

        /** Claims a donor before any suspension, so two triggers never try it twice. */
        @Synchronized fun claim(d: Source): Boolean = triedIds.add(d.id)
        @Synchronized internal fun begin(): Boolean = if (inFlight || cancelled) false else { inFlight = true; true }
        @Synchronized internal fun end() { inFlight = false }
        val busy: Boolean get() = inFlight

        /** The viewer left, picked something else, or the title changed: no late result may apply. */
        fun cancel() { cancelled = true }

        /** Donors not yet tried, within the cap; empty when the budget is spent. */
        fun remaining(now: Long): List<Source> {
            if (cancelled || now - startedAt >= totalMs) return emptyList()
            return pool.filter { it.id !in triedIds }.take((LoadingModel.ADD_AUDIO_MAX_TRIES - triedIds.size).coerceAtLeast(0))
        }
    }

    private fun langs(s: Source): List<String> = AudioChoice.languages(s)

    /**
     * Rows that can lend [language] to [playing] via /hybrid/pair. Web order
     * (addAudio.js donorsFrom, I4): rows whose rendition in [language] has a uri
     * first, index order inside each group, then the cap.
     */
    private fun donorsFrom(rows: List<Source>, language: String, playing: Source?, failed: Set<String>, onDevicePath: Boolean): List<Source> {
        val ok = rows.filter {
            it.id != playing?.id && !it.unsupported && !it.hybrid && it.selectableAudio && (onDevicePath || it.onDevice == null) &&
                // The server refuses a same-provider pair.
                !(playing != null && it.provider.equals(playing.provider, true)) &&
                it.id !in failed
        }
        val (withUri, rest) = ok.partition { r -> r.uriLanguages.any { Ranking.sameLanguage(it, language) } }
        return (withUri + rest).take(LoadingModel.ADD_AUDIO_MAX_TRIES)
    }

    /**
     * [onDevicePath]: the on-device merge is available, so rows resolved on this
     * device are donors too. AUDIO_HALVES (H13) does not limit these donors.
     */
    fun donors(sources: List<Source>, language: String, current: Source?, failed: Set<String> = emptySet(), onDevicePath: Boolean = false): List<Source> {
        val rows = AudioChoice.index(sources).entries.firstOrNull { Ranking.sameLanguage(it.key, language) }?.value.orEmpty()
        return donorsFrom(rows, language, current, failed, onDevicePath)
    }

    /**
     * One offer per language another server carries and the playing stream does
     * not. [carried]: the live audio tracks' languages; empty means not known yet,
     * then the playing row's own languages. No cap on offers. Telugu first, then
     * index order.
     */
    fun offers(sources: List<Source>, current: Source?, carried: Set<String>, onDevicePath: Boolean = false): List<Pair<String, List<Source>>> {
        val have = carried.mapNotNull(Ranking::canonLang).toSet()
            .ifEmpty { current?.let(::langs).orEmpty().mapNotNull(Ranking::canonLang).toSet() }
        val index = AudioChoice.index(sources)
        val keys = index.keys.filter { Ranking.canonLang(it) !in have }
            .sortedBy { if (Ranking.canonLang(it) == TELUGU) 0 else 1 }
        return keys.mapNotNull { lang -> donorsFrom(index.getValue(lang), lang, current, emptySet(), onDevicePath).takeIf { it.isNotEmpty() }?.let { lang to it } }
    }

    /** Can the device play the fused master? Unknown codecs count as yes (the device check is the play). */
    fun decodes(ok: PairOutcome.Ok, codecs: CodecSupport, audioDecoders: Set<String>?): Boolean {
        val c = ok.codecs ?: return true
        val video = c.video.filter { it.isNotBlank() }
        val videoOk = video.isEmpty() || video.any { codecs.supports(null, it) != false }
        return videoOk && HybridPair.audioDecodes(c.audio, audioDecoders)
    }

    /**
     * Try the run's remaining donors in order until one is accepted. Each try is
     * bounded by min(tryMs, budget left); a Refused, Unreachable, throw, timeout
     * or undecodable answer is a failed donor. Only one call per run runs at a
     * time: a second trigger while one is in flight gets null at once. A run
     * cancelled while a try is out returns null, never a late hit.
     *
     * [device] (Task 6): the on-device merge try for one donor (decoders and the
     * duration gate; true = merge it). It runs for the same donor when the server
     * is Unreachable, and instead of the server when either half was resolved on
     * this device. It is bounded like a server try (min(tryMs, budget left)) and
     * counts against the same donor cap and total budget.
     */
    suspend fun run(
        run: Run,
        tryOne: suspend (Source) -> PairOutcome,
        onTry: (Source, Int, Int) -> Unit,
        clock: () -> Long = System::currentTimeMillis,
        accept: (PairOutcome.Ok) -> Boolean = { true },
        device: (suspend (Source) -> Boolean)? = null,
    ): Hit? {
        if (!run.begin()) return null
        try {
            while (true) {
                val left = run.remaining(clock())
                val donor = left.firstOrNull() ?: return null
                val budget = run.totalMs - (clock() - run.startedAt)
                if (budget <= 0) return null
                if (!run.claim(donor)) continue
                val n = run.tried.size
                onTry(donor, n, n + left.size - 1)
                val onDeviceOnly = device != null && deviceResolved(run.picture, donor)
                if (!onDeviceOnly) {
                    val out = try {
                        withTimeoutOrNull(minOf(run.tryMs, budget)) { tryOne(donor) } ?: PairOutcome.Unreachable("timeout")
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        PairOutcome.Unreachable(e.javaClass.simpleName)
                    }
                    synchronized(run) { run.outcomes[donor.id] = out }
                    if (run.cancelled) return null
                    if (out is PairOutcome.Ok && accept(out)) return Hit(donor, out)
                    // Only an outage falls back to the device; a Refused (or undecodable) donor is done.
                    if (device == null || out !is PairOutcome.Unreachable) continue
                }
                val deviceBudget = run.totalMs - (clock() - run.startedAt)
                if (deviceBudget <= 0) return null
                val merge = try {
                    withTimeoutOrNull(minOf(run.tryMs, deviceBudget)) { device!!(donor) } ?: false
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    false
                }
                synchronized(run) { run.deviceOutcomes[donor.id] = merge }
                if (run.cancelled) return null
                if (merge) return Hit(donor, null)
            }
        } finally {
            run.end()
        }
    }

    /** The fused master as a playable row: the picture's identity, the server's url, no device headers. */
    fun fusedSource(picture: Source, hit: Hit, language: String): Source = picture.copy(
        url = requireNotNull(hit.ok) { "an on-device hit has no fused master" }.url, progressive = false, hybrid = true, headers = emptyMap(), segmentToken = null, onDevice = null,
        selectableAudio = true,
        languages = (listOf(language) + picture.languages).distinctBy { Ranking.canonLang(it) ?: it.lowercase() },
        audioLanguages = (listOf(language) + (picture.audioLanguages ?: picture.languages)).distinctBy { Ranking.canonLang(it) ?: it.lowercase() },
        codecString = hit.ok.codecs?.let { (it.video + listOfNotNull(it.audio)).joinToString(",") } ?: picture.codecString,
    )

    /**
     * The row to play for [hit]: the fused master, or for an on-device merge the
     * picture row itself (the donor goes in as `pairAudio`). Never the donor row.
     */
    fun pairSource(picture: Source, hit: Hit, language: String): Source =
        if (hit.ok != null) fusedSource(picture, hit, language) else picture

    /** What the player shows and plays now (PlayerVm fills it; tests build it by hand). */
    data class Screen(
        val current: Source?,
        val pairedAudio: Source? = null,
        val fused: Boolean = false,
        val audioLanguage: String? = null,
        val positionMs: Long = 0,
        val offline: Boolean = false,
        /** The player has loaded the current stream (READY, or duration known). Its position is real only then. */
        val loaded: Boolean = true,
        /** The player is READY now. A notice is held for the next READY only while it is not. */
        val ready: Boolean = true,
    )

    /** Web rule: the live position when the current stream has loaded and moved, else the run's saved one. */
    fun positionFor(screen: Screen, run: Run): Long =
        if (screen.loaded && screen.positionMs > 0) screen.positionMs else run.resumeMs

    /** What PlayerVm must do. It does nothing else for this journey. */
    sealed interface Effect {
        /** [untilReady]: say it again when the new stream is ready (READY clears notices). */
        data class Notice(val text: String, val untilReady: Boolean = false) : Effect
        /** Run [run]'s donor check in the background (one job; replaces any other). */
        data class Check(val run: Run, val gen: Int) : Effect
        /** Stop the background check job: its result must never apply. */
        data object CancelCheck : Effect
        /**
         * Drop any notice held for READY, and take down [stale] if it is the one on
         * screen (a cancelled check's "Checking…"). Sent on every pick, title
         * change, offline and leave, so no held notice comes back later.
         */
        data class ClearHeld(val stale: String?) : Effect
        /** Play the fused master of [hit] under [run]'s picture, in the run's language, at [positionMs]. */
        data class PlayPair(val run: Run, val hit: Hit, val positionMs: Long) : Effect
        /** Put back what played before the run, at [positionMs]. */
        data class Restore(val fallback: Fallback, val positionMs: Long) : Effect
        /** No fallback known (should not happen): the picture row alone. Never the donor. */
        data class PictureOnly(val picture: Source, val positionMs: Long) : Effect
    }

    /**
     * The journey's rules, one per player. PlayerVm is a thin adapter: it calls
     * one method per event and runs the effects. [active] is the run whose check
     * is in flight; [onScreen] the run whose fused pair is playing. [gen] changes
     * whenever a check is cancelled, so a late answer never applies.
     */
    class Journey(
        private val clock: () -> Long = System::currentTimeMillis,
        /** Task 6: the player can merge on the device, so device-resolved rows are donors and get offers. */
        private val onDevicePath: Boolean = true,
    ) {
        var active: Run? = null; private set
        var onScreen: Run? = null; private set
        var gen = 0; private set

        private fun cancelActive(): List<Effect> {
            val run = active ?: return emptyList()
            run.cancel()
            active = null
            gen++
            return listOf(Effect.CancelCheck)
        }

        /** The pair on screen is this journey's: same donor, and fused or merged on the device as the hit says. */
        private fun pairOnScreen(screen: Screen): Run? = onScreen?.takeIf {
            val hit = it.hit
            hit != null && hit.donor.id == screen.pairedAudio?.id && screen.fused == (hit.ok != null)
        }

        /** The viewer tapped "Add <L> audio from another server". */
        fun tap(language: String, sources: List<Source>, screen: Screen): List<Effect> {
            if (screen.offline) return emptyList() // the offline notice stays; nothing can be checked
            // The same entry again: one check at a time, repeat where it is. That
            // includes the run's pair still loading (fused or an on-device merge, M4).
            val same = { run: Run -> Ranking.sameLanguage(run.language, language) || run.language.equals(language, true) }
            active?.let { run -> if (same(run)) return run.checking?.let { listOf(Effect.Notice(it)) }.orEmpty() }
            pairOnScreen(screen)?.let { run ->
                if (active == null && !run.landed && same(run)) return run.checking?.let { listOf(Effect.Notice(it)) }.orEmpty()
            }
            val out = ArrayList(cancelActive()) // another add: entry is a new pick
            val prior = pairOnScreen(screen)
            val picture = prior?.picture ?: screen.current ?: return out
            val donors = donors(sources, language, picture, onDevicePath = onDevicePath)
            if (donors.isEmpty()) return out + Effect.Notice(LoadingModel.Copy.noWorkingAudio(language))
            val run = Run(language, donors, picture, clock())
            run.resumeMs = screen.positionMs.coerceAtLeast(0)
            active = run
            return out + Effect.Check(run, ++gen)
        }

        /**
         * A donor try starts ("Checking … (n of total)…"). Nothing for a stale check.
         * After a restore it must outlive the restored stream's READY.
         */
        fun checking(gen: Int, run: Run, text: String, screen: Screen): List<Effect> {
            run.checking = text
            if (gen != this.gen || active !== run) return emptyList()
            return listOf(Effect.Notice(text, untilReady = run.restored && !screen.ready))
        }

        /** Any other viewer pick (in-stream track, server, language): stop a check. A pair on screen stays. */
        fun pick(): List<Effect> = clearHeld(cancelActiveKeepingText())

        /** Title or episode change, or the viewer left the player: forget everything. */
        fun drop(): List<Effect> { val out = clearHeld(cancelActiveKeepingText()); onScreen = null; return out }

        /** The network dropped: stop the check; no failure notice over the offline one. */
        fun offline(): List<Effect> = clearHeld(cancelActiveKeepingText())

        private fun cancelActiveKeepingText(): Pair<List<Effect>, String?> {
            val text = active?.checking
            return cancelActive() to text
        }

        private fun clearHeld(c: Pair<List<Effect>, String?>): List<Effect> = c.first + Effect.ClearHeld(c.second)

        /** Another picture is about to play (failover, a pick): nothing of this journey applies to it. */
        fun otherPicture(id: String): List<Effect> {
            val out = if (active != null && active?.picture?.id != id) cancelActive() else emptyList()
            if (onScreen != null && onScreen?.picture?.id != id) onScreen = null
            return out
        }

        /**
         * A check ended. It applies only when it is still the current check of the
         * current picture and the device is online. Success plays the pair and
         * says so; a spent run says nothing worked (playback is as it was).
         */
        fun result(gen: Int, run: Run, hit: Hit?, screen: Screen, label: (Source) -> String): List<Effect> {
            if (gen != this.gen || active !== run || run.cancelled) return emptyList()
            if (screen.offline) return cancelActive()
            if (screen.current?.id != run.picture.id) return cancelActive()
            active = null
            if (hit == null) return listOf(Effect.Notice(LoadingModel.Copy.noWorkingAudio(run.language), untilReady = run.restored && !screen.ready))
            if (run.pairFallback == null) screen.current?.let {
                // A pair on screen (fused or merged on the device) comes back as it was.
                run.pairFallback = Fallback(it, screen.audioLanguage, positionFor(screen, run),
                    screen.pairedAudio, pairOnScreen(screen), fused = screen.pairedAudio != null && screen.fused)
            }
            run.hit = hit
            onScreen = run
            return listOf(Effect.PlayPair(run, hit, positionFor(screen, run)), Effect.Notice(LoadingModel.Copy.audioAdded(run.language, label(hit.donor)), untilReady = true))
        }

        /**
         * The player reached READY. If it is this journey's pair, the pair has
         * landed: the run is over (web landed()).
         */
        fun ready(screen: Screen) {
            pairOnScreen(screen)?.let { it.landed = true }
        }

        /**
         * The device failed to play the pair on screen. Null when it is not this
         * journey's pair, or when that pair already reached READY (I2: then the
         * player's normal recovery and failover run, never the add-audio restore). Otherwise: restore what played before at once (stream,
         * position, audio), then check the next donor behind it inside the same
         * caps; with none left, say nothing worked. Never the donor alone.
         */
        fun deviceFailure(screen: Screen): List<Effect>? {
            val run = pairOnScreen(screen) ?: return null
            if (run.landed) {
                onScreen = null
                return null
            }
            // Offline the player waits for the network (PlayerVm goOffline); nothing is restored or checked.
            if (screen.offline) return emptyList()
            val out = ArrayList<Effect>()
            if (active != null && active !== run) out += cancelActive()
            val fb = run.pairFallback
            onScreen = fb?.owner
            // Where the failed pair got to, if it loaded; else the run's saved point.
            val at = if (screen.loaded && screen.positionMs > 0) screen.positionMs else run.resumeMs.takeIf { it > 0 } ?: fb?.positionMs ?: 0
            run.resumeMs = at
            run.restored = true
            out += if (fb != null) Effect.Restore(fb, at) else Effect.PictureOnly(run.picture, at)
            // The restored stream reaches READY after this: the notice must survive it.
            if (run.remaining(clock()).isEmpty()) return out + Effect.Notice(LoadingModel.Copy.noWorkingAudio(run.language), untilReady = true)
            active = run
            out += Effect.Check(run, ++gen)
            return out
        }
    }
}
