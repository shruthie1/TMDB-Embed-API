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

internal enum class MenuTap { Drill, Check, Close, Choose, Fit }

/** A tap on a sheet row. Re-tapping the selected row only closes the sheet (A2); dim rows stay tappable. */
internal fun menuTap(item: com.chitram.app.player.MenuItem?): MenuTap = when {
    item == null -> MenuTap.Choose
    item.key.startsWith("group:") -> MenuTap.Drill
    item.key == "check:netmirror" -> MenuTap.Check
    item.selected -> MenuTap.Close
    item.key.startsWith(FIT_KEY) -> MenuTap.Fit
    else -> MenuTap.Choose
}

internal const val FIT_KEY = "fit:"

/** TV Quality sheet: a "Picture" section, one row per fit, the current one checked. */
internal fun fitItems(current: com.chitram.app.data.VideoFit): List<com.chitram.app.player.MenuItem> =
    com.chitram.app.data.VideoFit.entries.map { f ->
        com.chitram.app.player.MenuItem(FIT_KEY + f.name, f.label, fitDetail(f), selected = f == current, group = "Picture")
    }

private fun fitDetail(f: com.chitram.app.data.VideoFit) = when (f) {
    com.chitram.app.data.VideoFit.Fit -> "Whole picture"
    com.chitram.app.data.VideoFit.Fill -> "Fill screen, crop edges"
    com.chitram.app.data.VideoFit.FitWidth -> "Full width, crop top and bottom"
    com.chitram.app.data.VideoFit.Stretch -> "Fill screen, ignore shape"
}

/**
 * Surface size for [fit] in a [w] x [h] box, video aspect [ratio] (width / height).
 * Same rules as media3 AspectRatioFrameLayout; the box clips any overflow.
 */
internal fun fitSize(fit: com.chitram.app.data.VideoFit, w: Float, h: Float, ratio: Float): Pair<Float, Float> = when (fit) {
    com.chitram.app.data.VideoFit.Fit -> if (w / h > ratio) h * ratio to h else w to w / ratio
    com.chitram.app.data.VideoFit.Fill -> if (w / h > ratio) w to w / ratio else h * ratio to h
    com.chitram.app.data.VideoFit.FitWidth -> w to w / ratio
    com.chitram.app.data.VideoFit.Stretch -> w to h
}
