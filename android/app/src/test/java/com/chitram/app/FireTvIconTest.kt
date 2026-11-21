package com.chitram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.DataInputStream

/**
 * Fire OS 6 home row (favourites / apps nav) draws a sideloaded app from the
 * Appstore's copy of PackageManager.getApplicationIcon(), i.e. mipmap/ic_launcher,
 * not the banner. If that copy is missing the launcher gets
 * android.resource://com.chitram.app/<iconId>, which it cannot load (blank tile).
 * See .superpowers/sdd/2026-11-21-audio-pairing-step2/firetv-icon-rca.md.
 * These checks keep the icon the Appstore draws a plain bitmap at every density.
 */
class FireTvIconTest {
    private fun file(rel: String) = listOf(File(rel), File("app/$rel")).first { it.exists() }
    private val res = file("src/main/res")

    private fun pngSize(f: File): Pair<Int, Int> = DataInputStream(f.inputStream()).use { s ->
        val sig = ByteArray(8).also { s.readFully(it) }
        assertTrue("${f.path} is not a PNG", sig.contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)))
        s.readInt(); s.readInt() // IHDR length, type
        s.readInt() to s.readInt()
    }

    @Test fun manifestIconIsMipmapAndBannerIsDrawable() {
        val m = file("src/main/AndroidManifest.xml").readText()
        assertTrue(m.contains("android:icon=\"@mipmap/ic_launcher\""))
        assertTrue(m.contains("android:banner=\"@drawable/banner\""))
    }

    @Test fun launcherIconIsBitmapAtEveryDensity() {
        val want = mapOf("mdpi" to 48, "hdpi" to 72, "xhdpi" to 96, "xxhdpi" to 144, "xxxhdpi" to 192)
        for ((d, px) in want) {
            val f = File(res, "mipmap-$d/ic_launcher.png")
            assertTrue("missing ${f.path}", f.exists())
            assertEquals("${f.path} size", px to px, pngSize(f))
        }
    }

    @Test fun noIconFallbackThatWouldShadowTheMipmap() {
        val dirs = res.listFiles()!!.filter { it.isDirectory }
        val shadows = dirs.flatMap { d ->
            d.listFiles()!!.filter { it.nameWithoutExtension == "ic_launcher" }
                .filter { d.name.startsWith("drawable") || d.name.contains("anydpi") || it.extension == "xml" }
        }
        assertTrue("ic_launcher shadowed by $shadows", shadows.isEmpty())
    }

    @Test fun bannerLivesInDensityDirsNotNodpi() {
        for (d in listOf("drawable", "drawable-hdpi", "drawable-xhdpi", "drawable-xxhdpi")) {
            val f = File(res, "$d/banner.png")
            assertTrue("missing ${f.path}", f.exists())
            val (w, h) = pngSize(f)
            assertEquals("${f.path} must be 16:9", w * 9, h * 16)
        }
        assertFalse(File(res, "drawable-nodpi/banner.png").exists())
    }
}
