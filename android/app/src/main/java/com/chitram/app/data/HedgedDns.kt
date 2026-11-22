package com.chitram.app.data

import okhttp3.Dns
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

/**
 * 1.2.52: a DNS lookup on the default network that has not answered in [slowMs] is
 * asked once more on each other network with internet (Wi-Fi plus LTE on the phone),
 * and the first answer wins. Phone log: `tv.imgcdn.kim ... ok in 53451ms (dns 52932ms)`.
 * A fast lookup never asks another network; a fast failure is thrown as before.
 * [alternates] lists the other networks' resolvers (Network.getAllByName on Android).
 */
class HedgedDns(
    private val primary: Dns,
    private val alternates: () -> List<Dns>,
    private val slowMs: Long = SLOW_MS,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val ecs = ExecutorCompletionService<List<InetAddress>>(pool)
        val first = ecs.submit { primary.lookup(hostname) }
        val done = ecs.poll(slowMs, TimeUnit.MILLISECONDS)
        if (done != null) return unwrap(done)
        val others = runCatching { alternates() }.getOrDefault(emptyList())
        if (others.isEmpty()) return unwrap(first)
        android.util.Log.i("Chitram", "[dns] $hostname no answer in ${slowMs}ms: asking ${others.size} other network(s)")
        val all = mutableListOf<Future<List<InetAddress>>>(first)
        others.forEach { d -> all += ecs.submit { d.lookup(hostname) } }
        var last: Throwable? = null
        repeat(all.size) {
            val f = ecs.take()
            try {
                val r = f.get()
                if (r.isNotEmpty()) {
                    all.forEach { if (it !== f) it.cancel(true) }
                    android.util.Log.i("Chitram", "[dns] $hostname answered by ${if (f === first) "the default network" else "another network"}")
                    return r
                }
            } catch (e: java.util.concurrent.ExecutionException) { last = e.cause }
        }
        throw (last as? UnknownHostException) ?: UnknownHostException(hostname).also { e -> last?.let { e.initCause(it) } }
    }

    private fun unwrap(f: Future<List<InetAddress>>): List<InetAddress> = try { f.get() } catch (e: java.util.concurrent.ExecutionException) {
        throw (e.cause as? UnknownHostException) ?: UnknownHostException(e.cause?.message).also { u -> u.initCause(e.cause) }
    }

    companion object {
        const val SLOW_MS = 5_000L
        private val pool = Executors.newCachedThreadPool { r -> Thread(r, "chitram-dns").apply { isDaemon = true } }
    }
}
