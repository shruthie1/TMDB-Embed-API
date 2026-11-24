package com.chitram.app

import com.chitram.app.data.Api
import com.chitram.app.data.HedgedDns
import com.chitram.app.data.UdpDns
import com.chitram.app.resolve.OnDeviceResolver
import okhttp3.Dns
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicInteger

/**
 * 1.2.63: phone log `vidbolt.xyz/api/resolve failed InterruptedIOException in 26680ms
 * (dns 26666ms)`: Private DNS hung 26.7 s and the phone had no other network with
 * internet, so the 1.2.52 hedge had nobody to ask. A slow lookup now also asks the
 * direct resolver, and no lookup waits past the cap.
 */
class DnsBoundTest {
    private val addr = InetAddress.getByAddress("vidbolt.xyz", byteArrayOf(104, 21, 32, 1))

    /** Like the phone: the system resolver answers after 27 s. */
    private fun hung(calls: AtomicInteger = AtomicInteger()) = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> { calls.incrementAndGet(); Thread.sleep(27_000); return listOf(addr) }
    }

    @Test fun aHungSystemResolverWithNoOtherNetworkIsAnsweredByTheDirectResolver() {
        val direct = object : Dns { override fun lookup(hostname: String) = listOf(addr) }
        val dns = HedgedDns(hung(), { emptyList() }, slowMs = 200, direct = direct, capMs = 2_000)
        val t0 = System.currentTimeMillis()
        assertEquals(listOf(addr), dns.lookup("vidbolt.xyz"))
        val ms = System.currentTimeMillis() - t0
        assertTrue("took $ms ms", ms < 1_000)
    }

    @Test fun noAnswerAnywhereFailsAtTheCapAsATimeoutNotADeadHost() {
        val slowDirect = object : Dns { override fun lookup(hostname: String): List<InetAddress> { Thread.sleep(27_000); return listOf(addr) } }
        for (direct in listOf(null, slowDirect)) {
            val dns = HedgedDns(hung(), { emptyList() }, slowMs = 200, direct = direct, capMs = 800)
            val t0 = System.currentTimeMillis()
            try { dns.lookup("vidbolt.xyz"); fail("expected a timeout") } catch (e: SocketTimeoutException) {
                val ms = System.currentTimeMillis() - t0
                assertTrue("took $ms ms", ms in 700..1_500)
                // A timeout is not "no route": the host is not marked dead, the device not offline.
                assertFalse(OnDeviceResolver.isNetwork(e))
            }
        }
    }

    @Test fun aHedgedAnswerIsKeptSoTheNextConnectionDoesNotWaitAgain() {
        val calls = AtomicInteger()
        var clock = 1_000L
        val direct = object : Dns { override fun lookup(hostname: String) = listOf(addr) }
        val dns = HedgedDns(hung(calls), { emptyList() }, slowMs = 200, direct = direct, capMs = 2_000, keepMs = 60_000, now = { clock })
        dns.lookup("vidbolt.xyz")
        val t0 = System.currentTimeMillis()
        assertEquals(listOf(addr), dns.lookup("vidbolt.xyz"))
        assertTrue(System.currentTimeMillis() - t0 < 50)
        assertEquals(1, calls.get())
        clock += 61_000
        dns.lookup("vidbolt.xyz")
        assertEquals(2, calls.get())
    }

    @Test fun aFastLookupNeverAsksTheDirectResolver() {
        val asked = AtomicInteger()
        val direct = object : Dns { override fun lookup(hostname: String): List<InetAddress> { asked.incrementAndGet(); return listOf(addr) } }
        val dns = HedgedDns(object : Dns { override fun lookup(hostname: String) = listOf(addr) }, { emptyList() }, slowMs = 200, direct = direct)
        assertEquals(listOf(addr), dns.lookup("vidbolt.xyz"))
        assertEquals(0, asked.get())
    }

    @Test fun aFastFailureIsStillAnUnknownHost() {
        val dns = HedgedDns(object : Dns { override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException(hostname) }, { emptyList() },
            slowMs = 200, direct = object : Dns { override fun lookup(hostname: String) = listOf(addr) })
        try { dns.lookup("gone.example"); fail() } catch (_: UnknownHostException) { }
    }

    /** Whole call through the app's client: a hung resolver costs slowMs, not 27 s. */
    @Test fun anHttpCallWithAHungResolverStartsAfterTheHedge() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("ok"))
            server.start()
            val local = InetAddress.getByAddress("vidbolt.test", server.hostName.let { InetAddress.getByName(it).address })
            val direct = object : Dns { override fun lookup(hostname: String) = listOf(local) }
            val client = Api.buildClient(HedgedDns(hung(), { emptyList() }, slowMs = 300, direct = direct, capMs = 2_000))
            val t0 = System.currentTimeMillis()
            val body = client.newCall(Request.Builder().url("http://vidbolt.test:${server.port}/api/resolve").build()).execute().use { it.body!!.string() }
            val ms = System.currentTimeMillis() - t0
            assertEquals("ok", body)
            assertTrue("took $ms ms", ms < 1_500)
        }
    }

    @Test fun anHttpCallWithNoAnswerFailsAtTheCapAsATimeout() {
        val client = Api.buildClient(HedgedDns(hung(), { emptyList() }, slowMs = 200, capMs = 800))
        val t0 = System.currentTimeMillis()
        try {
            client.newCall(Request.Builder().url("http://vidbolt.test/api/resolve").build()).execute().close(); fail()
        } catch (e: java.io.InterruptedIOException) {
            val ms = System.currentTimeMillis() - t0
            assertTrue("took $ms ms", ms < 1_800)
            assertFalse(OnDeviceResolver.isNetwork(e))
        }
    }

    // UdpDns against a local fake resolver.

    private fun reply(q: ByteArray, qLen: Int, rcode: Int, answers: List<ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(q, 0, 2) // id
        out.write(0x81); out.write(0x80 or rcode)
        out.write(0); out.write(1); out.write(0); out.write(answers.size); out.write(0); out.write(0); out.write(0); out.write(0)
        out.write(q, 12, qLen - 12) // question
        answers.forEach { out.write(it) }
        return out.toByteArray()
    }

    /** CNAME vidbolt.xyz -> c.cdn (name by pointer), then A for it, both compressed. */
    private fun cnameThenA(): List<ByteArray> {
        val cname = byteArrayOf(0xC0.toByte(), 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 7, 1, 'c'.code.toByte(), 3, 'c'.code.toByte(), 'd'.code.toByte(), 'n'.code.toByte(), 0)
        val a = byteArrayOf(0xC0.toByte(), 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 104, 21, 32, 1)
        return listOf(cname, a)
    }

    private fun fakeResolver(answer: (ByteArray, Int) -> ByteArray?): DatagramSocket {
        val s = DatagramSocket(0, InetAddress.getLoopbackAddress())
        Thread {
            val buf = ByteArray(512)
            runCatching {
                while (true) {
                    val p = DatagramPacket(buf, buf.size); s.receive(p)
                    answer(buf.copyOf(p.length), p.length)?.let { r -> s.send(DatagramPacket(r, r.size, p.socketAddress)) }
                }
            }
        }.apply { isDaemon = true }.start()
        return s
    }

    @Test fun udpDnsReadsARecordsBehindACname() {
        val srv = fakeResolver { q, n -> reply(q, n, 0, cnameThenA()) }
        srv.use {
            val dns = UdpDns(listOf(InetSocketAddress(InetAddress.getLoopbackAddress(), srv.localPort)), timeoutMs = 1_000)
            val got = dns.lookup("vidbolt.xyz")
            assertEquals(listOf("104.21.32.1"), got.map { it.hostAddress })
            assertEquals("vidbolt.xyz", got.first().hostName)
        }
    }

    @Test fun udpDnsNxdomainIsAnUnknownHost() {
        val srv = fakeResolver { q, n -> reply(q, n, 3, emptyList()) }
        srv.use {
            val dns = UdpDns(listOf(InetSocketAddress(InetAddress.getLoopbackAddress(), srv.localPort)), timeoutMs = 1_000)
            try { dns.lookup("nope.example"); fail() } catch (_: UnknownHostException) { }
        }
    }

    @Test fun udpDnsSilentServerTimesOutOnTime() {
        val srv = fakeResolver { _, _ -> null }
        srv.use {
            val dns = UdpDns(listOf(InetSocketAddress(InetAddress.getLoopbackAddress(), srv.localPort)), timeoutMs = 400)
            val t0 = System.currentTimeMillis()
            try { dns.lookup("vidbolt.xyz"); fail() } catch (_: SocketTimeoutException) { }
            assertTrue(System.currentTimeMillis() - t0 < 1_000)
        }
    }

    @Test fun udpDnsIgnoresAReplyWithAnotherId() {
        val srv = fakeResolver { q, n -> reply(q, n, 0, cnameThenA()).also { it[0] = (it[0] + 1).toByte() } }
        srv.use {
            val dns = UdpDns(listOf(InetSocketAddress(InetAddress.getLoopbackAddress(), srv.localPort)), timeoutMs = 400)
            try { dns.lookup("vidbolt.xyz"); fail() } catch (_: SocketTimeoutException) { }
        }
    }
}
