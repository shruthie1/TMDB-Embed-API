package com.chitram.app

import com.chitram.app.player.Mojibake
import org.junit.Assert.assertEquals
import org.junit.Test

/** 1.2.15: OpenSubtitles text mangled through cp1252/cp1250 ("â™Ş" for "♪") is repaired per line. */
class V130Test {
    @Test fun `cp1250 mangled music note is repaired`() =
        assertEquals("♪ La la ♪", Mojibake.fix("â™Ş La la â™Ş"))

    @Test fun `cp1252 mangled quotes are repaired`() =
        assertEquals("“Hi” — it’s me", Mojibake.fix("â€œHiâ€\u009d â€” itâ€™s me"))

    @Test fun `one bad line does not veto the others`() =
        assertEquals("♪ one\nÀé x™\n♪ three", Mojibake.fix("â™Ş one\nÀé x™\nâ™Ş three"))

    @Test fun `clean text is unchanged`() {
        for (t in listOf("Hello there", "Café déjà vu", "నేనొక్కడినే", "Señor ñandú", "")) assertEquals(t, Mojibake.fix(t))
    }
}
