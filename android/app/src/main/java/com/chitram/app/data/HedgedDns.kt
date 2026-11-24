package com.chitram.app.data

import okhttp3.Dns
import java.net.InetAddress
import java.net.SocketTimeoutException
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
 *
 * 1.2.63: the phone had no other network with internet (its LTE/NR agents were IMS
 * only), so the hedge had nobody to ask and waited on Private DNS:
 * `vidbolt.xyz/api/resolve failed InterruptedIOException in 26680ms (dns 26666ms)`.
 * Now a slow lookup also asks [direct] (UdpDns: public resolvers over UDP), and no
 * lookup waits longer than [capMs]: it then fails as a timeout
 * (SocketTimeoutException), never as UnknownHostException, so a slow resolver is
 * not read as a dead host or an offline device (OnDevice.isNetwork, MultiMovies dead).
 * A host answered by a hedge is kept [keepMs], so the next connection skips the wait.
 * 1.2.65: every answer is kept, and [warm] looks provider hosts up at app start.
 */
class HedgedDns(
    private val primary: Dns,
    private val alternates: () -> List<Dns>,
    private val slowMs: Long = SLOW_MS,
    private val direct: Dns? = null,
    private val capMs: Long = CAP_MS,
    private val keepMs: Long = KEEP_MS,
    private val now: () -> Long = System::currentTimeMillis,
) : Dns {
    private val kept = java.util.concurrent.ConcurrentHashMap<String, Pair<List<InetAddress>, Long>>()

    override fun lookup(hostname: String): List<InetAddress> {
        kept[hostname]?.let { (addrs, until) -> if (now() < until) return addrs else kept.remove(hostname) }
        val t0 = System.nanoTime()
        val ecs = ExecutorCompletionService<List<InetAddress>>(pool)
        val first = ecs.submit { primary.lookup(hostname) }
        val done = ecs.poll(slowMs, TimeUnit.MILLISECONDS)
        if (done != null) return unwrap(done).also { if (it.isNotEmpty()) kept[hostname] = it to now() + keepMs }
        val others = runCatching { alternates() }.getOrDefault(emptyList())
        val names = HashMap<Future<List<InetAddress>>, String>()
        names[first] = "the default network"
        android.util.Log.i("Chitram", "[dns] $hostname no answer in ${slowMs}ms: asking ${others.size} other network(s)${if (direct != null) " and the direct resolver" else ""}")
        val all = mutableListOf<Future<List<InetAddress>>>(first)
        others.forEach { d -> ecs.submit { d.lookup(hostname) }.also { all += it; names[it] = "another network" } }
        direct?.let { d -> ecs.submit { d.lookup(hostname) }.also { all += it; names[it] = "the direct resolver" } }
        var last: Throwable? = null
        repeat(all.size) {
            val left = capMs - (System.nanoTime() - t0) / 1_000_000
            val f = if (left > 0) ecs.poll(left, TimeUnit.MILLISECONDS) else null
            if (f == null) {
                all.forEach { it.cancel(true) }
                android.util.Log.i("Chitram", "[dns] $hostname no answer in ${capMs}ms: giving up")
                throw SocketTimeoutException("dns $hostname: no answer in ${capMs}ms")
            }
            try {
                val r = f.get()
                if (r.isNotEmpty()) {
                    all.forEach { if (it !== f) it.cancel(true) }
                    kept[hostname] = r to now() + keepMs
                    android.util.Log.i("Chitram", "[dns] $hostname answered by ${names[f]} in ${(System.nanoTime() - t0) / 1_000_000}ms")
                    return r
                }
            } catch (e: java.util.concurrent.ExecutionException) { last = e.cause }
        }
        throw (last as? UnknownHostException) ?: UnknownHostException(hostname).also { e -> last?.let { e.initCause(it) } }
    }

    /**
     * 1.2.65: looks the provider [hosts] up in the background (app start, network change),
     * so the first connection of each device resolver does not pay 1.3-1.8 s of DNS.
     * Answers are kept like any other. DNS only: no request reaches any host.
     */
    fun warm(hosts: Collection<String>) {
        val list = hosts.map { it.lowercase() }.filter { it.isNotBlank() }.distinct()
        if (list.isEmpty()) return
        pool.submit {
            val t0 = System.nanoTime()
            val ok = list.map { h -> pool.submit<Boolean> { runCatching { lookup(h) }.isSuccess } }.count { runCatching { it.get() }.getOrDefault(false) }
            android.util.Log.i("Chitram", "[dns] warmed $ok/${list.size} provider host(s) in ${(System.nanoTime() - t0) / 1_000_000}ms")
        }
    }

    /** A new default network: kept answers may not route there. */
    fun clear() = kept.clear()

    private fun unwrap(f: Future<List<InetAddress>>): List<InetAddress> = try { f.get() } catch (e: java.util.concurrent.ExecutionException) {
        throw (e.cause as? UnknownHostException) ?: UnknownHostException(e.cause?.message).also { u -> u.initCause(e.cause) }
    }

    companion object {
        /** 1.2.63: 5 s -> 2.5 s; asking the direct resolver costs one UDP packet. */
        const val SLOW_MS = 2_500L
        /** Longest any lookup waits (phone: 22.8 s and 26.7 s Private DNS lookups). */
        const val CAP_MS = 10_000L
        /** 1.2.65: every answer (default network too) is kept; dropped on a network change (clear). */
        const val KEEP_MS = 10 * 60_000L
        private val pool = Executors.newCachedThreadPool { r -> Thread(r, "chitram-dns").apply { isDaemon = true } }
    }
}
