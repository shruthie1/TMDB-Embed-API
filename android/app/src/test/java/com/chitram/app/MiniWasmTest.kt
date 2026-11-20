package com.chitram.app

import com.chitram.app.resolve.VaDecrypt
import com.chitram.app.resolve.WasmException
import com.chitram.app.resolve.WasmModule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/**
 * The interpreter must match V8 byte for byte on vaplayer's real module.
 * Reference values come from Node 2026-11-20 running the same va.wasm and the
 * same encrypted stream_urls (scratchpad/ondevice/va-enc.json):
 *   decrypt length 280, sha256 1a7556e1...b48, seed(5)=4184144587, hash(5)=1345146845.
 */
class MiniWasmTest {
    private fun bytes(name: String) = javaClass.classLoader!!.getResource("fixtures/$name")!!.readBytes()

    @Test fun decryptMatchesNodeOnRealModule() {
        val module = WasmModule.parse(bytes("va.wasm"))
        val urls = VaDecrypt.decrypt(module, Fixtures.read("va_enc.b64"))
        assertEquals(2, urls.size)
        val plain = VaDecrypt.plaintext(module, Fixtures.read("va_enc.b64"))
        val sha = MessageDigest.getInstance("SHA-256").digest(plain).joinToString("") { "%02x".format(it) }
        assertEquals(280, plain.size)
        assertEquals("1a7556e12c1685a380d2f3ea4a583fc8cf44fbb4de4f92045e4dd246e3e78b48", sha)
        assertTrue(urls.all { it.startsWith("https://startupmomentumengine.site/") })
    }

    @Test fun otherExportsMatchNode() {
        val inst = WasmModule.parse(bytes("va.wasm")).instantiate()
        assertEquals(4184144587L, inst.call("seed", 5)!! and 0xFFFFFFFFL)
        assertEquals(1345146845L, inst.call("hash", 5)!! and 0xFFFFFFFFL)
    }

    @Test fun eachInstanceStartsClean() {
        val module = WasmModule.parse(bytes("va.wasm"))
        val enc = Fixtures.read("va_enc.b64")
        assertEquals(VaDecrypt.decrypt(module, enc), VaDecrypt.decrypt(module, enc))
    }

    @Test(expected = WasmException::class) fun garbageIsRejected() {
        WasmModule.parse(byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7))
    }

    @Test(expected = WasmException::class) fun wrongKeyIsNotAUrlList() {
        // The identity module "decrypts" ChaCha ciphertext to noise: refused, not returned.
        VaDecrypt.decrypt(WasmModule.parse(TestWasm.IDENTITY), Fixtures.read("va_enc.b64"))
    }
}

/** (module (memory 1) bump alloc at 1024; decrypt(p, n) = n - 12): plaintext in, plaintext out. */
object TestWasm {
    val IDENTITY: ByteArray = ("0061736d01000000010c0260017f017f60027f7f017f030302000105030100010607017f014180080b071c03066d656d6f7279" +
        "020005616c6c6f630000076465637279707400010a1b021101017f23002101230020006a240020010b07002001410c6b0b")
        .chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
