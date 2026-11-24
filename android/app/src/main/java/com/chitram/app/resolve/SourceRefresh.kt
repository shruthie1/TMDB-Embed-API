package com.chitram.app.resolve

import com.chitram.app.data.CodecSupport
import com.chitram.app.data.Source
import com.chitram.app.data.StreamsResponse
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * "Refresh sources" (owner 2026-11-22: "on demand refresh. If previous URLs does
 * not play, how can we handle this?").
 *
 * For one title and episode: drop every prewarm job, resolve every on-device
 * provider anew, and ask the VM once with refresh=1. Each new answer replaces
 * the kept rows it covers; a failed answer (offline, VM down) keeps them (gap 10.5). At most one refresh per
 * title per [COOLDOWN_MS], shared by the details page and the player.
 */
class SourceRefresh(
    private val od: OnDeviceResolver,
    /** The VM with refresh=1 (Api.streams(refresh = true)): drops the kept VM answer and keeps the new one. */
    private val vm: suspend (type: String, id: Long, season: Int, episode: Int) -> StreamsResponse,
    /** False while the VM breaker is open: no VM call, VM-down providers run on the device. */
    private val vmUp: () -> Boolean,
    private val now: () -> Long = System::currentTimeMillis,
) {
    sealed interface Result

    /** A refresh of this title ran less than [COOLDOWN_MS] ago. */
    data class Throttled(val readyAt: Long) : Result

    /**
     * [vm] null: the VM failed or was skipped. [kept]: urls kept before the
     * refresh. [failed]: nothing came back at all, so the caller keeps its list.
     */
    data class Done(val vm: StreamsResponse?, val device: List<Source>, val kept: Set<String>, val readyAt: Long) : Result {
        val failed: Boolean get() = vm == null && device.isEmpty()
    }

    private val last = HashMap<String, Long>()

    /** When the next refresh of this title may run (now or earlier: it may run now). */
    fun readyAt(type: String, id: Long, season: Int, episode: Int): Long =
        synchronized(last) { (last[StreamCache.key(type, id, season, episode)] ?: Long.MIN_VALUE / 2) + COOLDOWN_MS }

    suspend fun run(
        type: String, id: Long, season: Int, episode: Int, codecs: CodecSupport, preferred: String,
        title: String? = null, originalLang: String? = null,
        /** Providers of the rows on screen: each is refreshed too, even one Play starts only when the VM is down. */
        also: Collection<String> = emptyList(),
        onProvider: (String, Int) -> Unit = { _, _ -> },
    ): Result {
        val key = StreamCache.key(type, id, season, episode)
        val at = now()
        synchronized(last) {
            val prev = last[key]
            if (prev != null && at - prev < COOLDOWN_MS) {
                android.util.Log.i("Chitram", "[refresh] $type/$id throttled: ${(prev + COOLDOWN_MS - at) / 1000}s left")
                return Throttled(prev + COOLDOWN_MS)
            }
            last[key] = at
        }
        val kept = od.forgetTitle(type, id, season, episode)
        val up = vmUp()
        val names = (od.names() + also.mapNotNull(OnDeviceResolver::nameFor)).distinct()
        android.util.Log.i("Chitram", "[refresh] $type/$id s$season e$episode start: ${names.joinToString(",")}${if (up) " + vm refresh=1" else " (vm paused)"}")
        return coroutineScope {
            val vmJob = if (!up) null else async {
                try { vm(type, id, season, episode) } catch (e: Exception) {
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    android.util.Log.i("Chitram", "[refresh] vm failed: ${e.javaClass.simpleName} ${e.message}")
                    null
                }
            }
            val device = od.refreshAll(names, type, id, season, episode, codecs, preferred, title, originalLang, onProvider)
            val answer = vmJob?.await()
            if (answer != null) onProvider(VM, answer.streams.size)
            // Playlists of kept urls the new answers no longer list go too.
            if (answer != null || device.isNotEmpty())
                od.dropOldPlaylists(kept, device.flatMap { listOfNotNull(it.url, it.directUrl, it.proxyUrl) }.toSet() +
                    answer?.streams.orEmpty().flatMap { listOfNotNull(it.url, it.directUrl) })
            android.util.Log.i("Chitram", "[refresh] $type/$id done: vm=${answer?.streams?.size ?: "none"} device=${device.size} in ${now() - at}ms")
            Done(answer, device, kept, at + COOLDOWN_MS)
        }
    }

    companion object {
        /** At most one refresh per title in this window (owner: 30 s). */
        const val COOLDOWN_MS = 30_000L
        /** [run]'s onProvider name for the VM answer. */
        const val VM = "server"
    }
}
