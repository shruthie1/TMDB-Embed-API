package com.chitram.app.data

/**
 * Circuit breaker for the VM (cooperative-APK plan, section 3). Two transport
 * failures, timeouts or 5xx in a row open it for 60s, doubling per further
 * failure up to 10 min. When the pause ends, one call is let through as a
 * probe (half-open). The state lives in SharedPreferences, so a cold start
 * with the VM down skips the timeout. A 4xx is an answer, not a failure.
 */
class VmHealth(private val kv: KeyValue, private val now: () -> Long = System::currentTimeMillis) {
    @Volatile private var fails: Int = kv.get(FAILS_KEY)?.toIntOrNull() ?: 0
    @Volatile var openUntil: Long = kv.get(UNTIL_KEY)?.toLongOrNull() ?: 0L
        private set

    /** True when a VM call may go out (closed, or half-open after the pause). */
    fun allow(): Boolean = fails < FAILS || now() >= openUntil

    /** The pause has ended but the last calls failed: the next call is a probe. */
    val halfOpen: Boolean get() = fails >= FAILS && now() >= openUntil

    @Synchronized fun onSuccess() {
        if (fails == 0 && openUntil == 0L) return
        fails = 0
        openUntil = 0
        kv.put(FAILS_KEY, null)
        kv.put(UNTIL_KEY, null)
    }

    @Synchronized fun onFailure() {
        fails++
        if (fails >= FAILS) {
            val open = (OPEN_MS shl (fails - FAILS).coerceAtMost(4)).coerceAtMost(MAX_MS)
            openUntil = now() + open
            android.util.Log.i("Chitram", "[vm] $fails failures in a row, VM rows paused ${open / 1000}s")
        }
        kv.put(FAILS_KEY, fails.toString())
        kv.put(UNTIL_KEY, openUntil.toString())
    }

    /**
     * Launch extra `--ez vmDown true` (on-phone proof of the VM-down path): the same
     * state as FAILS failures in a row, paused MAX_MS. It clears itself when the
     * pause ends and the probe succeeds, or on the next VM success.
     */
    @Synchronized fun forceDown() {
        fails = FAILS
        openUntil = now() + MAX_MS
        kv.put(FAILS_KEY, fails.toString())
        kv.put(UNTIL_KEY, openUntil.toString())
        android.util.Log.i("Chitram", "[vm] forced down by launch extra")
    }

    companion object {
        const val FAILS = 2
        const val OPEN_MS = 60_000L
        const val MAX_MS = 10 * 60_000L
        const val FAILS_KEY = "vm.fails"
        const val UNTIL_KEY = "vm.down.until"
    }
}
