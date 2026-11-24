package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay

/**
 * The first source list of a start (cooperative-APK plan, sections 3-4).
 * The VM and the device resolvers run together from t=0. Device-first (owner
 * 2026-11-24): a playable device row in the viewer's language starts the film
 * at once, with no VM lead; the VM rows join late without interrupting. The VM
 * leads only while no device row can play (its rows are then the VM-required
 * providers), never past VM_LEAD_MS when any device row is in hand.
 */
class StartRace(
    private val leadMs: Long = VM_LEAD_MS,
    private val graceMs: Long = PlayerVm.DEVICE_GRACE_MS,
    private val waitMs: Long = PlayerVm.DEVICE_WAIT_MS,
    private val now: () -> Long = System::currentTimeMillis,
    /** Longest the start waits, from Play, for the remembered provider's row (LastPlayed). */
    private val pinWaitMs: Long = PIN_WAIT_MS,
) {
    data class First(
        /** VM rows, ranked by the caller; empty when the VM failed, was skipped or is still pending. */
        val backend: List<Source>,
        val backendError: Exception?,
        /** Device rows that finished in time for the first list. */
        val device: List<Source>,
        /** The VM call is still running: its rows join late. */
        val backendPending: Boolean,
    )

    /** `backend` null: the VM breaker is open, so no VM call went out. */
    @OptIn(ExperimentalCoroutinesApi::class)
    suspend fun first(backend: Deferred<List<Source>>?, device: List<Deferred<Source?>>, preferred: String): First {
        return firstReady(backend, preferred,
            ready = { device.filter { it.isCompleted && !it.isCancelled }.mapNotNull { runCatching { it.getCompleted() }.getOrNull() } },
            allDone = { device.all { it.isCompleted } })
    }

    /**
     * `extras` (first-play fix A): starts the VM-down-only device providers and
     * returns their jobs. Called at most once, when the VM call fails or when the
     * VM lead ends with no playable row in the viewer's language, whichever is
     * first. Its jobs join the race like the others.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    suspend fun firstMany(backend: Deferred<List<Source>>?, device: List<Deferred<List<Source>>>, preferred: String,
                          /**
                           * prewarm.md: jobs (also in [device]) continuing a details-page prewarm.
                           * A good row from one of them starts the film at once, without the VM lead;
                           * the VM call keeps running and its rows join late.
                           */
                          warm: List<Deferred<List<Source>>> = emptyList(),
                          /**
                           * 1.2.52: the job(s) of the provider that last played this title. When the
                           * race is ready before it, the start waits for it at most [pinWaitMs] from
                           * the race start (a kept row lands in milliseconds), never longer.
                           */
                          pinned: List<Deferred<List<Source>>> = emptyList(),
                          extras: ((why: String) -> List<Deferred<List<Source>>>)? = null): First {
        val jobs = device.toMutableList()
        var started = false
        fun startExtras(why: String) {
            if (started || extras == null) return
            started = true
            jobs += extras(why)
        }
        val t0 = now()
        val ready = { jobs.filter { it.isCompleted && !it.isCancelled }.flatMap { runCatching { it.getCompleted() }.getOrDefault(emptyList()) } }
        val first = firstReady(backend, preferred,
            ready = ready,
            allDone = { jobs.all { it.isCompleted } },
            warmReady = { warm.filter { it.isCompleted && !it.isCancelled }.flatMap { runCatching { it.getCompleted() }.getOrDefault(emptyList()) } },
            onLeadNoGood = { startExtras("VM lead over, no ${preferred} row") },
            onVmFailed = { startExtras("VM failed") })
        if (pinned.isEmpty() || pinned.all { it.isCompleted }) return first
        val left = pinWaitMs - (now() - t0)
        if (left <= 0) return first
        val landed = kotlinx.coroutines.withTimeoutOrNull(left) { pinned.forEach { it.join() } } != null
        android.util.Log.i("Chitram", "[race] remembered provider ${if (landed) "landed" else "not ready"} after ${now() - t0}ms")
        return first.copy(device = ready())
    }

    private suspend fun firstReady(backend: Deferred<List<Source>>?, preferred: String, ready: () -> List<Source>, allDone: () -> Boolean,
                                   warmReady: () -> List<Source> = { emptyList() },
                                   onLeadNoGood: () -> Unit = {}, onVmFailed: () -> Unit = {}): First {
        val t0 = now()
        fun good(s: Source) = !s.unsupported && Ranking.tier(s, preferred) <= 2

        // 1. Device-first: a good device row starts the film at once; the VM never holds it.
        // The VM leads only while no device row can play, never past VM_LEAD_MS.
        while (backend != null && !backend.isCompleted) {
            val r = ready()
            if (r.any(::good)) {
                val how = if (warmReady().any(::good)) "prewarmed" else "device"
                android.util.Log.i("Chitram", "[race] $how ${preferred} row ready after ${now() - t0}ms: starting before the VM with ${r.size} device row(s)")
                return First(emptyList(), null, r, backendPending = true)
            }
            val leadOver = now() - t0 >= leadMs
            if (leadOver && !r.any(::good)) onLeadNoGood()
            if (leadOver && (r.any(::good) || (allDone() && r.isNotEmpty()))) {
                android.util.Log.i("Chitram", "[race] VM still out after ${now() - t0}ms: starting with ${r.size} device row(s)")
                return First(emptyList(), null, r, backendPending = true)
            }
            delay(POLL_MS)
        }
        var error: Exception? = null
        val rows = if (backend == null) emptyList() else try { backend.await() } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException && !backend.isCancelled) throw e
            error = e
            emptyList()
        }
        if (error != null) onVmFailed()
        // 2. Device rows: none needed when the VM gave a good row; else wait for a good one (or all, or the budget).
        // A good device row ends the wait at once, even beside non-good VM rows: never hold for every job.
        val haveGood = rows.any(::good)
        val deadline = now() + when {
            haveGood -> 0L
            rows.isEmpty() -> waitMs
            else -> graceMs
        }
        while (now() < deadline && !allDone() && !ready().any(::good)) delay(POLL_MS)
        return First(rows, error, ready(), backendPending = false)
    }

    companion object {
        /** How long a healthy VM leads before a ready device row starts the film. */
        const val VM_LEAD_MS = 5_000L
        private const val POLL_MS = 100L
        /** Owner: the last provider starts first when its row is there; nothing waits for it (~300 ms at most). */
        const val PIN_WAIT_MS = 300L

        /**
         * Same provider from both sides: the VM row shows (demux languages, hybrid,
         * cast-ready URL) and the device row is kept as a hidden twin for a VM
         * failure. Keyed by lowercase provider.
         */
        /**
         * Device-first (owner 2026-11-24): VM rows that land after device rows. A VM row
         * of a provider the device already shows, carrying no language those device rows
         * lack, is the same source: dropped, so the list has no duplicate. A VM row that
         * adds a language (file tags, hybrid) is kept: no audio information is lost.
         * NetMirror catalogs differ by catalog, so only the same url counts there.
         * Returns (kept, dropped).
         */
        fun dropVmDupes(shown: List<Source>, vm: List<Source>): Pair<List<Source>, List<Source>> {
            val device = shown.filter { it.onDevice != null }
            fun langs(s: Source) = (s.audioLanguages ?: s.languages).map { it.lowercase() }.toSet()
            val byProvider = device.groupBy { it.provider.lowercase() }
            val urls = device.map { it.url }.toSet()
            return vm.partition { v ->
                val p = v.provider.lowercase()
                val same = byProvider[p] ?: return@partition true
                if (p == "netmirror") return@partition v.url !in urls
                !same.flatMap(::langs).toSet().containsAll(langs(v))
            }
        }

        /**
         * Greppable route lines for one play: `[route] <provider> device-first` per device
         * provider, then `[route] vm-required: VM asked` or `[route] vm unreachable, device only`.
         */
        fun routeLines(device: List<String>, vmAsked: Boolean): List<String> =
            device.map { "[route] $it device-first" } + if (vmAsked) "[route] vm-required: VM asked for providers the phone cannot resolve" else "[route] vm unreachable, device only"

        /** `[route] <provider> vm-required rows=N` for each VM provider the device cannot resolve. */
        fun vmRequiredLines(vm: List<Source>): List<String> =
            vm.filter { com.chitram.app.resolve.OnDeviceResolver.nameFor(it.provider) == null }.groupingBy { it.provider.lowercase() }.eachCount()
                .map { (p, n) -> "[route] $p vm-required rows=$n" }

        fun splitTwins(backend: List<Source>, device: List<Source>): Pair<List<Source>, Map<String, Source>> {
            val vmProviders = backend.map { it.provider.lowercase() }.toSet()
            // NetMirror catalogs carry different language/quality offerings; never hide them by provider name.
            val (twins, shown) = device.partition { it.provider.lowercase() != "netmirror" && it.provider.lowercase() in vmProviders }
            return shown to twins.associateBy { it.provider.lowercase() }
        }
    }
}
