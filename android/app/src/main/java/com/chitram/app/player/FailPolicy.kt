package com.chitram.app.player

import com.chitram.app.data.Source

/**
 * What a fatal playback error does (web/lib/player/fatalPolicy.js, plus on-device rows).
 * A backend row's 403/410 is a stale link: refresh from the backend once. An
 * on-device row cannot be refreshed by the backend, and for vaplayer a 403 means
 * the host token is bound to another /24 (CGNAT): move to the next source.
 */
object FailPolicy {
    enum class Action { REFRESH, FAILOVER }

    fun onError(source: Source?, httpCode: Int?, refreshedOnce: Boolean): Action = when {
        source?.onDevice != null -> Action.FAILOVER
        (httpCode == 403 || httpCode == 410) && !refreshedOnce -> Action.REFRESH
        else -> Action.FAILOVER
    }
}
