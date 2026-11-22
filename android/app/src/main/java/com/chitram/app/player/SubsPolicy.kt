package com.chitram.app.player

import com.chitram.app.data.PlayerPrefs

/**
 * Subtitles on or off, client-wide (owner 2026-11-22).
 *
 * The viewer's last explicit choice in any player (phone or TV) holds for every
 * later start: new title, next episode, provider switch, refresh, resume and
 * cast return all go through PlayerVm.play(), which asks [start] once.
 *  - never chosen (fresh client): text off, as before.
 *  - off: text off; nothing turns it on until the viewer picks a track.
 *  - on: text on and the first track (OpenSubs order) is flagged default.
 * Not tied to a title.
 */
object SubsPolicy {
    data class Start(val textDisabled: Boolean, val defaultIndex: Int?, val blockedByViewer: Boolean)

    fun start(subsOn: Boolean?, tracks: Int): Start = when (subsOn) {
        true -> Start(textDisabled = false, defaultIndex = if (tracks > 0) 0 else null, blockedByViewer = false)
        false -> Start(textDisabled = true, defaultIndex = null, blockedByViewer = true)
        null -> Start(textDisabled = true, defaultIndex = null, blockedByViewer = false)
    }

    /** An explicit pick in the player's subtitle menu. */
    fun picked(prefs: PlayerPrefs, on: Boolean) { prefs.subsOn = on }

    fun logLine(title: String): String = "[subs] off by viewer, skipped auto $title"
}
