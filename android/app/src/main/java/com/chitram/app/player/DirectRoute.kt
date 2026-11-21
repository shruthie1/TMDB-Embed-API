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
    const val FIRST_FRAME_MS = 10_000L

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

    /** Retry the same row via proxy: only a direct play that never reached a frame. */
    fun shouldFallBack(s: Source?, framed: Boolean): Boolean = isDirect(s) && !framed

    /**
     * The 10 s no-first-frame check. [playing] is `current` now, which recordAudio
     * may have replaced with a copy, so the row is matched by [key], not identity.
     */
    fun timerShouldFallBack(playing: Source?, started: Source, framedThisPlay: Boolean): Boolean =
        playing != null && key(playing) == key(started) && isDirect(playing) && !framedThisPlay

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
