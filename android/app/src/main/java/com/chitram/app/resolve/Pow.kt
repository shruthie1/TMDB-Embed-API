package com.chitram.app.resolve

import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong

/**
 * mapple's proof of work (its /pow-worker.js): find the smallest n where
 * sha256(challenge + n) has at least `difficulty` LEADING ZERO BITS. Same
 * answer as providers/mapple.js solvePow (the smallest n), so the same nonce
 * comes out. Difficulty 18 is ~262k hashes on average.
 *
 * Speed (2026-11-21): the MessageDigest loop ([solveReference]) took 4450ms on
 * a Fire TV against 72-176ms in Node. [solve] hashes the challenge's full
 * 64-byte blocks once (mapple's challenge is 64 hex chars = exactly one block,
 * so each try then costs one compression, not two), allocates nothing per try,
 * and splits the nonce range over the CPU cores in ordered chunks so the
 * smallest nonce still wins. Callers run it off the main thread.
 */
object Pow {
    fun leadingZeroBits(d: ByteArray): Int {
        var bits = 0
        for (b in d) {
            val x = b.toInt() and 0xFF
            if (x == 0) { bits += 8; continue }
            bits += Integer.numberOfLeadingZeros(x) - 24
            break
        }
        return bits
    }

    fun defaultThreads(): Int = Runtime.getRuntime().availableProcessors().coerceIn(1, 8)

    /** null when not found below `max` or when `active()` turns false (cancelled). */
    fun solve(challenge: String, difficulty: Int, max: Int = 20_000_000, threads: Int = defaultThreads(), active: () -> Boolean = { true }): String? {
        val prefix = challenge.toByteArray(Charsets.UTF_8)
        val full = prefix.size / 64
        val mid = H0.copyOf()
        val w = IntArray(64)
        for (b in 0 until full) compress(mid, prefix, b * 64, w)
        val tail = prefix.copyOfRange(full * 64, prefix.size)
        val bitLen = prefix.size.toLong() * 8

        val best = AtomicLong(Long.MAX_VALUE)
        val next = AtomicLong(0)
        val cancelled = java.util.concurrent.atomic.AtomicBoolean(false)
        val n = threads.coerceAtLeast(1)

        fun work() {
            val st = IntArray(8)
            val ww = IntArray(64)
            val buf = ByteArray(128)
            var digits = -1
            var blocks = 0
            while (true) {
                val start = next.getAndIncrement() * CHUNK
                if (start >= max || start >= best.get() || cancelled.get()) return
                if (!active()) { cancelled.set(true); return }
                val end = minOf(start + CHUNK, max.toLong())
                var i = start
                scan@ while (i < end) {
                    val d = digitCount(i)
                    if (d != digits) {
                        // New digit count: rebuild the padded final block(s) once.
                        digits = d
                        java.util.Arrays.fill(buf, 0)
                        System.arraycopy(tail, 0, buf, 0, tail.size)
                        val msgEnd = tail.size + d
                        buf[msgEnd] = 0x80.toByte()
                        blocks = if (msgEnd + 9 <= 64) 1 else 2
                        val total = bitLen + d * 8L
                        val at = blocks * 64 - 8
                        for (k in 0 until 8) buf[at + k] = (total ushr (56 - 8 * k)).toByte()
                    }
                    var v = i
                    var p = tail.size + d - 1
                    do { buf[p--] = ('0'.code + (v % 10).toInt()).toByte(); v /= 10 } while (v > 0)
                    System.arraycopy(mid, 0, st, 0, 8)
                    compress(st, buf, 0, ww)
                    if (blocks == 2) compress(st, buf, 64, ww)
                    if (zeroBits(st) >= difficulty) {
                        // Smallest in this chunk; later chunks stop once they start past it.
                        while (true) { val b = best.get(); if (i >= b || best.compareAndSet(b, i)) break }
                        break@scan
                    }
                    i++
                }
            }
        }

        // Chunks are taken in rising order and each is scanned to its first hit, so
        // every chunk below the final best was scanned: the smallest nonce wins.
        if (n == 1) work() else {
            // A worker that throws would leave its chunk unscanned: stop all, rethrow.
            val error = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
            val ts = (0 until n).map {
                Thread({ try { work() } catch (t: Throwable) { error.compareAndSet(null, t); cancelled.set(true) } }, "mapple-pow-$it")
                    .apply { isDaemon = true; start() }
            }
            ts.forEach { it.join() }
            error.get()?.let { throw it }
        }
        if (cancelled.get()) return null
        val r = best.get()
        return if (r < max) r.toString() else null
    }

    /** The plain MessageDigest loop, kept as the reference [solve] must agree with. */
    internal fun solveReference(challenge: String, difficulty: Int, max: Int = 20_000_000, active: () -> Boolean = { true }): String? {
        val md = MessageDigest.getInstance("SHA-256")
        val prefix = challenge.toByteArray(Charsets.UTF_8)
        for (n in 0 until max) {
            if (n and 0xFFF == 0 && !active()) return null
            md.update(prefix)
            md.update(n.toString().toByteArray(Charsets.US_ASCII))
            if (leadingZeroBits(md.digest()) >= difficulty) return n.toString()
        }
        return null
    }

    private const val CHUNK = 4096L

    private fun digitCount(v: Long): Int { var d = 1; var x = v; while (x >= 10) { x /= 10; d++ }; return d }

    private fun zeroBits(st: IntArray): Int {
        var bits = 0
        for (x in st) { if (x == 0) { bits += 32; continue }; return bits + Integer.numberOfLeadingZeros(x) }
        return bits
    }

    private val H0 = longArrayOf(
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ).map { it.toInt() }.toIntArray()

    private val K = longArrayOf(
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ).map { it.toInt() }.toIntArray()

    /** One SHA-256 compression of block[off, off+64) into st. */
    private fun compress(st: IntArray, block: ByteArray, off: Int, w: IntArray) {
        for (t in 0 until 16) {
            val j = off + t * 4
            w[t] = (block[j].toInt() shl 24) or ((block[j + 1].toInt() and 0xFF) shl 16) or
                ((block[j + 2].toInt() and 0xFF) shl 8) or (block[j + 3].toInt() and 0xFF)
        }
        for (t in 16 until 64) {
            val x = w[t - 15]; val y = w[t - 2]
            val s0 = Integer.rotateRight(x, 7) xor Integer.rotateRight(x, 18) xor (x ushr 3)
            val s1 = Integer.rotateRight(y, 17) xor Integer.rotateRight(y, 19) xor (y ushr 10)
            w[t] = w[t - 16] + s0 + w[t - 7] + s1
        }
        var a = st[0]; var b = st[1]; var c = st[2]; var d = st[3]
        var e = st[4]; var f = st[5]; var g = st[6]; var h = st[7]
        for (t in 0 until 64) {
            val s1 = Integer.rotateRight(e, 6) xor Integer.rotateRight(e, 11) xor Integer.rotateRight(e, 25)
            val ch = (e and f) xor (e.inv() and g)
            val t1 = h + s1 + ch + K[t] + w[t]
            val s0 = Integer.rotateRight(a, 2) xor Integer.rotateRight(a, 13) xor Integer.rotateRight(a, 22)
            val maj = (a and b) xor (a and c) xor (b and c)
            val t2 = s0 + maj
            h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2
        }
        st[0] += a; st[1] += b; st[2] += c; st[3] += d; st[4] += e; st[5] += f; st[6] += g; st[7] += h
    }
}
