package com.chitram.app.resolve

import com.chitram.app.data.KeyValue

/**
 * Remembers which base host last worked for a provider, like the backend's
 * utils/upstreamBase.js: a healed host wins while fresh (7 days), then the
 * configured list is tried again. Healing itself happens in [heal]: try each
 * candidate, follow a cross-host redirect (mapple.uk -> mapple.rip was how a
 * past move showed up), keep the first that passes the provider's own probe.
 */
class HostBook(private val kv: KeyValue, private val now: () -> Long = System::currentTimeMillis) {
    fun healed(name: String): String? {
        val raw = kv.get(key(name)) ?: return null
        val base = raw.substringBefore('|')
        val at = raw.substringAfter('|', "0").toLongOrNull() ?: 0L
        return base.takeIf { it.startsWith("http") && now() - at < TTL_MS }
    }

    /**
     * Healed host, then [configured], then [builtIn] last (deduped): a config list
     * that drops the built-in host never removes it (review I2).
     */
    fun candidates(name: String, configured: List<String>, builtIn: List<String> = emptyList()): List<String> =
        (listOfNotNull(healed(name)) + configured + builtIn).map { it.trimEnd('/') }.distinct()

    /** The first configured host is the default: remembering it means forgetting any heal. */
    fun remember(name: String, base: String, configured: List<String>) {
        if (base == configured.firstOrNull()?.trimEnd('/')) kv.put(key(name), null)
        else kv.put(key(name), "$base|${now()}")
    }

    sealed interface Probe<out T> {
        /**
         * The host answered. [remember] false: use it for this call but do not
         * (re)pin it, for an answer that says nothing about the host's health
         * (no sources, rate limit). Review I3.
         */
        data class Ok<T>(val value: T, val remember: Boolean = true) : Probe<T>
        /** The host answered with a redirect to another origin: try that origin too. */
        data class Moved(val origin: String) : Probe<Nothing>
        data class Dead(val error: Exception) : Probe<Nothing>
    }

    /**
     * Tries candidates in order (healed, configured, built-in, then redirect targets found
     * on the way, at most [MAX_EXTRA]). Returns the base that worked and its
     * value; throws the last error when none did.
     */
    suspend fun <T> heal(name: String, configured: List<String>, builtIn: List<String> = emptyList(), probe: suspend (String) -> Probe<T>): Pair<String, T> {
        val queue = ArrayDeque(candidates(name, configured, builtIn))
        val seen = queue.toMutableSet()
        var extra = 0
        var last: Exception = StepException(name, 0, "no candidate host")
        while (queue.isNotEmpty()) {
            val base = queue.removeFirst()
            val r = try { probe(base) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Probe.Dead(e)
            }
            when (r) {
                is Probe.Ok -> {
                    if (r.remember) remember(name, base, configured)
                    if (base != configured.firstOrNull()?.trimEnd('/')) android.util.Log.i("Chitram", "heal: $name using $base")
                    return base to r.value
                }
                is Probe.Moved -> if (seen.add(r.origin) && extra++ < MAX_EXTRA) queue.addFirst(r.origin)
                is Probe.Dead -> last = r.error
            }
        }
        throw last
    }

    private fun key(name: String) = "resolve.host.$name"

    companion object {
        const val TTL_MS = 7 * 24 * 3600 * 1000L
        const val MAX_EXTRA = 3
    }
}
