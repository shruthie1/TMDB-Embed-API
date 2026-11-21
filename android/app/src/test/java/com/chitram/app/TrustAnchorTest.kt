package com.chitram.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * 1.2.18: image.tmdb.org chains to ISRG Root X1. The bundled anchor must be the
 * real X1 and the manifest must point at the config that adds it, or every
 * poster and backdrop stays blank on trust stores without X1 (Fire OS).
 */
class TrustAnchorTest {
    private fun file(rel: String) = listOf(File(rel), File("app/$rel")).first { it.exists() }

    @Test fun bundledAnchorIsIsrgRootX1() {
        val cert = file("src/main/res/raw/isrg_root_x1.pem").inputStream().use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        val sha = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
        assertEquals("96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6", sha)
    }

    @Test fun manifestUsesConfigThatKeepsSystemRootsAndNoCleartext() {
        assertTrue(file("src/main/AndroidManifest.xml").readText().contains("android:networkSecurityConfig=\"@xml/network_security_config\""))
        val cfg = file("src/main/res/xml/network_security_config.xml").readText()
        assertTrue(cfg.contains("<certificates src=\"system\" />"))
        assertTrue(cfg.contains("<certificates src=\"@raw/isrg_root_x1\" />"))
        assertTrue(cfg.contains("cleartextTrafficPermitted=\"false\""))
    }
}
