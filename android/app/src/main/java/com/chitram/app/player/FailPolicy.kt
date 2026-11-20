package com.chitram.app.player

import com.chitram.app.data.Source

/**
 * What a fatal playback error does (web/lib/player/fatalPolicy.js, plus on-device rows).
 * A backend row's 403/410 is a stale link: refresh from the backend once. An
 * on-device row is re-resolved on the device once (new mapple session, new
 * vaplayer token for the phone's CURRENT IP, which fixes a Wi-Fi to mobile
 * switch); if that also fails, move to the next source.
 *
 * With no network (U8, web Player.jsx offline banner) nothing is the source's
 * fault: wait for the connection instead of failing through every source.
 *
 * A VM row of a provider the device can also resolve (CastleTV, MultiMovies)
 * is re-resolved on the device once, at the same position (DEVICE), before a
 * VM refresh: the VM may be the thing that failed (cooperative-APK plan).
 */
object FailPolicy {
    enum class Action { REFRESH, RERESOLVE, FAILOVER, WAIT_ONLINE, DEVICE }

    /** Providers with an on-device resolver for VM rows (OnDeviceResolver.CASTLE, MULTIMOVIES). */
    private val DEVICE_TWINS = setOf("castletv", "multimovies")

    fun hasDeviceTwin(provider: String?): Boolean = provider?.lowercase() in DEVICE_TWINS

    fun onError(source: Source?, httpCode: Int?, refreshedOnce: Boolean, deviceRetried: Boolean = false, offline: Boolean = false, twinTried: Boolean = false): Action = when {
        offline -> Action.WAIT_ONLINE
        source?.onDevice != null -> if (deviceRetried) Action.FAILOVER else Action.RERESOLVE
        hasDeviceTwin(source?.provider) && !twinTried -> Action.DEVICE
        (httpCode == 403 || httpCode == 410) && !refreshedOnce -> Action.REFRESH
        else -> Action.FAILOVER
    }
}
