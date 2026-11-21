package com.chitram.app.player

/** One network's capabilities, as far as "is there internet" goes. */
data class NetCaps(val internet: Boolean, val vpn: Boolean)

/**
 * Is the active network usable? Pure so it is unit-testable.
 *
 * Android 7.x builds VPN capabilities without NET_CAPABILITY_INTERNET (8+ adds
 * it), so with RethinkDNS on a Fire TV the app read "offline" forever while
 * playback flowed through tun0 (tv-offline-rca.md, APK 1.2.36). A VPN without
 * INTERNET therefore counts as online only while some non-VPN network has
 * INTERNET: RethinkDNS keeps tun0 up when Wi-Fi drops, and that is a real outage.
 *
 * `active`: the app's active network (null = none). `all`: every network
 * (ConnectivityManager.allNetworks).
 */
object NetState {
    fun online(active: NetCaps?, all: List<NetCaps>): Boolean = when {
        active == null -> false
        active.internet -> true
        active.vpn -> all.any { !it.vpn && it.internet }
        else -> false
    }
}
