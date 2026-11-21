package com.chitram.app.player

import com.chitram.app.data.Ranking
import com.chitram.app.data.Source
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay

/**
 * The first source list of a start (cooperative-APK plan, sections 3-4).
 * The VM and the device resolvers run together from t=0. The VM leads while it
 * answers within VM_LEAD_MS; after that, or as soon as the VM call fails, a
 * playable device row in the viewer's language starts the film and the VM
 * rows join late without interrupting. Device rows never wait on the VM.
 */
class StartRace(
    private val leadMs: Long = VM_LEAD_MS,
    private val graceMs: Long = PlayerVm.DEVICE_GRACE_MS,
    private val waitMs: Long = PlayerVm.DEVICE_WAIT_MS,
    private val now: () -> Long = System::currentTimeMillis,
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
                          extras: ((why: String) -> List<Deferred<List<Source>>>)? = null): First {
        val jobs = device.toMutableList()
        var started = false
        fun startExtras(why: String) {
            if (started || extras == null) return
            started = true
            jobs += extras(why)
        }
        return firstReady(backend, preferred,
            ready = { jobs.filter { it.isCompleted && !it.isCancelled }.flatMap { runCatching { it.getCompleted() }.getOrDefault(emptyList()) } },
            allDone = { jobs.all { it.isCompleted } },
            onLeadNoGood = { startExtras("VM lead over, no ${preferred} row") },
            onVmFailed = { startExtras("VM failed") })
    }

    private suspend fun firstReady(backend: Deferred<List<Source>>?, preferred: String, ready: () -> List<Source>, allDone: () -> Boolean,
                                   onLeadNoGood: () -> Unit = {}, onVmFailed: () -> Unit = {}): First {
        val t0 = now()
        fun good(s: Source) = !s.unsupported && Ranking.tier(s, preferred) <= 2

        // 1. The VM's lead: wait for it, but never past VM_LEAD_MS when a device row can play.
        while (backend != null && !backend.isCompleted) {
            val r = ready()
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

        /**
         * Same provider from both sides: the VM row shows (demux languages, hybrid,
         * cast-ready URL) and the device row is kept as a hidden twin for a VM
         * failure. Keyed by lowercase provider.
         */
        fun splitTwins(backend: List<Source>, device: List<Source>): Pair<List<Source>, Map<String, Source>> {
            val vmProviders = backend.map { it.provider.lowercase() }.toSet()
            // NetMirror catalogs carry different language/quality offerings; never hide them by provider name.
            val (twins, shown) = device.partition { it.provider.lowercase() != "netmirror" && it.provider.lowercase() in vmProviders }
            return shown to twins.associateBy { it.provider.lowercase() }
        }
    }
}
