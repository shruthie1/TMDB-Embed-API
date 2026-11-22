package com.chitram.app.data

/**
 * 1.2.52: follows the default network (ConnectivityManager.registerDefaultNetworkCallback)
 * and calls [onChange] when it really changes: another network became the default, or
 * the default was lost. The first network seen is no change. Pure, so it is unit-tested;
 * App wires [onChange] to Api.networkChanged (pool eviction).
 */
class NetworkWatch(private val onChange: (String) -> Unit) {
    private var current: String? = null
    private val lock = Any()

    fun available(id: String) {
        val why = synchronized(lock) {
            val was = current
            current = id
            if (was != null && was != id) "default $was -> $id" else null
        }
        why?.let(onChange)
    }

    fun lost(id: String) {
        val why = synchronized(lock) {
            if (current != id) null else { current = null; "default $id lost" }
        }
        why?.let(onChange)
    }
}
