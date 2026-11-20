package com.chitram.app.resolve

import okio.ByteString.Companion.decodeBase64

/**
 * vaplayer's stream_urls decrypt, run in the module the API names (wasm_url).
 * Same calls as vadec.js: alloc(len), copy the bytes in, decrypt(ptr, len) returns
 * the plaintext length, and the plaintext (one url per line) starts at
 * ptr + offset (12: the nonce sits in front).
 */
object VaDecrypt {
    fun decrypt(module: WasmModule, base64: String, offset: Int = 12): List<String> {
        val text = String(plaintext(module, base64, offset), Charsets.UTF_8)
        val urls = text.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
        // A wrong module (stale bundled copy, rotated key) yields bytes, not urls.
        if (urls.isEmpty() || urls.any { !it.startsWith("http://") && !it.startsWith("https://") }) {
            throw WasmException("decrypt output is not a url list")
        }
        return urls
    }

    fun plaintext(module: WasmModule, base64: String, offset: Int = 12): ByteArray {
        val bytes = base64.trim().decodeBase64()?.toByteArray() ?: throw WasmException("stream_urls is not base64")
        val inst = module.instantiate()
        val ptr = inst.call("alloc", bytes.size.toLong())?.toInt() ?: throw WasmException("alloc returned nothing")
        inst.write(ptr, bytes)
        val n = inst.call("decrypt", ptr.toLong(), bytes.size.toLong())?.toInt() ?: throw WasmException("decrypt returned nothing")
        if (n < 0 || n > bytes.size) throw WasmException("decrypt length $n out of range")
        return inst.read(ptr + offset, n)
    }
}
