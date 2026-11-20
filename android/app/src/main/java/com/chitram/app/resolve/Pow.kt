package com.chitram.app.resolve

import java.security.MessageDigest

/**
 * mapple's proof of work (its /pow-worker.js): find the smallest n where
 * sha256(challenge + n) has at least `difficulty` LEADING ZERO BITS. Same loop
 * as providers/mapple.js solvePow, so the same nonce comes out. Difficulty 18
 * is ~262k hashes on average; callers run this on Dispatchers.Default.
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

    /** null when not found within `max` tries or when `active()` turns false (cancelled). */
    fun solve(challenge: String, difficulty: Int, max: Int = 20_000_000, active: () -> Boolean = { true }): String? {
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
}
