package com.chitram.app.player

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Undo one round of UTF-8 read as Windows-1252 or Windows-1250 in subtitle text.
 * OpenSubtitles' re-encoder sometimes guesses cp1250: the note E2 99 AA comes
 * back as "â™Ş". Mirrors web/lib/subtitles.js fixMojibake. Per LINE, so one
 * stray byte cannot veto the whole cue. Strict UTF-8 decoding keeps it safe:
 * text that was not produced by this mis-decode fails and stays unchanged.
 */
internal object Mojibake {
    // Chars cp1252 maps to a high byte (0x80-0xFF). Mojibake is a run of two or more.
    private const val HIGH = "À-ÿŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™"
    private val MOJIBAKE = Regex("[$HIGH][\u0080-ÿŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]")

    // The cp1252 positions that do not match their unicode code point.
    private val CP1252: Map<Int, Int> = mapOf(
        0x20ac to 0x80, 0x201a to 0x82, 0x0192 to 0x83, 0x201e to 0x84, 0x2026 to 0x85, 0x2020 to 0x86,
        0x2021 to 0x87, 0x02c6 to 0x88, 0x2030 to 0x89, 0x0160 to 0x8a, 0x2039 to 0x8b, 0x0152 to 0x8c,
        0x017d to 0x8e, 0x2018 to 0x91, 0x2019 to 0x92, 0x201c to 0x93, 0x201d to 0x94, 0x2022 to 0x95,
        0x2013 to 0x96, 0x2014 to 0x97, 0x02dc to 0x98, 0x2122 to 0x99, 0x0161 to 0x9a, 0x203a to 0x9b,
        0x0153 to 0x9c, 0x017e to 0x9e, 0x0178 to 0x9f,
    )

    // Reverse cp1250 map, built once. Bytes cp1250 leaves undefined are skipped.
    private val CP1250: Map<Int, Int> = runCatching {
        val dec = Charset.forName("windows-1250")
        (0x80..0xff).mapNotNull { b ->
            runCatching {
                val ch = dec.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(byteArrayOf(b.toByte()))).toString()
                ch.codePointAt(0) to b
            }.getOrNull()
        }.toMap()
    }.getOrDefault(emptyMap())

    // The cp1250 shape: a UTF-8 lead byte (C2-F4) then a continuation byte (80-BF), both read as cp1250.
    private val MOJIBAKE_1250: Regex? = if (CP1250.isEmpty()) null else {
        fun cls(range: IntRange) = CP1250.filterValues { it in range }.keys.joinToString("") { "\\x{" + it.toString(16) + "}" }
        Regex("[${cls(0xc2..0xf4)}][${cls(0x80..0xbf)}]")
    }

    private fun looksMangled(s: String) = MOJIBAKE.containsMatchIn(s) || MOJIBAKE_1250?.containsMatchIn(s) == true

    fun fix(text: String): String = if (text.isEmpty() || !looksMangled(text)) text else text.split('\n').joinToString("\n", transform = ::repairLine)

    private fun repairLine(line: String): String {
        if (!looksMangled(line)) return line
        roundTrip(line, CP1252, strict1250 = false)?.let { return it }
        if (CP1250.isEmpty()) return line
        return roundTrip(line, CP1250, strict1250 = true) ?: line
    }

    private fun roundTrip(line: String, table: Map<Int, Int>, strict1250: Boolean): String? {
        val out = java.io.ByteArrayOutputStream(line.length)
        var i = 0
        while (i < line.length) {
            val cp = line.codePointAt(i)
            i += Character.charCount(cp)
            val mapped = table[cp]
            val code = mapped ?: cp
            if (code > 0xff) return null                       // not in this code page
            if (strict1250 && mapped == null && code >= 0x80) return null  // Latin-1 point cp1250 puts elsewhere
            out.write(code)
        }
        return try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray())).toString()
        } catch (e: CharacterCodingException) { null }
    }
}
