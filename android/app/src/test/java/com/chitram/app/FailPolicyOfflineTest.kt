package com.chitram.app

import com.chitram.app.player.FailPolicy
import com.chitram.app.player.FailPolicy.ResolveMiss
import com.chitram.app.player.NetCaps
import com.chitram.app.player.NetState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stream-down recovery (offline-stuck-rca.md, tv-offline-rca.md). */
class FailPolicyOfflineTest {
    @Test fun resolveMissOfflineGoesOffline() {
        assertEquals(ResolveMiss.GO_OFFLINE, FailPolicy.onResolveMiss(true))
        assertEquals(ResolveMiss.FAIL_OVER, FailPolicy.onResolveMiss(false))
    }

    @Test fun backOnlineRetriesAFailureReachedOffline() {
        assertTrue(FailPolicy.backOnlineRetries("failed", true))
        assertFalse(FailPolicy.backOnlineRetries("failed", false))
        assertTrue(FailPolicy.backOnlineRetries("playing", false))
    }

    // Fire TV 1.2.36: RethinkDNS on Android 7.1 exposes a VPN network without
    // NET_CAPABILITY_INTERNET; the app read that as offline forever. The VPN
    // counts as online only while a real (non-VPN) network has INTERNET:
    // RethinkDNS keeps tun0 up when Wi-Fi drops, and that is a real outage.
    private val vpnNoInternet = NetCaps(internet = false, vpn = true)
    private val wifi = NetCaps(internet = true, vpn = false)

    @Test fun vpnWithoutInternetOverWifiWithInternetIsOnline() {
        assertTrue(NetState.online(vpnNoInternet, listOf(vpnNoInternet, wifi)))
    }

    @Test fun vpnWithoutInternetAndNoOtherNetworkIsOffline() {
        assertFalse(NetState.online(vpnNoInternet, listOf(vpnNoInternet)))
    }

    @Test fun vpnWithoutInternetOverWifiWithoutInternetIsOffline() {
        assertFalse(NetState.online(vpnNoInternet, listOf(vpnNoInternet, NetCaps(internet = false, vpn = false))))
    }

    @Test fun vpnWithInternetIsOnline() {
        assertTrue(NetState.online(NetCaps(internet = true, vpn = true), listOf(NetCaps(internet = true, vpn = true))))
    }

    @Test fun noNetworkIsOffline() {
        assertFalse(NetState.online(null, emptyList()))
    }

    @Test fun wifiWithInternetIsOnline() {
        assertTrue(NetState.online(wifi, listOf(wifi)))
    }

    @Test fun networkWithNeitherInternetNorVpnIsOffline() {
        assertFalse(NetState.online(NetCaps(internet = false, vpn = false), listOf(wifi)))
    }

    // A server reply (ERROR_CODE_IO_BAD_HTTP_STATUS) proves the network works.
    @Test fun httpStatusErrorNeverWaitsOnline() {
        val a = FailPolicy.onError(null, 404, refreshedOnce = true, offline = true, twinTried = true)
        assertNotEquals(FailPolicy.Action.WAIT_ONLINE, a)
        assertEquals(FailPolicy.Action.FAILOVER, a)
    }

    @Test fun httpStatusWithoutCodeAlsoFailsOver() {
        val a = FailPolicy.onError(null, null, refreshedOnce = true, offline = true, twinTried = true, serverReplied = true)
        assertEquals(FailPolicy.Action.FAILOVER, a)
    }

    @Test fun connectionErrorOfflineStillWaits() {
        assertEquals(FailPolicy.Action.WAIT_ONLINE, FailPolicy.onError(null, null, refreshedOnce = false, offline = true))
    }
}
