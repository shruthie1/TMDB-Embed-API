package com.chitram.app.player

import com.chitram.app.data.Source

/**
 * APK direct-vs-proxy decision for one backend row (owner rule 2026-11-21:
 * proxy only when required; the server's provider config says when).
 *
 * A row the config marks apk-direct carries `directUrl` + `directHeaders`. It
 * plays from the upstream with those headers (StreamInterceptor on the
 * OkHttp data source). If it fails before the first frame, the SAME row is
 * retried once through its proxied `url` before FailPolicy runs (refresh,
 * device twin, failover). A row that failed direct stays on the proxy for the
 * rest of the session.
 */
object DirectRoute {
    /** Longest a direct play may go without a first frame, as before. */
    const val FIRST_FRAME_MS = 10_000L
    /**
     * A direct play with no media segment finished by now goes to the proxy at
     * once. Measured 2026-11-22 (phone + emulator, 11 direct starts that framed):
     * first segment done 1.6-5.7 s after play for 9 of them, 7.4 and 8.0 s for the
     * other two; proxied rows 1.9-3.3 s. Krack direct (img.rousav.tech): no segment
     * by 8.8 s, frame only after the 10 s fallback. 4 s would have sent 6 of the 11
     * good direct starts to the proxy.
     */
    const val FIRST_SEGMENT_MS = 6_000L

    /**
     * The no-frame check at [elapsedMs] after play: the reason to fall back to the
     * proxy, or null to keep waiting. No segment by [FIRST_SEGMENT_MS] and no byte
     * for [idleMs] >= [FIRST_SEGMENT_MS] (gap 6.3): fall back; no frame by
     * [FIRST_FRAME_MS]: fall back, as before.
     */
    fun stallReason(elapsedMs: Long, framed: Boolean, segmentLoaded: Boolean, idleMs: Long = elapsedMs): String? = when {
        framed -> null
        elapsedMs >= FIRST_FRAME_MS -> "no-first-frame-10s"
        // Gap 6.3: slow 2G still sending the first segment is not a stall; only a 6 s byte silence is.
        elapsedMs >= FIRST_SEGMENT_MS && !segmentLoaded && idleMs >= FIRST_SEGMENT_MS -> "no-first-segment-6s"
        else -> null
    }

    /** Identity of a row across its direct and proxied forms. */
    fun key(s: Source): String = "${s.id}|${s.directUrl.orEmpty()}"

    fun isDirect(s: Source?): Boolean = s?.proxyUrl != null

    /** The form to play: direct when allowed and not failed before, else [s] unchanged. */
    fun forPlay(s: Source, directFailed: Set<String>): Source {
        val d = s.directUrl
        if (d.isNullOrEmpty() || s.onDevice != null || s.proxyUrl != null || key(s) in directFailed) return s
        return s.copy(url = d, headers = s.directHeaders, proxyUrl = s.url)
    }

    /** The proxied form of a row playing direct; [s] itself when it is not. */
    fun proxyOf(s: Source): Source {
        val p = s.proxyUrl ?: return s
        return s.copy(url = p, headers = emptyMap(), proxyUrl = null)
    }

    /**
     * Retry the same row via proxy: only a direct play that never reached a frame,
     * and only while the VM (the proxy) is up (gap 6.4); else the normal failover.
     */
    fun shouldFallBack(s: Source?, framed: Boolean, vmUp: Boolean = true): Boolean = isDirect(s) && !framed && vmUp

    /**
     * The no-first-frame check ([stallReason]). [playing] is `current` now, which recordAudio
     * may have replaced with a copy, so the row is matched by [key], not identity.
     */
    fun timerShouldFallBack(playing: Source?, started: Source, framedThisPlay: Boolean, vmUp: Boolean = true): Boolean =
        playing != null && key(playing) == key(started) && isDirect(playing) && !framedThisPlay && vmUp

    /**
     * On-device merge (re-review m-B): the failed request went to the donor's
     * host, not the picture's, so the donor is at fault and pairFailed should run
     * before any proxy retry of the picture. Unknown or shared host: false.
     */
    fun donorAtFault(failedUri: String?, playing: Source?, donor: Source?): Boolean {
        if (failedUri == null || playing == null || donor == null) return false
        val h = host(failedUri)
        if (h == "?" || h == host(playing.url)) return false
        // The donor plays from its pairAudio url only, never its directUrl (m-C).
        return h == host(donor.url)
    }

    fun host(url: String?): String = runCatching { java.net.URI(url).host }.getOrNull() ?: "?"

    /** One greppable line per decision: `[route] apk <event> provider=.. host=..`. */
    fun logLine(event: String, s: Source, extra: String = ""): String =
        "[route] apk $event provider=${s.provider} host=${host(s.directUrl ?: s.url)}" + if (extra.isEmpty()) "" else " $extra"
}
