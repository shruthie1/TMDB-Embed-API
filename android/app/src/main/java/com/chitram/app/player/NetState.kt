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
    /**
     * The device has no usable network now (the player's offline banner, and gap
     * 13.10: no resolve or prewarm runs, no failure counts). Null manager or an
     * error reads online: never block work on a failed check.
     */
    fun offline(c: android.net.ConnectivityManager?): Boolean = try {
        if (c == null) false else {
            fun caps(n: android.net.Network?): NetCaps? = n?.let { c.getNetworkCapabilities(it) }?.let {
                NetCaps(
                    internet = it.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET),
                    vpn = it.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN),
                )
            }
            val active = caps(c.activeNetwork)
            // allNetworks is only needed for a VPN without INTERNET (API 21+; deprecated at 31, still works).
            @Suppress("DEPRECATION")
            val all = if (active?.vpn == true && !active.internet) c.allNetworks.mapNotNull { caps(it) } else emptyList()
            !online(active, all)
        }
    } catch (_: Exception) { false }

    /** Gap 3.8: the active network is metered (mobile data). Unknown reads unmetered. */
    fun metered(c: android.net.ConnectivityManager?): Boolean = try { c?.isActiveNetworkMetered == true } catch (_: Exception) { false }

    fun online(active: NetCaps?, all: List<NetCaps>): Boolean = when {
        active == null -> false
        active.internet -> true
        active.vpn -> all.any { !it.vpn && it.internet }
        else -> false
    }
}
