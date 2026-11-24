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
 * A VM row of a provider the device can also resolve (CastleTV, MultiMovies,
 * showsst, OneTouchTV, Vidrift, Insertunit, VIDOUT)
 * is re-resolved on the device once, at the same position (DEVICE), before a
 * VM refresh: the VM may be the thing that failed (cooperative-APK plan).
 */
object FailPolicy {
    enum class Action { REFRESH, RERESOLVE, FAILOVER, WAIT_ONLINE, DEVICE }

    /** Providers with an on-device resolver for VM rows (OnDeviceResolver.CASTLE, MULTIMOVIES, SHOWSST, ONETOUCH, VIDRIFT, INSERTUNIT, VIDOUT). */
    private val DEVICE_TWINS = setOf("castletv", "multimovies", "showsst", "onetouchtv", "vidrift", "insertunit", "vidout")

    /** A CDN timeout cannot be repaired by attaching the identical NetMirror URL again. */
    fun unchangedNetmirrorRetry(previous: Source, fresh: Source): Boolean {
        // A row playing direct is compared in its proxied form (DirectRoute).
        val prev = DirectRoute.proxyOf(previous)
        return prev.provider.equals("netmirror", true) && fresh.provider.equals("netmirror", true) &&
            prev.url == fresh.url && prev.headers == fresh.headers && prev.segmentToken == fresh.segmentToken
    }

    /**
     * multimovies-slow-rca.md fix 3: a mapple re-resolve that returned the very
     * row whose proxy host just failed (same url, headers, token) is not played
     * again; the next server is tried instead.
     */
    fun unchangedProxiedRetry(previous: Source, fresh: Source): Boolean =
        previous.provider.equals("mapple", true) && fresh.provider.equals("mapple", true) &&
            previous.url == fresh.url && previous.headers == fresh.headers && previous.segmentToken == fresh.segmentToken

    fun hasDeviceTwin(provider: String?): Boolean = provider?.lowercase() in DEVICE_TWINS

    /**
     * `serverReplied`: the error carries an HTTP response (ERROR_CODE_IO_BAD_HTTP_STATUS,
     * InvalidResponseCodeException). A reply proves the network works, so it is
     * the source's failure, never WAIT_ONLINE, whatever the offline reading says.
     */
    /**
     * `rowDelivered`: this play got playlists or segments through the VM. For
     * MultiMovies the VM was then not the failure, and the device path fetches
     * the same origin directly, which the phone may not reach at all
     * (multimovies-slow-rca.md fix 2: 11 s lost on 1423253). Skip DEVICE.
     */
    fun onError(source: Source?, httpCode: Int?, refreshedOnce: Boolean, deviceRetried: Boolean = false, offline: Boolean = false, twinTried: Boolean = false, languageSelection: Boolean = false, serverReplied: Boolean = httpCode != null, rowDelivered: Boolean = false): Action = when {
        offline && !serverReplied -> Action.WAIT_ONLINE
        source?.onDevice != null -> if (deviceRetried) Action.FAILOVER else Action.RERESOLVE
        hasDeviceTwin(source?.provider) && !twinTried && !(rowDelivered && source?.provider.equals("multimovies", true)) -> Action.DEVICE
        languageSelection -> Action.FAILOVER
        (httpCode == 403 || httpCode == 410) && !refreshedOnce -> Action.REFRESH
        else -> Action.FAILOVER
    }

    enum class ResolveMiss { GO_OFFLINE, FAIL_OVER }

    /** A device re-resolve that found nothing: offline, wait for the network instead of burning the list. */
    fun onResolveMiss(offline: Boolean): ResolveMiss = if (offline) ResolveMiss.GO_OFFLINE else ResolveMiss.FAIL_OVER

    /**
     * Does the network coming back restart playback? `phase`: "playing", "failed" or other.
     * Playing resumes (prepare + play); "Every source failed" reached while
     * offline re-resolves from the saved position. A failure reached online stays.
     */
    fun backOnlineRetries(phase: String, failedWhileOffline: Boolean): Boolean = when (phase) {
        "playing" -> true
        "failed" -> failedWhileOffline
        else -> false
    }
}
