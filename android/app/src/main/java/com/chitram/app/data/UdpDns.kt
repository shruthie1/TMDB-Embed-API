package com.chitram.app.data

import okhttp3.Dns
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlin.random.Random

/**
 * 1.2.63: a plain A lookup sent straight to public resolvers over UDP, on the default
 * network. [HedgedDns] asks it only when the system resolver has not answered in time.
 * Phone log (1.2.62): `vidbolt.xyz/api/resolve failed ... in 26680ms (dns 26666ms)`;
 * the phone's Private DNS (DoT) was slow and it had no other network with internet.
 * The query goes to every server at once; the first valid answer wins.
 */
class UdpDns(
    private val servers: List<InetSocketAddress> = DEFAULT_SERVERS,
    private val timeoutMs: Int = TIMEOUT_MS,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val id = Random.nextInt(0x10000)
        val q = query(id, hostname)
        DatagramSocket().use { s ->
            servers.forEach { s.send(DatagramPacket(q, q.size, it)) }
            val deadline = System.currentTimeMillis() + timeoutMs
            val buf = ByteArray(1500)
            var refused: UnknownHostException? = null
            var answers = 0
            while (true) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) throw refused ?: SocketTimeoutException("udp dns $hostname: no answer in ${timeoutMs}ms")
                s.soTimeout = left.toInt()
                val p = DatagramPacket(buf, buf.size)
                try { s.receive(p) } catch (e: SocketTimeoutException) { throw refused ?: e }
                if (servers.none { it.address == p.address && it.port == p.port }) continue
                val r = try { parse(buf, p.length, id, hostname) } catch (e: UnknownHostException) {
                    // One server said no: wait for the others until the deadline.
                    refused = e; if (++answers >= servers.size) throw e; continue
                } ?: continue
                return r
            }
        }
    }

    companion object {
        const val TIMEOUT_MS = 2_500
        val DEFAULT_SERVERS = listOf(InetSocketAddress("1.1.1.1", 53), InetSocketAddress("8.8.8.8", 53))

        /** DNS query for [hostname], type A, class IN, recursion desired. */
        internal fun query(id: Int, hostname: String): ByteArray {
            val out = ByteArrayOutputStream()
            fun u16(v: Int) { out.write(v shr 8 and 0xFF); out.write(v and 0xFF) }
            u16(id); u16(0x0100); u16(1); u16(0); u16(0); u16(0)
            hostname.trimEnd('.').split('.').forEach { label ->
                val b = label.toByteArray(Charsets.US_ASCII)
                if (b.isEmpty() || b.size > 63) throw UnknownHostException(hostname)
                out.write(b.size); out.write(b)
            }
            out.write(0); u16(1); u16(1)
            return out.toByteArray()
        }

        /**
         * The A records of a reply to [id]; null when the packet is not that reply.
         * NXDOMAIN, an error code or no A record throws [UnknownHostException].
         */
        internal fun parse(b: ByteArray, len: Int, id: Int, hostname: String): List<InetAddress>? {
            if (len < 12) return null
            fun u16(i: Int): Int { if (i + 1 >= len) throw UnknownHostException("$hostname: short dns reply"); return (b[i].toInt() and 0xFF shl 8) or (b[i + 1].toInt() and 0xFF) }
            fun skipName(start: Int): Int {
                var i = start
                while (true) {
                    if (i >= len) throw UnknownHostException("$hostname: short dns reply")
                    val n = b[i].toInt() and 0xFF
                    when {
                        n == 0 -> return i + 1
                        n and 0xC0 == 0xC0 -> return i + 2
                        else -> i += n + 1
                    }
                }
            }
            if (u16(0) != id) return null
            val flags = u16(2)
            if (flags and 0x8000 == 0) return null
            val rcode = flags and 0xF
            if (rcode != 0) throw UnknownHostException("$hostname: dns rcode $rcode")
            val qd = u16(4); val an = u16(6)
            var i = 12
            repeat(qd) { i = skipName(i) + 4 }
            val out = ArrayList<InetAddress>()
            repeat(an) {
                i = skipName(i)
                val type = u16(i); val cls = u16(i + 2); val rdLen = u16(i + 8)
                i += 10
                if (i + rdLen > len) throw UnknownHostException("$hostname: short dns reply")
                if (type == 1 && cls == 1 && rdLen == 4) out += InetAddress.getByAddress(hostname, b.copyOfRange(i, i + 4))
                i += rdLen
            }
            if (out.isEmpty()) throw UnknownHostException("$hostname: no A record")
            return out
        }
    }
}
