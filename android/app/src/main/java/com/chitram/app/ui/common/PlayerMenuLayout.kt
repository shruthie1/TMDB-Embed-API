package com.chitram.app.ui.common

/** Modal bounds in dp. Phone playback is landscape, so it needs its own visible design. */
internal data class PlayerMenuLayout(val width: Float, val height: Float, val inset: Float, val bottomSheet: Boolean)

internal fun playerMenuLayout(width: Float, height: Float, isTv: Boolean): PlayerMenuLayout {
    require(width > 0 && height > 0)
    if (isTv) return PlayerMenuLayout(minOf(420f, width), height, 0f, false)
    if (height > width) return PlayerMenuLayout(width, height * 0.7f, 0f, true)
    val inset = minOf(16f, height / 16f)
    return PlayerMenuLayout(minOf(340f, width * 0.45f, width - inset * 2), minOf(480f, height - inset * 2), inset, false)
}

internal enum class MenuTap { Drill, Check, Close, Choose }

/** A tap on a sheet row. Re-tapping the selected row only closes the sheet (A2); dim rows stay tappable. */
internal fun menuTap(item: com.chitram.app.player.MenuItem?): MenuTap = when {
    item == null -> MenuTap.Choose
    item.key.startsWith("group:") -> MenuTap.Drill
    item.key == "check:netmirror" -> MenuTap.Check
    item.selected -> MenuTap.Close
    else -> MenuTap.Choose
}
