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

/**
 * The sheet opens just above the control button that opened it, over a light
 * 0.2 scrim: phone landscape and TV (web .pmenu above its .pmenu-wrap button).
 * No known button (the loading screen) keeps the edge panel / centred sheet.
 */
internal fun menuAnchored(anchorKnown: Boolean, isTv: Boolean, width: Float, height: Float): Boolean =
    anchorKnown && (isTv || width > height)

/**
 * Bounds of the anchored TV sheet in dp. Web TV values at 1920x1080 CSS px,
 * 1 CSS px = 0.5dp on a 960x540dp Android TV screen:
 * .pmenu min-width clamp(380px,26vw,560px) = 499.2px -> 249.6dp;
 * .pmenu-pick max-height min(66vh,720px) = 712.8px -> 356.4dp;
 * overscan margin --tvbar-safe-x 5% of the width.
 */
internal data class TvAnchoredMenu(val minWidth: Float, val maxWidth: Float, val maxHeight: Float, val margin: Float)

internal fun tvAnchoredMenu(width: Float, height: Float): TvAnchoredMenu {
    require(width > 0 && height > 0)
    val margin = width * 0.05f
    val maxWidth = (width - margin * 2).coerceAtLeast(1f)
    val minWidth = minOf(249.6f, maxWidth)
    return TvAnchoredMenu(minWidth, maxOf(minWidth, minOf(width * 0.5f, maxWidth)), minOf(356.4f, height - margin * 2).coerceAtLeast(1f), margin)
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
